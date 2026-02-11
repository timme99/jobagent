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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

serve(async (req: Request) => {
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse optional body params
    const body = await req.json().catch(() => ({}));
    const threshold = body.threshold ?? 80;

    // Decode the JWT to get user_id.
    // If the caller passes a service_role key (e.g. cron or Dashboard test)
    // and includes a user_id in the body, use that instead.
    let userId: string;
    let userEmail: string | undefined;

    const token = authHeader.replace('Bearer ', '');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Check for service role key in Authorization header or x-admin-key header
    // (Dashboard testing may override Authorization, so x-admin-key is a fallback)
    const adminKey = req.headers.get('x-admin-key');
    const isServiceRole = token === serviceRoleKey || adminKey === serviceRoleKey;

    if (isServiceRole) {
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
      // Called with a user JWT (frontend)
      const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
      if (userError || !user) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized – invalid user JWT', details: userError?.message }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      userId = user.id;
      userEmail = user.email;
    }

    // Load user settings
    const { data: settings } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single();

    const recipientEmail = body.email || settings?.digest_email || userEmail;
    if (!recipientEmail) {
      return new Response(
        JSON.stringify({ error: 'No digest email configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const effectiveThreshold = body.threshold ?? settings?.match_threshold ?? threshold;

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
