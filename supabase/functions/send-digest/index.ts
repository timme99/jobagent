// supabase/functions/send-digest/index.ts
// Supabase Edge Function: sends a branded job digest email via Resend.
//
// Can be invoked:
//   1. From the frontend ("Send Test Digest" button)
//   2. Via a Supabase cron/pg_cron scheduled job for daily automation
//
// Required Supabase secrets (set via `supabase secrets set`):
//   RESEND_API_KEY   – your Resend API key
//   RESEND_FROM      – verified sender address
//   GOT_JWT_SECRET   – the JWT secret from Supabase (Settings > API > JWT Secret)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

// ── Safety: max job matches per digest run (protects Gemini API quota) ──
const MAX_MATCHES_PER_RUN = 50;

// ── Brand ────────────────────────────────────────────────────────────
const BRAND = {
  bg: '#30003b',
  accent: '#11ccf5',
  logo: 'https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/logo.png',
  name: 'MyCareerBrain',
  url: 'https://mycareerbrain.de',
};

// ── CORS ─────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://mycareerbrain.de',
  'https://www.mycareerbrain.de',
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allowed =
    ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  corsHeaders: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── JWT verification using Web Crypto (HMAC-SHA256) ──────────────────
async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ sub: string; email?: string } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const b64url = (s: string) =>
      Uint8Array.from(
        atob(s.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      );

    const signatureValid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64url(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!signatureValid) return null;

    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.log('JWT expired at', new Date(payload.exp * 1000).toISOString());
      return null;
    }

    return { sub: payload.sub, email: payload.email };
  } catch (err: any) {
    console.log(`JWT verification error: ${err.message}`);
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── Secrets ──────────────────────────────────────────────────────
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'MyCareerBrain <onboarding@resend.dev>';
    const JWT_SECRET = Deno.env.get('GOT_JWT_SECRET');

    if (!RESEND_API_KEY) {
      return jsonResponse(
        { success: false, error: 'RESEND_API_KEY not configured.' },
        corsHeaders,
      );
    }
    if (!JWT_SECRET) {
      return jsonResponse(
        { success: false, error: 'GOT_JWT_SECRET not configured.' },
        corsHeaders,
      );
    }

    // ── Auth ─────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ success: false, error: 'Missing Authorization header' }, corsHeaders);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const token = authHeader.replace('Bearer ', '');
    let userId: string;
    let userEmail: string | undefined;

    if (token === supabaseServiceKey) {
      if (!body.user_id) {
        return jsonResponse(
          { success: false, error: 'When using service_role key, provide user_id in the request body' },
          corsHeaders,
        );
      }
      userId = body.user_id;
      userEmail = body.email;
    } else {
      const claims = await verifyJwt(token, JWT_SECRET);
      if (!claims || !claims.sub) {
        console.log('JWT verification failed for token (first 20 chars):', token.slice(0, 20));
        return jsonResponse(
          { success: false, error: 'Unauthorized: JWT verification failed. Token may be expired or the JWT secret is incorrect.' },
          corsHeaders,
        );
      }
      userId = claims.sub;
      userEmail = claims.email;
      console.log('User ID from token:', userId);
    }

    // ── User settings ────────────────────────────────────────────────
    const { data: settings, error: settingsError } = await supabase
      .from('user_settings')
      .select('digest_email, match_threshold, last_digest_sent_at')
      .eq('user_id', userId)
      .single();

    if (settingsError) {
      console.log(`user_settings lookup: ${settingsError.message} (user_id: ${userId})`);
    }

    const recipientEmail = body.email || settings?.digest_email || userEmail;
    if (!recipientEmail) {
      return jsonResponse(
        { success: false, error: 'No digest email configured. Pass "email" in the request body or set one in Settings.' },
        corsHeaders,
      );
    }

    const effectiveThreshold = body.threshold ?? settings?.match_threshold ?? 80;

    // ── Determine time window for deduplication ──────────────────────
    // Use last_digest_sent_at if available, otherwise default to 24h ago.
    const lastSent = settings?.last_digest_sent_at;
    const since = lastSent
      ? lastSent
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // ── Fetch matches (24h window + dedup + capped at 50) ────────────
    const { data: matches, error: matchError } = await supabase
      .from('job_matches')
      .select('*')
      .eq('user_id', userId)
      .gte('score', effectiveThreshold)
      .gte('created_at', since)
      .neq('status', 'dismissed')
      .order('score', { ascending: false })
      .limit(MAX_MATCHES_PER_RUN);

    if (matchError) {
      console.log(`job_matches query error: ${matchError.message}`);
      return jsonResponse(
        { success: false, error: 'Failed to load matches', details: matchError.message },
        corsHeaders,
      );
    }

    // ── Build email ──────────────────────────────────────────────────
    const dateStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });

    let subject: string;
    let emailHtml: string;

    if (!matches || matches.length === 0) {
      subject = `${BRAND.name}: No new matches today (${dateStr})`;
      emailHtml = buildNoMatchesEmail(effectiveThreshold, dateStr);
    } else {
      subject = `${BRAND.name}: ${matches.length} new match${matches.length > 1 ? 'es' : ''} (${dateStr})`;
      emailHtml = buildMatchesEmail(matches, effectiveThreshold, dateStr);
    }

    // ── Send via Resend ──────────────────────────────────────────────
    let resendData: any;
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [recipientEmail],
          subject,
          html: emailHtml,
        }),
      });

      resendData = await resendRes.json();

      if (!resendRes.ok) {
        console.log(`Resend API error: ${JSON.stringify(resendData)}`);
        return jsonResponse(
          { success: false, error: 'Resend API error', details: resendData },
          corsHeaders,
        );
      }
    } catch (resendErr: any) {
      console.log(`Resend fetch failed: ${resendErr.message}`);
      return jsonResponse(
        { success: false, error: `Resend request failed: ${resendErr.message}` },
        corsHeaders,
      );
    }

    // ── Success: update last_digest_sent_at for deduplication ────────
    const { error: updateError } = await supabase
      .from('user_settings')
      .update({ last_digest_sent_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (updateError) {
      console.log(`Failed to update last_digest_sent_at: ${updateError.message}`);
    }

    return jsonResponse(
      {
        success: true,
        emailId: resendData.id,
        sentTo: recipientEmail,
        matchCount: matches?.length ?? 0,
        threshold: effectiveThreshold,
      },
      corsHeaders,
    );
  } catch (err: any) {
    console.log(`Unhandled error in send-digest: ${err.message}`);
    return jsonResponse(
      { success: false, error: err.message || 'Internal server error' },
      corsHeaders,
    );
  }
});

// ── Branded email builders ───────────────────────────────────────────

function buildNoMatchesEmail(threshold: number, dateStr: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#1a0020; margin:0; padding:32px 16px;">
  <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:24px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.15);">
    <div style="background:${BRAND.bg}; padding:32px 28px; text-align:center;">
      <img src="${BRAND.logo}" alt="${BRAND.name}" style="width:48px; height:48px; border-radius:12px; margin-bottom:12px;" />
      <h1 style="color:${BRAND.accent}; margin:0; font-size:22px; font-weight:800;">${BRAND.name}</h1>
      <p style="color:rgba(255,255,255,0.7); margin:6px 0 0; font-size:13px;">Daily Update &middot; ${esc(dateStr)}</p>
    </div>
    <div style="padding:32px 28px; text-align:center;">
      <div style="width:64px; height:64px; background:#f0fdf4; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; margin-bottom:16px;">
        <span style="font-size:28px;">&#x2714;</span>
      </div>
      <h2 style="color:#0f172a; font-size:18px; font-weight:700; margin:0 0 8px;">No New Matches Today</h2>
      <p style="color:#64748b; font-size:14px; line-height:1.6; margin:0;">
        No jobs scored above your <strong>${threshold}%</strong> threshold today.
        Your agent is still running &mdash; we&rsquo;ll email you as soon as new matches appear.
      </p>
    </div>
    <div style="padding:20px 28px; text-align:center; border-top:1px solid #f1f5f9;">
      <p style="color:#94a3b8; font-size:12px; margin:0;">Sent by ${BRAND.name} &middot; <a href="${BRAND.url}" style="color:${BRAND.accent}; text-decoration:none;">Open Dashboard</a></p>
    </div>
  </div>
</body>
</html>`;
}

function buildMatchesEmail(
  matches: any[],
  threshold: number,
  dateStr: string,
): string {
  const jobRows = matches
    .map(
      (m: any) => `
      <tr>
        <td style="padding:14px 20px; border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:700; color:#0f172a; font-size:15px;">${esc(m.title)}</div>
          <div style="color:#64748b; font-size:13px; margin-top:3px;">${esc(m.company)} &middot; ${esc(m.location || 'Remote / N/A')}</div>
          <div style="margin-top:6px;">
            <span style="display:inline-block; background:#e0f7fa; color:#0097a7; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:700;">${m.score}% match</span>
            ${m.source ? `<span style="display:inline-block; background:#f3e5f5; color:#7b1fa2; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600; margin-left:4px;">${esc(m.source)}</span>` : ''}
          </div>
        </td>
        <td style="padding:14px 20px; border-bottom:1px solid #f1f5f9; text-align:right; vertical-align:middle;">
          <a href="${esc(m.link || '#')}" style="display:inline-block; background:${BRAND.accent}; color:${BRAND.bg}; padding:9px 18px; border-radius:12px; font-size:13px; font-weight:700; text-decoration:none;">View&nbsp;&rarr;</a>
        </td>
      </tr>`,
    )
    .join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#1a0020; margin:0; padding:32px 16px;">
  <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:24px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.15);">
    <div style="background:${BRAND.bg}; padding:32px 28px; text-align:center;">
      <img src="${BRAND.logo}" alt="${BRAND.name}" style="width:48px; height:48px; border-radius:12px; margin-bottom:12px;" />
      <h1 style="color:${BRAND.accent}; margin:0; font-size:22px; font-weight:800;">Your Daily Job Digest</h1>
      <p style="color:rgba(255,255,255,0.7); margin:6px 0 0; font-size:13px;">${matches.length} match${matches.length > 1 ? 'es' : ''} scoring ${threshold}%+ &middot; ${esc(dateStr)}</p>
    </div>
    <div style="padding:4px 0;">
      <table style="width:100%; border-collapse:collapse;">
        ${jobRows}
      </table>
    </div>
    ${matches.length >= MAX_MATCHES_PER_RUN ? `<div style="padding:12px 28px; text-align:center; background:#fff3e0;"><p style="color:#e65100; font-size:12px; margin:0; font-weight:600;">Showing top ${MAX_MATCHES_PER_RUN} matches. Open your dashboard to see the rest.</p></div>` : ''}
    <div style="padding:20px 28px; text-align:center; border-top:1px solid #f1f5f9;">
      <p style="color:#94a3b8; font-size:12px; margin:0;">Sent by ${BRAND.name} &middot; <a href="${BRAND.url}" style="color:${BRAND.accent}; text-decoration:none;">Open Dashboard</a></p>
    </div>
  </div>
</body>
</html>`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
