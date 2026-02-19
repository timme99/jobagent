// supabase/functions/send-digest/index.ts
// Supabase Edge Function: sends a job digest email via Resend.
//
// Invocation modes:
//   1. User JWT (frontend "Send Test Digest" button)
//   2. Service role key + user_id body  → targets a specific user
//   3. Service role key, no user_id     → pg_cron broadcast to all automation-enabled users
//   4. Any of the above + {"check":true} → diagnostic mode, returns summary without sending
//
// Required Supabase secrets:
//   RESEND_API_KEY  – your Resend API key
//   RESEND_FROM     – verified sender address (e.g. "JobScout <digest@yourdomain.com>")

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'JobScout AI <onboarding@resend.dev>';

    if (!RESEND_API_KEY) {
      return jsonRes(500, {
        error: 'RESEND_API_KEY not configured. Set it via: supabase secrets set RESEND_API_KEY=re_...',
      });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonRes(401, { error: 'Missing Authorization header' });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    // Always use the service-role client for DB queries so RLS is bypassed
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    const isDiagnostic = body.check === true;

    const token = authHeader.replace('Bearer ', '');

    // ── Service-role path (cron job or dashboard test) ───────────────────────
    if (token === serviceRoleKey) {
      if (!body.user_id) {
        // pg_cron broadcast mode: send digests to ALL automation-enabled users
        console.log('Function started by: service_role (cron broadcast)');
        const results = await processAllUsers(supabase, RESEND_API_KEY, RESEND_FROM, isDiagnostic);
        return jsonRes(200, { processed: results.length, results });
      }

      // Service role with an explicit user_id (dashboard test for specific user)
      console.log(`Function started by: ${body.user_id}`);
      const result = await sendDigestForUser(
        supabase, body.user_id, body.email, body, RESEND_API_KEY, RESEND_FROM, isDiagnostic,
      );
      return jsonRes(result.status, result.data);
    }

    // ── User JWT path (frontend) ─────────────────────────────────────────────
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonRes(401, { error: 'Unauthorized' });
    }

    console.log(`Function started by: ${user.id}`);
    const result = await sendDigestForUser(
      supabase, user.id, user.email, body, RESEND_API_KEY, RESEND_FROM, isDiagnostic,
    );
    return jsonRes(result.status, result.data);

  } catch (err: any) {
    return jsonRes(500, { error: err.message || 'Internal server error' });
  }
});

// ── Broadcast: iterate every automation-enabled user ────────────────────────
async function processAllUsers(
  supabase: ReturnType<typeof createClient>,
  resendApiKey: string,
  resendFrom: string,
  isDiagnostic: boolean,
) {
  const { data: allSettings } = await supabase
    .from('user_settings')
    .select('user_id, digest_email, match_threshold, last_digest_sent_at')
    .eq('automation_enabled', true)
    .not('digest_email', 'is', null);

  const results: Record<string, unknown>[] = [];
  for (const s of allSettings ?? []) {
    console.log(`Function started by: ${s.user_id}`);
    const result = await sendDigestForUser(
      supabase, s.user_id, s.digest_email, {}, resendApiKey, resendFrom, isDiagnostic, s,
    );
    results.push({
      userId: s.user_id,
      status: result.status,
      ...(result.data as Record<string, unknown>),
    });
  }
  return results;
}

// ── Core digest logic for a single user ─────────────────────────────────────
async function sendDigestForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  userEmail: string | undefined,
  body: Record<string, any>,
  resendApiKey: string,
  resendFrom: string,
  isDiagnostic: boolean,
  preloadedSettings?: Record<string, any>,
): Promise<{ status: number; data: unknown }> {

  // Load settings (re-use the row already fetched in broadcast mode)
  let settings = preloadedSettings;
  if (!settings) {
    const { data } = await supabase
      .from('user_settings')
      .select('digest_email, match_threshold, last_digest_sent_at')
      .eq('user_id', userId)
      .single();
    settings = data ?? {};
  }

  const recipientEmail: string = body.email || settings.digest_email || userEmail;
  if (!recipientEmail) {
    return { status: 400, data: { error: 'No digest email configured' } };
  }

  const effectiveThreshold: number = body.threshold ?? settings.match_threshold ?? 80;

  // Determine the time window.
  // If last_digest_sent_at is empty (new user / first run), fall back to the last 24 hours
  // so the very first email always has something to send.
  const lastSent: string | null = settings.last_digest_sent_at ?? null;
  const since = lastSent
    ? new Date(lastSent).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Fetch matches inside the time window
  const { data: matches, error: matchError } = await supabase
    .from('job_matches')
    .select('*')
    .eq('user_id', userId)
    .gte('score', effectiveThreshold)
    .neq('status', 'dismissed')
    .gte('created_at', since)
    .order('score', { ascending: false })
    .limit(20);

  if (matchError) {
    return { status: 500, data: { error: 'Failed to load matches', details: matchError.message } };
  }

  console.log(`Jobs found in last 24h: ${matches?.length ?? 0}`);

  if (!matches || matches.length === 0) {
    return {
      status: 200,
      data: { message: 'No matches above threshold — no email sent', threshold: effectiveThreshold },
    };
  }

  // ── Diagnostic mode: summarise without sending ──────────────────────────
  if (isDiagnostic) {
    return {
      status: 200,
      data: {
        diagnostic: true,
        wouldSendTo: recipientEmail,
        matchCount: matches.length,
        threshold: effectiveThreshold,
        since,
        matches: matches.map((m: any) => ({
          id: m.id,
          title: m.title,
          company: m.company,
          score: m.score,
        })),
      },
    };
  }

  // ── Build email HTML ─────────────────────────────────────────────────────
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
      </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
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

  // ── Send via Resend ──────────────────────────────────────────────────────
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resendFrom,
      to: [recipientEmail],
      subject: `JobScout Digest: ${matches.length} new match${matches.length > 1 ? 'es' : ''} (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
      html,
    }),
  });

  const resendData = await resendRes.json();
  console.log(`Resend API Status: ${JSON.stringify(resendData)}`);

  if (!resendRes.ok) {
    return { status: resendRes.status, data: { error: 'Resend API error', details: resendData } };
  }

  // Stamp the send time so the next run only picks up matches created after this point
  await supabase
    .from('user_settings')
    .update({ last_digest_sent_at: new Date().toISOString() })
    .eq('user_id', userId);

  return {
    status: 200,
    data: {
      success: true,
      emailId: resendData.id,
      sentTo: recipientEmail,
      matchCount: matches.length,
      threshold: effectiveThreshold,
    },
  };
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
