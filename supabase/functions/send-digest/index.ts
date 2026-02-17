// supabase/functions/send-digest/index.ts
// Supabase Edge Function: sends a job digest email via Resend.
//
// Can be invoked:
//   1. From the frontend ("Send Test Digest" button)
//   2. Via a Supabase cron/pg_cron scheduled job for daily automation
//
// Required Supabase secrets:
//   RESEND_API_KEY  – your Resend API key
//   RESEND_FROM     – verified sender address (e.g. "JobScout <digest@yourdomain.com>")

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

// Allowed origins for CORS – production, www, and Vercel previews.
const ALLOWED_ORIGINS = [
  'https://mycareerbrain.de',
  'https://www.mycareerbrain.de',
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  // Allow listed origins and any *.vercel.app preview deployments
  const allowed =
    ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'JobScout AI <onboarding@resend.dev>';

    if (!RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'RESEND_API_KEY not configured. Set it via: supabase secrets set RESEND_API_KEY=re_...' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Authenticate the calling user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Single admin client – uses auto-injected SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse optional body params
    const body = await req.json().catch(() => ({}));

    // Identify the caller: service-role key (cron) or user JWT (frontend)
    const token = authHeader.replace('Bearer ', '');
    let userId: string;
    let userEmail: string | undefined;

    if (token === supabaseServiceKey) {
      // Called with service role key (cron job or Dashboard test)
      if (!body.user_id) {
        return new Response(
          JSON.stringify({ error: 'When using service_role key, provide user_id in the request body' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      userId = body.user_id;
      userEmail = body.email;
    } else {
      // Called with a user JWT (frontend).
      // The Supabase API gateway already validated the token, so we can
      // trust the payload and decode it directly instead of calling
      // auth.getUser() which can fail with service-role clients.
      try {
        const payloadB64 = token.split('.')[1];
        const payload = JSON.parse(atob(payloadB64));
        userId = payload.sub;
        userEmail = payload.email;
        console.log('User ID from token:', userId);
      } catch (decodeError: any) {
        console.log(`JWT decode error: ${decodeError.message}`);
        return new Response(
          JSON.stringify({ error: 'Unauthorized: could not decode token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!userId) {
        console.log('JWT payload missing sub claim');
        return new Response(
          JSON.stringify({ error: 'Unauthorized: token has no user ID' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Load user settings (may not exist yet for new users)
    const { data: settings, error: settingsError } = await supabase
      .from('user_settings')
      .select('digest_email, match_threshold')
      .eq('user_id', userId)
      .single();

    if (settingsError) {
      console.log(`user_settings lookup: ${settingsError.message} (user_id: ${userId})`);
    }

    // Determine recipient: body param > saved setting > auth email
    const recipientEmail = body.email || settings?.digest_email || userEmail;
    if (!recipientEmail) {
      return new Response(
        JSON.stringify({ error: 'No digest email configured. Pass "email" in the request body or set one in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const effectiveThreshold = body.threshold ?? settings?.match_threshold ?? 80;

    // Load recent job matches above the threshold
    const { data: matches, error: matchError } = await supabase
      .from('job_matches')
      .select('*')
      .eq('user_id', userId)
      .gte('score', effectiveThreshold)
      .neq('status', 'dismissed')
      .order('score', { ascending: false })
      .limit(20);

    if (matchError) {
      return new Response(
        JSON.stringify({ error: 'Failed to load matches', details: matchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!matches || matches.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No matches above threshold — no email sent', threshold: effectiveThreshold }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build the email HTML
    const jobRows = matches
      .map(
        (m: any) => `
        <tr>
          <td style="padding:12px 16px; border-bottom:1px solid #f1f5f9;">
            <div style="font-weight:700; color:#0f172a; font-size:15px;">${escapeHtml(m.title)}</div>
            <div style="color:#64748b; font-size:13px; margin-top:2px;">${escapeHtml(m.company)} · ${escapeHtml(m.location || 'N/A')}</div>
            <div style="margin-top:4px;">
              <span style="display:inline-block; background:#eef2ff; color:#4f46e5; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:700;">${m.score}% match</span>
              ${m.source ? `<span style="display:inline-block; background:#f0fdf4; color:#16a34a; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:600; margin-left:4px;">${escapeHtml(m.source)}</span>` : ''}
            </div>
          </td>
          <td style="padding:12px 16px; border-bottom:1px solid #f1f5f9; text-align:right; vertical-align:middle;">
            <a href="${escapeHtml(m.link || '#')}" style="display:inline-block; background:#4f46e5; color:white; padding:8px 16px; border-radius:12px; font-size:13px; font-weight:700; text-decoration:none;">View</a>
          </td>
        </tr>`
      )
      .join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f8fafc; margin:0; padding:32px 16px;">
  <div style="max-width:600px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:32px 28px; text-align:center;">
      <h1 style="color:white; margin:0; font-size:22px; font-weight:800;">Your Daily Job Digest</h1>
      <p style="color:rgba(255,255,255,0.8); margin:8px 0 0; font-size:14px;">${matches.length} match${matches.length > 1 ? 'es' : ''} scoring ${effectiveThreshold}%+</p>
    </div>
    <div style="padding:8px 0;">
      <table style="width:100%; border-collapse:collapse;">
        ${jobRows}
      </table>
    </div>
    <div style="padding:20px 28px; text-align:center; border-top:1px solid #f1f5f9;">
      <p style="color:#94a3b8; font-size:12px; margin:0;">Sent by JobScout AI · <a href="#" style="color:#4f46e5; text-decoration:none;">Manage preferences</a></p>
    </div>
  </div>
</body>
</html>`;

    // Send via Resend API
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [recipientEmail],
        subject: `JobScout Digest: ${matches.length} new match${matches.length > 1 ? 'es' : ''} (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
        html,
      }),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      console.log(`Resend API error: ${JSON.stringify(resendData)}`);
      return new Response(
        JSON.stringify({ error: 'Resend API error', details: resendData }),
        { status: resendRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        emailId: resendData.id,
        sentTo: recipientEmail,
        matchCount: matches.length,
        threshold: effectiveThreshold,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.log(`Unhandled error in send-digest: ${err.message}`);
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
