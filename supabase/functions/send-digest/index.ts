// supabase/functions/send-digest/index.ts
// Supabase Edge Function: sends a job digest email via Resend.
//
// Invocation modes:
//   1. User JWT (frontend "Send Test Digest" button) — body.test:true skips time filter
//   2. Service role key + user_id body  → targets a specific user
//   3. Service role key, no user_id     → pg_cron broadcast to all automation-enabled users
//   4. Any of the above + {"check":true} → diagnostic mode, returns summary without sending
//
// Required Supabase secrets:
//   RESEND_API_KEY  – your Resend API key
//   RESEND_FROM     – verified sender address (e.g. "MyCareerBrain <digest@yourdomain.com>")

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
    const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'MyCareerBrain <onboarding@resend.dev>';

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

    // ── Service-role path (cron job or server-side call) ─────────────────────
    if (token === serviceRoleKey) {
      if (!body.user_id) {
        // pg_cron broadcast mode: send digests to ALL automation-enabled users
        console.log('Function started by: service_role (cron broadcast)');
        const results = await processAllUsers(supabase, RESEND_API_KEY, RESEND_FROM, isDiagnostic);
        return jsonRes(200, { processed: results.length, results });
      }

      // Service role with an explicit user_id
      console.log(`Function started by: service_role for user ${body.user_id}`);
      const isTest = body.test === true;
      const result = await sendDigestForUser(
        supabase, body.user_id, body.email, body, RESEND_API_KEY, RESEND_FROM, isDiagnostic, undefined, isTest,
      );
      return jsonRes(result.status, result.data);
    }

    // ── User JWT path (frontend "Send Test Digest" button) ───────────────────
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonRes(401, { error: 'Unauthorized' });
    }

    console.log(`Function started by: ${user.id} (user JWT — test mode)`);

    // Frontend calls are always treated as test: time filter is skipped so you
    // see ALL matches above threshold regardless of when they were scanned.
    const isTest = true;
    const result = await sendDigestForUser(
      supabase, user.id, user.email, body, RESEND_API_KEY, RESEND_FROM, isDiagnostic, undefined, isTest,
    );
    return jsonRes(result.status, result.data);

  } catch (err: any) {
    console.error('Unhandled error:', err);
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
  const { data: allSettings, error: settingsError } = await supabase
    .from('user_settings')
    .select('user_id, digest_email, match_threshold, last_digest_sent_at, timezone, display_name')
    .eq('automation_enabled', true)
    .not('digest_email', 'is', null);

  if (settingsError) {
    console.error('Failed to load user settings:', settingsError.message);
    return [{ error: 'Failed to load user settings', details: settingsError.message }];
  }

  console.log(`Broadcast: found ${allSettings?.length ?? 0} automation-enabled user(s)`);

  const now = new Date();
  const results: Record<string, unknown>[] = [];

  for (const s of allSettings ?? []) {
    const tz = s.timezone || 'UTC';

    // Only send if it is currently 8:00 AM in the user's local timezone
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const currentHour = parseInt(
      (parts.find((p: Intl.DateTimeFormatPart) => p.type === 'hour') ?? { value: '0' }).value,
      10,
    );

    if (currentHour !== 8) {
      console.log(`Skipping user ${s.user_id}: hour in ${tz} is ${currentHour}, not 8`);
      results.push({
        userId: s.user_id,
        skipped: true,
        reason: `Not 8 AM in ${tz} (currently ${currentHour}:xx)`,
      });
      continue;
    }

    console.log(`Processing digest for user ${s.user_id} (8 AM in ${tz})`);
    const result = await sendDigestForUser(
      supabase, s.user_id, s.digest_email, {}, resendApiKey, resendFrom, isDiagnostic, s, false,
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
  // isTest=true → skip created_at time filter (used by the frontend test button)
  isTest = false,
): Promise<{ status: number; data: unknown }> {

  // Load settings (re-use the row already fetched in broadcast mode)
  let settings = preloadedSettings;
  if (!settings) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('digest_email, match_threshold, last_digest_sent_at, display_name')
      .eq('user_id', userId)
      .single();
    if (error) {
      console.error(`Failed to load settings for user ${userId}:`, error.message);
    }
    settings = data ?? {};
  }

  const recipientEmail: string = body.email || settings.digest_email || userEmail || '';
  if (!recipientEmail) {
    return { status: 400, data: { error: 'No digest email configured' } };
  }

  const effectiveThreshold: number = body.threshold ?? settings.match_threshold ?? 80;

  // ── Build the query ──────────────────────────────────────────────────────
  // isTest = true  → load ALL non-dismissed matches above threshold (no time filter)
  // isTest = false → only matches created since the last digest (24h fallback for new users)
  let query = supabase
    .from('job_matches')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'dismissed')
    .order('score', { ascending: false })
    .limit(20);

  if (!isTest) {
    const lastSent: string | null = settings.last_digest_sent_at ?? null;
    const since = lastSent
      ? new Date(lastSent).toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    console.log(`Time filter active: fetching matches created after ${since}`);
    query = query.gte('created_at', since);
  } else {
    console.log('Time filter SKIPPED (test mode) — fetching all matches regardless of age');
  }

  const { data: allMatches, error: matchError } = await query;

  if (matchError) {
    return { status: 500, data: { error: 'Failed to load matches', details: matchError.message } };
  }

  // Apply threshold filter in JS so we can log the comparison clearly
  const totalFound = allMatches?.length ?? 0;
  const highestScore = allMatches && allMatches.length > 0
    ? Math.max(...allMatches.map((m: any) => m.score))
    : 0;

  const matches = (allMatches ?? []).filter((m: any) => m.score >= effectiveThreshold);

  console.log(`[DEBUG] User Threshold: ${effectiveThreshold} | Jobs fetched: ${totalFound} | Highest Match Score found: ${highestScore} | Matches above threshold: ${matches.length}`);

  // ── Diagnostic mode: summarise without sending ──────────────────────────
  if (isDiagnostic) {
    return {
      status: 200,
      data: {
        diagnostic: true,
        isTest,
        wouldSendTo: recipientEmail,
        threshold: effectiveThreshold,
        totalFetched: totalFound,
        highestScore,
        matchCount: matches.length,
        matches: matches.map((m: any) => ({
          id: m.id,
          title: m.title,
          company: m.company,
          score: m.score,
          created_at: m.created_at,
        })),
      },
    };
  }

  const displayName: string = settings.display_name || '';
  const greeting = displayName ? `Good morning, ${escapeHtml(displayName)}!` : 'Good morning!';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // ── Build email HTML ─────────────────────────────────────────────────────
  let bodyContent: string;
  let subjectLine: string;

  if (matches.length === 0) {
    // Always send a "no matches" email so the user knows automation is working
    subjectLine = `${displayName ? `${displayName} — ` : ''}MyCareerBrain: No new matches today (${dateStr})`;
    bodyContent = `
    <div style="padding:32px 28px; text-align:center;">
      <div style="font-size:48px; margin-bottom:16px;">🔍</div>
      <p style="color:#64748b; font-size:15px; margin:0 0 8px;">No new job matches above <strong>${effectiveThreshold}%</strong> were found today.</p>
      <p style="color:#94a3b8; font-size:13px; margin:0;">Your autonomous engine is running — check back tomorrow, or lower your threshold in settings.</p>
    </div>`;
  } else {
    subjectLine = `${displayName ? `${displayName} — ` : ''}MyCareerBrain Digest: ${matches.length} new match${matches.length !== 1 ? 'es' : ''} (${dateStr})`;
    const jobRows = matches
      .map(
        (m: any) => `
      <tr>
        <td style="padding:12px 16px; border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:700; color:#0f172a; font-size:15px;">${escapeHtml(m.title)}</div>
          <div style="color:#64748b; font-size:13px; margin-top:2px;">${escapeHtml(m.company)} · ${escapeHtml(m.location || 'N/A')}</div>
          <div style="margin-top:4px;">
            <span style="display:inline-block; background:rgba(48,0,59,0.08); color:#30003b; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:700;">${m.score}% match</span>
            ${m.source ? `<span style="display:inline-block; background:#f0fdf4; color:#16a34a; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:600; margin-left:4px;">${escapeHtml(m.source)}</span>` : ''}
          </div>
        </td>
        <td style="padding:12px 16px; border-bottom:1px solid #f1f5f9; text-align:right; vertical-align:middle;">
          <a href="${escapeHtml(m.link || '#')}" style="display:inline-block; background:#30003b; color:white; padding:8px 16px; border-radius:12px; font-size:13px; font-weight:700; text-decoration:none;">View</a>
        </td>
      </tr>`,
      )
      .join('');
    bodyContent = `
    <div style="padding:8px 0;">
      <table style="width:100%; border-collapse:collapse;">
        ${jobRows}
      </table>
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f8fafc; margin:0; padding:32px 16px;">
  <div style="max-width:600px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <div style="background:linear-gradient(135deg,#30003b,#1a0024); padding:32px 28px; text-align:center;">
      <h1 style="color:white; margin:0; font-size:22px; font-weight:800;">${greeting}</h1>
      <p style="color:rgba(255,255,255,0.9); margin:8px 0 0; font-size:16px; font-weight:600;">Your Daily Job Digest</p>
      <p style="color:rgba(17,204,245,0.9); margin:6px 0 0; font-size:13px;">${dateStr}</p>
    </div>
    ${bodyContent}
    <div style="padding:20px 28px; text-align:center; border-top:1px solid #f1f5f9;">
      <p style="color:#94a3b8; font-size:12px; margin:0;">Sent by MyCareerBrain · <a href="#" style="color:#30003b; text-decoration:none;">Manage preferences</a></p>
    </div>
  </div>
</body>
</html>`;

  // ── Send via Resend ──────────────────────────────────────────────────────
  console.log(`Sending digest to ${recipientEmail} — subject: "${subjectLine}"`);
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resendFrom,
      to: [recipientEmail],
      subject: subjectLine,
      html,
    }),
  });

  const resendData = await resendRes.json();
  console.log(`Resend API Status: ${resendRes.status} — ${JSON.stringify(resendData)}`);

  if (!resendRes.ok) {
    return { status: resendRes.status, data: { error: 'Resend API error', details: resendData } };
  }

  // Only stamp last_digest_sent_at on real (non-test) runs so the time window
  // advances correctly for the next automated digest.
  if (!isTest) {
    await supabase
      .from('user_settings')
      .update({ last_digest_sent_at: new Date().toISOString() })
      .eq('user_id', userId);
    console.log(`Stamped last_digest_sent_at for user ${userId}`);
  } else {
    console.log('Test mode — last_digest_sent_at NOT updated');
  }

  return {
    status: 200,
    data: {
      success: true,
      emailId: resendData.id,
      sentTo: recipientEmail,
      matchCount: matches.length,
      threshold: effectiveThreshold,
      highestScore,
      isTest,
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
