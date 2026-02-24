// supabase/functions/send-digest/index.ts
// Supabase Edge Function: sends a branded job digest email via Resend.
//
// Invocation modes:
//   1. User JWT  + { test: true }  → skips time filter AND threshold; uses mock data if DB empty
//   2. Service role key + user_id  → targets a specific user
//   3. Service role key, no user_id → pg_cron broadcast to all automation-enabled users
//   4. Any of the above + { check: true } → diagnostic mode, returns summary without sending
//
// Required Supabase secrets:
//   RESEND_API_KEY  – Resend API key (re_...)
//   RESEND_FROM     – verified sender, e.g. "MyCareerBrain <digest@yourdomain.com>"

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

// ── Module-level constants (available to every function in this file) ─────────

const LOGO_URL =
  'https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/logo.png';

const MOCK_MATCHES = [
  {
    id: 'mock-1',
    title: 'Lead AI Architect',
    company: 'MyCareerBrain',
    location: 'Remote',
    score: 97,
    source: 'featured',
    link: '#',
    reasoning: { summary: 'Perfect strategic fit across all dimensions.' },
  },
  {
    id: 'mock-2',
    title: 'Senior Product Designer',
    company: 'Notion',
    location: 'Berlin / Remote',
    score: 91,
    source: 'linkedin',
    link: '#',
    reasoning: { summary: 'Strong match on UX leadership and B2B SaaS experience.' },
  },
  {
    id: 'mock-3',
    title: 'Head of Growth',
    company: 'Linear',
    location: 'Remote',
    score: 85,
    source: 'jsearch',
    link: '#',
    reasoning: { summary: 'Aligns with your go-to-market and PLG priorities.' },
  },
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Normalize a score to 0-100 scale.
// Handles both whole-number (85) and decimal (0.85) storage formats.
function normalizeScore(raw: number): number {
  if (raw <= 1.5) return Math.round(raw * 100);
  return Math.round(raw);
}

// Detect a service-role credential regardless of how the cron presents it.
// Case A: the raw SUPABASE_SERVICE_ROLE_KEY string is used directly as the bearer token.
// Case B: pg_cron sends a short-lived signed JWT whose payload has role=service_role.
//         JWT segments are base64url-encoded; atob() needs standard base64, so convert first.
function isServiceRoleToken(token: string, serviceRoleKey: string): boolean {
  if (token === serviceRoleKey) return true;
  try {
    const segment = token.split('.')[1];
    if (!segment) return false;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    const role = payload?.role ?? payload?.app_metadata?.role ?? '';
    console.log(`Auth check: JWT role claim = "${role}"`);
    return role === 'service_role';
  } catch (e) {
    console.log(`Auth check: JWT decode failed (${e}) — not a service-role token`);
    return false;
  }
}

// ── Email subject line ────────────────────────────────────────────────────────

function buildSubject(
  name: string,
  matchCount: number,
  isTest: boolean,
  usedMockData: boolean,
): string {
  const prefix = name ? `${name} — ` : '';
  if (isTest && usedMockData) {
    return `${prefix}🎯 Daily Scout: Test preview (${matchCount} mock matches)`;
  }
  if (matchCount === 0) {
    return `${prefix}🎯 Daily Scout: No new matches today`;
  }
  return `${prefix}🎯 Daily Scout: ${matchCount} match${matchCount !== 1 ? 'es' : ''} found`;
}

// ── Premium email HTML (fully inline CSS for Gmail/Outlook) ──────────────────

function buildEmailHtml(opts: {
  displayName: string;
  dateStr: string;
  matches: any[];
  effectiveThreshold: number;
  totalFetched: number;
  isNoMatches: boolean;
  usedMockData: boolean;
}): string {
  const { displayName, dateStr, matches, effectiveThreshold, totalFetched, isNoMatches, usedMockData } = opts;
  const greeting = displayName ? `Good morning, ${escapeHtml(displayName)}!` : 'Good morning!';

  const jobCards = matches.map((m: any) => {
    const scoreDisplay = `${m.score}% Match`;
    const sourceLabel = m.source
      ? `<span style="display:inline-block;background:#f0fdf4;color:#16a34a;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;margin-left:6px;">${escapeHtml(m.source)}</span>`
      : '';
    return `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;margin-bottom:12px;overflow:hidden;">
      <tr>
        <td style="padding:20px 24px;">
          <table cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
            <tr>
              <td>
                <span style="display:inline-block;background:rgba(17,204,245,0.15);color:#0891b2;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:0.03em;">${scoreDisplay}</span>
                ${sourceLabel}
              </td>
            </tr>
          </table>
          <div style="font-size:18px;font-weight:800;color:#11ccf5;line-height:1.3;margin-bottom:4px;">${escapeHtml(m.title)}</div>
          <div style="font-size:13px;color:#64748b;margin-bottom:16px;">${escapeHtml(m.company)}&nbsp;·&nbsp;${escapeHtml(m.location || 'Remote')}</div>
          <a href="${escapeHtml(m.link && m.link !== '#' ? m.link : 'https://mycareerbrain.app')}"
             style="display:inline-block;background:#11ccf5;color:#0f172a;padding:10px 24px;border-radius:12px;font-size:13px;font-weight:800;text-decoration:none;letter-spacing:0.02em;">
            View Job &rarr;
          </a>
        </td>
      </tr>
    </table>`;
  }).join('\n');

  const noMatchesBody = `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;margin-bottom:12px;">
      <tr>
        <td style="padding:36px 28px;text-align:center;">
          <div style="font-size:48px;margin-bottom:12px;">🔍</div>
          <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 8px 0;">Nothing above your bar today.</p>
          <p style="font-size:14px;color:#64748b;margin:0;line-height:1.6;">
            We scanned <strong>${totalFetched}</strong> job${totalFetched !== 1 ? 's' : ''} for you today, but nothing
            hit your <strong>${effectiveThreshold}%</strong> match score.<br>We&rsquo;ll try again tomorrow!
          </p>
        </td>
      </tr>
    </table>`;

  const mockBanner = usedMockData ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
      <tr>
        <td style="background:#fff8e1;border:1px solid #ffd54f;border-radius:12px;padding:10px 16px;text-align:center;">
          <span style="font-size:12px;color:#b45309;font-weight:700;">⚠️ TEST MODE — Showing mock data. Real jobs will appear once you run a scan.</span>
        </td>
      </tr>
    </table>` : '';

  const mainBody = isNoMatches ? noMatchesBody : `${mockBanner}${jobCards}`;
  const matchCountLine = isNoMatches
    ? `Scanned ${totalFetched} listings · nothing cleared ${effectiveThreshold}%`
    : `${matches.length} match${matches.length !== 1 ? 'es' : ''} above ${effectiveThreshold}%${usedMockData ? ' (preview)' : ''}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>MyCareerBrain Digest</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#30003b 0%,#1a0024 100%);padding:36px 28px 28px;text-align:center;">
              <img src="${LOGO_URL}" alt="MyCareerBrain" width="160"
                   style="max-width:180px;height:auto;display:block;margin:0 auto 20px;border:0;"
                   onerror="this.style.display='none'">
              <h1 style="margin:0 0 6px;color:#ffffff;font-size:24px;font-weight:800;line-height:1.2;">${greeting}</h1>
              <p style="margin:0 0 4px;color:rgba(255,255,255,0.85);font-size:15px;font-weight:500;">Your Daily Job Digest</p>
              <p style="margin:0;color:rgba(17,204,245,0.9);font-size:13px;font-weight:600;">${dateStr} &nbsp;·&nbsp; ${matchCountLine}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 24px 8px;">
              ${mainBody}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;text-align:center;border-top:1px solid #f1f5f9;">
              <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:0.01em;">
                Stop scrolling. Start matching.
              </p>
              <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;">
                <a href="https://mycareerbrain.app" style="color:#30003b;text-decoration:none;font-weight:600;">Manage your settings</a>
                &nbsp;&middot;&nbsp;
                <a href="https://mycareerbrain.app" style="color:#94a3b8;text-decoration:none;">Unsubscribe</a>
              </p>
              <p style="margin:0;font-size:11px;color:#cbd5e1;">
                Sent by MyCareerBrain &middot; Maria Alejandra Diaz Linde &middot; Stuttgart, Germany
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Broadcast: iterate every automation-enabled user ─────────────────────────

async function processAllUsers(
  supabase: ReturnType<typeof createClient>,
  resendApiKey: string,
  resendFrom: string,
  isDiagnostic: boolean,
  dateStr: string,
) {
  console.log('--- CRON RUN STARTED ---');

  const { data: allSettings, error: settingsError } = await supabase
    .from('user_settings')
    .select('user_id, digest_email, match_threshold, last_digest_sent_at, timezone, display_name, automation_enabled')
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
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
    const currentHour = parseInt(
      (parts.find((p: Intl.DateTimeFormatPart) => p.type === 'hour') ?? { value: '0' }).value,
      10,
    );

    // NOTE: Time check temporarily disabled to verify cron invocation.
    // Re-enable by un-commenting the block below once confirmed working.
    // if (currentHour !== 8) {
    //   console.log(`Skipping user ${s.user_id}: ${currentHour}:xx in ${tz} (need 8:xx)`);
    //   results.push({ userId: s.user_id, skipped: true, reason: `Not 8 AM in ${tz}` });
    //   continue;
    // }

    console.log(`Processing digest for ${s.user_id} (current hour: ${currentHour}:xx in ${tz})`);
    const result = await sendDigestForUser(
      supabase, s.user_id, s.digest_email, {}, resendApiKey, resendFrom, isDiagnostic, dateStr, s, false,
    );
    results.push({ userId: s.user_id, status: result.status, ...(result.data as object) });
    await sleep(1000);
  }

  return results;
}

// ── Core digest logic for one user ───────────────────────────────────────────

async function sendDigestForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  userEmail: string | undefined,
  body: Record<string, any>,
  resendApiKey: string,
  resendFrom: string,
  isDiagnostic: boolean,
  dateStr: string,
  preloadedSettings?: Record<string, any>,
  isTest = false,
): Promise<{ status: number; data: unknown }> {

  // ── 1. Load settings ────────────────────────────────────────────────────────
  let settings = preloadedSettings;
  if (!settings) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('digest_email, match_threshold, last_digest_sent_at, display_name')
      .eq('user_id', userId)
      .single();
    if (error) console.error(`Settings load failed for ${userId}:`, error.message);
    settings = data ?? {};
  }

  const recipientEmail: string = body.email || settings.digest_email || userEmail || '';
  if (!recipientEmail) return { status: 400, data: { error: 'No digest email configured' } };

  const effectiveThreshold: number = body.threshold ?? settings.match_threshold ?? 80;
  const displayName: string = settings.display_name || '';

  // ── 2. TEST FAST-PATH ────────────────────────────────────────────────────────
  if (isTest) {
    console.log('TEST FAST-PATH: engaged — skipping time filter and threshold gate');

    const { data: rawMatches, error: matchError } = await supabase
      .from('job_matches')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'dismissed')
      .order('score', { ascending: false })
      .limit(20);

    if (matchError) {
      console.warn('TEST FAST-PATH: DB fetch error (continuing with mocks):', matchError.message);
    }

    const normalized = (rawMatches ?? []).map((m: any) => {
      const rawScore = m.score;
      const normalizedScore = normalizeScore(rawScore);
      console.log(`Math check: DB Score ${rawScore} normalized to ${normalizedScore} vs Threshold ${effectiveThreshold}`);
      return { ...m, score: normalizedScore };
    });

    let matches: any[] = normalized;
    let usedMockData = false;

    if (matches.length === 0) {
      console.log('TEST FAST-PATH: DB empty — injecting MOCK_MATCHES for design preview');
      matches = MOCK_MATCHES as any[];
      usedMockData = true;
    }

    const highestScore = matches.length > 0 ? Math.max(...matches.map((m: any) => m.score)) : 0;

    if (isDiagnostic) {
      return {
        status: 200,
        data: {
          diagnostic: true, isTest: true, usedMockData,
          wouldSendTo: recipientEmail, threshold: effectiveThreshold,
          totalFetched: normalized.length, highestScore, matchCount: matches.length,
          matches: matches.map((m: any) => ({
            id: m.id, title: m.title, company: m.company,
            score: m.score, created_at: m.created_at,
          })),
        },
      };
    }

    const testHtml = buildEmailHtml({
      displayName, dateStr, matches, effectiveThreshold,
      totalFetched: normalized.length, isNoMatches: false, usedMockData,
    });
    const testSubject = buildSubject(displayName, matches.length, true, usedMockData);

    console.log(`TEST FAST-PATH: Sending to ${recipientEmail} — "${testSubject}"`);
    const testResendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: resendFrom, to: [recipientEmail], subject: testSubject, html: testHtml }),
    });
    const testResendData = await testResendRes.json();
    console.log(`Resend API ${testResendRes.status}: ${JSON.stringify(testResendData)}`);

    if (!testResendRes.ok) {
      return { status: testResendRes.status, data: { error: 'Resend API error', details: testResendData } };
    }

    console.log('TEST FAST-PATH: last_digest_sent_at NOT updated (test run)');
    return {
      status: 200,
      data: {
        success: true, emailId: testResendData.id, sentTo: recipientEmail,
        matchCount: matches.length, threshold: effectiveThreshold,
        highestScore, isTest: true, usedMockData,
      },
    };
  }

  // ── 3. Real automated path ───────────────────────────────────────────────────
  const lastSent: string | null = settings.last_digest_sent_at ?? null;
  const since = lastSent
    ? new Date(lastSent).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log(`Time filter: matches after ${since}`);

  const { data: rawMatches, error: matchError } = await supabase
    .from('job_matches')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'dismissed')
    .order('score', { ascending: false })
    .limit(20)
    .gte('created_at', since);

  if (matchError) {
    return { status: 500, data: { error: 'Failed to load matches', details: matchError.message } };
  }

  // ── 4. Normalize scores & apply threshold ────────────────────────────────────
  const normalized = (rawMatches ?? []).map((m: any) => {
    const rawScore = m.score;
    const normalizedScore = normalizeScore(rawScore);
    console.log(`Math check: DB Score ${rawScore} normalized to ${normalizedScore} vs Threshold ${effectiveThreshold}`);
    return { ...m, score: normalizedScore };
  });

  const totalFetched = normalized.length;
  const highestScore = totalFetched > 0 ? Math.max(...normalized.map((m: any) => m.score)) : 0;

  const matches = normalized.filter((m: any) => {
    const pass = m.score >= effectiveThreshold;
    console.log(`[FILTER] Score ${m.score} vs Threshold ${effectiveThreshold} → ${pass ? 'PASS' : 'SKIP'}`);
    return pass;
  });

  console.log(`totalFetched: ${totalFetched} | highestScore: ${highestScore} | matchesForEmail: ${matches.length}`);

  // ── 5. Diagnostic mode ────────────────────────────────────────────────────────
  if (isDiagnostic) {
    return {
      status: 200,
      data: {
        diagnostic: true, isTest: false, usedMockData: false,
        wouldSendTo: recipientEmail, threshold: effectiveThreshold,
        totalFetched, highestScore, matchCount: matches.length,
        matches: matches.map((m: any) => ({
          id: m.id, title: m.title, company: m.company,
          score: m.score, created_at: m.created_at,
        })),
      },
    };
  }

  // ── 6. Build email (zero-matches sends the branded "No Matches" email) ────────
  const isNoMatches = matches.length === 0;
  console.log(`isNoMatches: ${isNoMatches} — sending ${isNoMatches ? '"No Matches" safety email' : `${matches.length} match(es)`}`);

  const html = buildEmailHtml({
    displayName, dateStr, matches, effectiveThreshold,
    totalFetched, isNoMatches, usedMockData: false,
  });
  const subject = buildSubject(displayName, matches.length, false, false);

  // ── 7. Send via Resend ────────────────────────────────────────────────────────
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: resendFrom, to: [recipientEmail], subject, html }),
  });
  const resendData = await resendRes.json();
  console.log(`Resend API ${resendRes.status}: ${JSON.stringify(resendData)}`);

  if (!resendRes.ok) {
    return { status: resendRes.status, data: { error: 'Resend API error', details: resendData } };
  }

  // Stamp last_digest_sent_at so this user isn't emailed again in the same window
  await supabase
    .from('user_settings')
    .update({ last_digest_sent_at: new Date().toISOString() })
    .eq('user_id', userId);
  console.log(`Stamped last_digest_sent_at for ${userId}`);

  return {
    status: 200,
    data: {
      success: true, emailId: resendData.id, sentTo: recipientEmail,
      matchCount: matches.length, threshold: effectiveThreshold,
      highestScore, isNoMatches, isTest: false, usedMockData: false,
    },
  };
}

// ── Request handler ───────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Single dateStr declaration — shared by every path in this handler.
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  try {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'Morning from MyCareerBrain <digest@mycareerbrain.de>';

    if (!RESEND_API_KEY) {
      return jsonRes(500, {
        error: 'RESEND_API_KEY not configured. Run: supabase secrets set RESEND_API_KEY=re_...',
      });
    }

    const body = await req.json().catch(() => ({}));

    // ── NUCLEAR TEST MODE — no auth, no DB, always sends ─────────────────────
    if (body.test === true) {
      const toEmail: string = body.email || '';
      if (!toEmail) {
        return jsonRes(400, { error: 'Test mode requires an email address in the request body.' });
      }

      console.log('TEST MODE: Bypassing DB and sending mock email');
      const effectiveThreshold: number = body.threshold ?? 80;
      const displayName: string = body.display_name || '';

      const html = buildEmailHtml({
        displayName, dateStr, matches: MOCK_MATCHES as any[],
        effectiveThreshold, totalFetched: 0, isNoMatches: false, usedMockData: true,
      });
      const subjectLine = buildSubject(displayName, MOCK_MATCHES.length, true, true);

      console.log(`TEST MODE: Sending mock email to ${toEmail} — "${subjectLine}"`);
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: RESEND_FROM, to: [toEmail], subject: subjectLine, html }),
      });
      const resendData = await resendRes.json();
      console.log(`TEST MODE: Resend API ${resendRes.status}: ${JSON.stringify(resendData)}`);

      if (!resendRes.ok) {
        return jsonRes(resendRes.status, { error: 'Resend API error', details: resendData });
      }

      return jsonRes(200, {
        success: true, emailId: resendData.id, sentTo: toEmail,
        matchCount: MOCK_MATCHES.length, threshold: effectiveThreshold,
        highestScore: 97, isTest: true, usedMockData: true,
      });
    }

    // ── Authenticated paths (cron / service-role / user JWT) ──────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonRes(401, { error: 'Missing Authorization header' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const isDiagnostic = body.check === true;
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    // ── Service-role path — skip auth.getUser(), cron has no user profile ─────
    if (isServiceRoleToken(token, serviceRoleKey)) {
      console.log('Auth check: Service Role detected');
      if (!body.user_id) {
        console.log('Function started by: service_role (cron broadcast)');
        const results = await processAllUsers(supabase, RESEND_API_KEY, RESEND_FROM, isDiagnostic, dateStr);
        return jsonRes(200, { processed: results.length, results });
      }
      console.log(`Function started by: service_role for user ${body.user_id}`);
      const result = await sendDigestForUser(
        supabase, body.user_id, body.email, body,
        RESEND_API_KEY, RESEND_FROM, isDiagnostic, dateStr, undefined, false,
      );
      return jsonRes(result.status, result.data);
    }

    // ── User JWT path — validate token and get user profile ───────────────────
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) return jsonRes(401, { error: 'Unauthorized' });

    console.log(`Function started by: ${user.id} (user JWT)`);
    const result = await sendDigestForUser(
      supabase, user.id, user.email, body,
      RESEND_API_KEY, RESEND_FROM, isDiagnostic, dateStr, undefined, false,
    );
    return jsonRes(result.status, result.data);

  } catch (err: any) {
    console.error('Unhandled error:', err);
    return jsonRes(500, { error: err.message || 'Internal server error' });
  }
});
