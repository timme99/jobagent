// supabase/functions/fetch-jobs/index.ts
// "Hunter" Edge Function: fetches raw job listings from Bundesagentur für Arbeit (Phase 1)
// and JSearch/RapidAPI (Phase 2), deduplicates against job_matches, and inserts new rows.
//
// Invocation modes:
//   1. Service role key, no user_id  → pg_cron broadcast to all automation-enabled users
//   2. Service role key + user_id    → targets a specific user
//   3. User JWT                      → the authenticated user only
//
// Required Supabase secrets:
//   JSEARCH_API_KEY  – RapidAPI key for JSearch (optional; BA-only if absent)
//   GEMINI_API_KEY   – Google AI key for AI scoring of top 10 matches per user

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

// ── Constants ─────────────────────────────────────────────────────────────────

const BA_API_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs';
const BA_PAGE_SIZE = 25;
// Supplement with JSearch when BA returns fewer results than this threshold.
const JSEARCH_MIN_TRIGGER = 10;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Aggressively strip Boolean operators, quotes, and parentheses for the BA API. */
function sanitizeKeywordsForBA(raw: string): string {
  return raw
    .replace(/[()"""'']/g, '')       // remove all parentheses and quote variants
    .replace(/\bOR\b/gi, ' ')       // remove OR (case-insensitive)
    .replace(/\bAND\b/gi, ' ')      // remove AND (case-insensitive)
    .replace(/[,;|+]/g, ' ')        // remove other common delimiters
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}

/** Simple deterministic hash for generating a stable ID from job title + company. */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0; // force 32-bit int
  }
  return Math.abs(hash).toString(36);
}

// ── Shared job shape ──────────────────────────────────────────────────────────

interface NormalizedJob {
  external_id: string;
  title: string;
  company: string;
  location: string;
  link: string;
  source: string;
}

// ── Phase 1: Bundesagentur für Arbeit ────────────────────────────────────────

async function fetchBAJobs(keywords: string, location: string): Promise<NormalizedJob[]> {
  const params = new URLSearchParams({
    was: keywords,
    wo: location,
    page: '1',
    size: String(BA_PAGE_SIZE),
  });

  const baUrl = `${BA_API_URL}?${params}`;
  console.log(`[BA] URL: ${baUrl}`);

  const res = await fetch(baUrl, {
    method: 'GET',
    headers: { 'X-API-Key': 'jobboerse-jobsuche' },
  });

  console.log(`[BA] API Raw Status: ${res.status}`);

  if (!res.ok) {
    console.error(`[BA] API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = await res.json();
  const offers: any[] = data.stellenangebote ?? [];

  console.log(`[BA] Received ${offers.length} result(s)`);

  // Log the field names of the first job so we can see exactly what the API returns
  if (offers.length > 0) {
    console.log('[BA] First job keys:', Object.keys(offers[0]).join(', '));
    console.debug('[BA] First job sample:', JSON.stringify(offers[0]).slice(0, 400));
  }

  return offers.map((job: any) => {
    const ort = [job.arbeitsort?.ort, job.arbeitsort?.region, job.arbeitsort?.land]
      .filter(Boolean)
      .join(', ');

    // Bulletproof ID extraction: refnr → hashId → deterministic hash
    let extractedId: string = job.refnr ?? job.hashId ?? '';
    if (!extractedId) {
      // Last resort: create a stable hash from title + company so we never skip a job
      const title = job.titel || job.beruf || '';
      const company = job.arbeitgeber || '';
      extractedId = `gen-${simpleHash(title + '|' + company)}`;
      console.log('[BA] Generated fallback ID from title+company:', extractedId);
    }
    console.log('[BA] Extracted ID:', extractedId);

    return {
      external_id: `aa-${extractedId}`,
      title: job.titel || job.beruf || 'Untitled Position',
      company: job.arbeitgeber || 'Unknown Employer',
      location: ort || 'Germany',
      link: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${extractedId}`,
      source: 'arbeitsagentur',
    };
  });
}

// ── Phase 2: JSearch (RapidAPI) ──────────────────────────────────────────────

async function fetchJSearchJobs(
  keywords: string,
  location: string,
  jsearchApiKey: string,
): Promise<NormalizedJob[]> {
  const query = `${keywords} in ${location}`;
  const params = new URLSearchParams({ query, page: '1', num_pages: '1' });

  const jsearchUrl = `https://jsearch.p.rapidapi.com/search?${params}`;
  console.log(`[JSearch] URL: ${jsearchUrl}`);

  const res = await fetch(jsearchUrl, {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': jsearchApiKey,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
  });

  if (!res.ok) {
    console.error(`[JSearch] API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = await res.json();
  const jobs: any[] = (data.data ?? []).slice(0, 10);

  console.log(`[JSearch] Received ${jobs.length} result(s)`);

  return jobs.map((job: any) => {
    const loc = [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ');
    return {
      external_id: `js-${job.job_id}`,
      title: job.job_title || 'Untitled Position',
      company: job.employer_name || 'Unknown Company',
      location: job.job_is_remote ? `Remote (${loc})` : loc || 'Not specified',
      link: job.job_apply_link || job.job_google_link || '',
      source: 'jsearch',
    };
  });
}

// ── AI Scoring (Scout brain) ─────────────────────────────────────────────────

interface AiScoreResult {
  score: number;
  reasoning: {
    strategic_pros: string[];   // Why this role fits their skills & career goals
    risk_analysis: string[];    // Gaps, mismatches, or concerns
    ai_warnings: string[];      // Hard dealbreakers or red flags
    description_intel: string;  // One-sentence summary of the role
  };
}

/**
 * Call Gemini REST API to score a single job against the candidate's profile.
 * Uses gemini-3.1-flash-lite-preview — fast and cost-efficient, ideal for parallel scoring.
 */
async function scoreJobWithGemini(
  job: { title: string; company: string; location: string },
  profile: { name: string; summary: string; skills: string[]; experience: any[]; hidden_strengths: string[] },
  strategy: { priorities: string[]; dealbreakers: string[]; seniority_level: string; location_preference: string } | null,
  keywords: string,
  geminiApiKey: string,
): Promise<AiScoreResult | null> {
  const recentRoles = (profile.experience ?? [])
    .slice(0, 3)
    .map((e: any) => `${e.role} at ${e.company}`)
    .join('; ') || 'Not specified';

  const strategyContext = strategy
    ? `\nPriorities: ${(strategy.priorities ?? []).slice(0, 3).join(', ')}\nDealbreakers: ${(strategy.dealbreakers ?? []).slice(0, 3).join(', ')}\nSeniority: ${strategy.seniority_level}`
    : '';

  const prompt = `You are a career AI scout. Score this job for the candidate. Return ONLY valid JSON, nothing else.

CANDIDATE:
Name: ${profile.name || 'Candidate'}
Summary: ${(profile.summary || '').slice(0, 300)}
Skills: ${(profile.skills ?? []).slice(0, 15).join(', ')}
Recent Roles: ${recentRoles}
Target Keywords: ${keywords}${strategyContext}

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}

Score 0-100 where 90+=perfect strategic fit, 70-89=strong match, 50-69=moderate, <50=poor.
Return exactly this JSON and nothing else:
{
  "score": N,
  "reasoning": {
    "strategic_pros": ["why this fits their skills/goals", "another pro"],
    "risk_analysis": ["gap or concern", "another concern"],
    "ai_warnings": ["hard dealbreaker if any, else empty"],
    "description_intel": "One sentence describing what this role actually does."
  }
}
Keep strategic_pros and risk_analysis to 2-3 items. ai_warnings can be empty array.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 500,
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[AI] Gemini API error ${res.status}:`, errText.slice(0, 200));
    return null;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    console.error('[AI] Empty response from Gemini');
    return null;
  }

  const parsed = JSON.parse(text);
  const r = parsed.reasoning ?? {};
  return {
    score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.score))) : 0,
    reasoning: {
      strategic_pros: Array.isArray(r.strategic_pros) ? r.strategic_pros : [],
      risk_analysis:  Array.isArray(r.risk_analysis)  ? r.risk_analysis  : [],
      ai_warnings:    Array.isArray(r.ai_warnings)    ? r.ai_warnings    : [],
      description_intel: typeof r.description_intel === 'string' ? r.description_intel : '',
    },
  };
}

/**
 * After inserting new jobs, score the top 10 against the user's Master Profile.
 * Jobs are processed in chunks of 5 to stay well within the 60s Supabase timeout.
 */
async function analyzeNewJobs(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  insertedJobs: Array<{ id: string; title: string; company: string; location: string }>,
  keywords: string,
  geminiApiKey: string,
): Promise<void> {
  if (insertedJobs.length === 0) return;

  // Load profile + strategy in parallel
  const [profileRes, strategyRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('name, summary, skills, experience, hidden_strengths')
      .eq('user_id', userId)
      .single(),
    supabase
      .from('strategies')
      .select('priorities, dealbreakers, seniority_level, location_preference')
      .eq('user_id', userId)
      .single(),
  ]);

  if (profileRes.error || !profileRes.data) {
    console.warn(`[AI] No profile found for user ${userId} — skipping AI analysis. Build a Master Profile first.`);
    return;
  }

  const profile = profileRes.data;
  const strategy = strategyRes.data ?? null;

  // Top 10 — BA API already orders by relevance
  const topJobs = insertedJobs.slice(0, 10);
  console.log(`[AI] Scoring ${topJobs.length} jobs for user ${userId} in chunks of 3...`);

  const allScored: Array<AiScoreResult & { jobId: string }> = [];

  // Process in chunks of 3 to save results to DB more frequently before the 60s timeout
  const CHUNK_SIZE = 3;
  for (let i = 0; i < topJobs.length; i += CHUNK_SIZE) {
    const chunk = topJobs.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(async (job) => {
        try {
          const result = await scoreJobWithGemini(job, profile, strategy, keywords, geminiApiKey);
          if (!result) return null;
          console.log(`[AI] "${job.title}" → ${result.score}%`);
          return { jobId: job.id, ...result };
        } catch (err: any) {
          console.error(`[AI] Failed to score "${job.title}" (${job.id}):`, err.message);
          return null;
        }
      }),
    );
    allScored.push(...(chunkResults.filter(Boolean) as Array<AiScoreResult & { jobId: string }>));

    // Small pause between chunks to avoid rate-limit pressure and Supabase timeout
    if (i + CHUNK_SIZE < topJobs.length) await sleep(500);
  }

  console.log(`[AI] Scored ${allScored.length}/${topJobs.length} jobs successfully for user ${userId}`);

  // Write scores back — all parallel, per-row failure logged but non-blocking
  await Promise.all(
    allScored.map(({ jobId, score, reasoning }) =>
      supabase
        .from('job_matches')
        .update({ score, reasoning })
        .eq('id', jobId)
        .then(({ error }) => {
          if (error) console.error(`[AI] DB update failed for job ${jobId}:`, error.message);
        }),
    ),
  );
}

// ── Core: fetch & store jobs for one user ────────────────────────────────────

async function fetchJobsForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  jsearchApiKey: string | null,
  geminiApiKey: string | null,
): Promise<{ inserted: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];

  // 1. Load scan_keywords and scan_location from user_settings
  const { data: settings, error: settingsError } = await supabase
    .from('user_settings')
    .select('scan_keywords, scan_location')
    .eq('user_id', userId)
    .single();

  if (settingsError || !settings) {
    const msg = `Failed to load settings for ${userId}: ${settingsError?.message ?? 'no row found'}`;
    console.error(msg);
    return { inserted: 0, skipped: 0, errors: [msg] };
  }

  // scan_keywords is the absolute source of truth — use it exactly as stored
  const keywords: string = (settings.scan_keywords ?? '').trim();
  // scan_location from DB is canonical; fall back to 'Germany' only when the field is empty
  const location: string = (settings.scan_location ?? '').trim() || 'Germany';

  if (!keywords) {
    const msg = `[${userId}] scan_keywords is null or empty — skipping this user. Configure keywords in user settings.`;
    console.error(msg);
    return { inserted: 0, skipped: 0, errors: [msg] };
  }

  // 2. Phase 1 — Bundesagentur für Arbeit
  // BA API prefers plain space-separated terms; strip Boolean operators and quotes.
  const baKeywords = sanitizeKeywordsForBA(keywords);
  if (baKeywords !== keywords) {
    console.log(`[${userId}] BA keywords sanitized: "${keywords}" → "${baKeywords}"`);
  }
  const baJobs = await fetchBAJobs(baKeywords, location);

  // 3. Phase 2 — JSearch (only if BA didn't return enough results)
  let jsearchJobs: NormalizedJob[] = [];
  if (baJobs.length < JSEARCH_MIN_TRIGGER) {
    if (jsearchApiKey) {
      console.log(
        `[${userId}] BA returned ${baJobs.length} < ${JSEARCH_MIN_TRIGGER} — supplementing with JSearch`,
      );
      jsearchJobs = await fetchJSearchJobs(keywords, location, jsearchApiKey);
    } else {
      console.log(
        `[${userId}] BA returned ${baJobs.length} results but JSEARCH_API_KEY not set — skipping JSearch`,
      );
    }
  }

  const allJobs = [...baJobs, ...jsearchJobs];
  console.log(
    `[${userId}] Total candidates: ${allJobs.length} (BA: ${baJobs.length}, JSearch: ${jsearchJobs.length})`,
  );

  if (allJobs.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  // 4. Deduplicate — check which links already exist for this user in job_matches
  const candidateLinks = allJobs.map((j) => j.link).filter(Boolean);
  const { data: existing, error: existingError } = await supabase
    .from('job_matches')
    .select('link')
    .eq('user_id', userId)
    .in('link', candidateLinks);

  if (existingError) {
    const msg = `Failed to query existing jobs for ${userId}: ${existingError.message}`;
    console.error(msg);
    errors.push(msg);
    // Continue with best-effort deduplication (existingLinks will be empty)
  }

  const existingLinks = new Set((existing ?? []).map((r: any) => r.link));
  const newJobs = allJobs.filter((j) => j.link && !existingLinks.has(j.link));
  const skippedCount = allJobs.length - newJobs.length;

  console.log(`[${userId}] New: ${newJobs.length} | Already in DB: ${skippedCount}`);

  if (newJobs.length === 0) {
    return { inserted: 0, skipped: skippedCount, errors };
  }

  // 5. Insert new rows — score starts at 0 (scoring happens in a separate step)
  const rows = newJobs.map((job) => ({
    user_id: userId,
    title: job.title,
    company: job.company,
    location: job.location,
    link: job.link,
    source: job.source,
    score: 0,
    status: 'pending',
    reasoning: { pros: [], cons: [], riskFactors: [] },
    created_at: new Date().toISOString(),
  }));

  const { data: insertedRows, error: insertError } = await supabase
    .from('job_matches')
    .insert(rows)
    .select('id, title, company, location');

  if (insertError) {
    const msg = `Insert failed for ${userId}: ${insertError.message}`;
    console.error(msg);
    errors.push(msg);
    return { inserted: 0, skipped: skippedCount, errors };
  }

  const insertedCount = insertedRows?.length ?? 0;
  console.log(`[${userId}] Inserted ${insertedCount} new job(s)`);
  console.log(`DEBUG: Successfully processed ${insertedCount} jobs for user ${userId}`);

  // ── Phase 3: AI Scout — score top 10 new jobs against the user's Master Profile
  if (geminiApiKey && insertedRows && insertedRows.length > 0) {
    await analyzeNewJobs(supabase, userId, insertedRows, keywords, geminiApiKey);
  } else if (!geminiApiKey) {
    console.warn('[AI] GEMINI_API_KEY not configured — skipping AI analysis. Add it as a Supabase secret.');
  }

  return { inserted: insertedCount, skipped: skippedCount, errors };
}

// ── Broadcast: iterate all automation-enabled users ──────────────────────────

async function processAllUsers(
  supabase: ReturnType<typeof createClient>,
  jsearchApiKey: string | null,
  geminiApiKey: string | null,
): Promise<Record<string, unknown>[]> {
  console.log('--- CRON RUN STARTED ---');

  const { data: allSettings, error: settingsError } = await supabase
    .from('user_settings')
    .select('user_id, scan_keywords')
    .eq('automation_enabled', true);

  if (settingsError) {
    console.error('Failed to load user_settings:', settingsError.message);
    return [{ error: 'Failed to load user_settings', details: settingsError.message }];
  }

  console.log('Users found in DB:', allSettings?.length || 0);

  const results: Record<string, unknown>[] = [];

  for (const s of allSettings ?? []) {
    console.log('Processing user:', s.user_id, 'Keywords:', s.scan_keywords || '(none)');
    const result = await fetchJobsForUser(supabase, s.user_id, jsearchApiKey, geminiApiKey);
    results.push({ userId: s.user_id, ...result });
    await sleep(500); // avoid thundering-herd on external APIs
  }

  return results;
}

// ── Request handler ───────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight — always first, outside try/catch
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  console.log('--- Hunter Function Started ---');

  try {
    const body = await req.json().catch(() => ({}));

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const jsearchApiKey = Deno.env.get('JSEARCH_API_KEY') ?? null;
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY') ?? null;

    // Always use the service-role client for DB writes so RLS doesn't block inserts.
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonRes(401, { error: 'Missing Authorization header' });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    // ── Service-role path — cron broadcast or targeted single user ────────────
    if (isServiceRoleToken(token, serviceRoleKey)) {
      console.log('Auth: service_role detected');

      if (!body.user_id) {
        // pg_cron broadcast — no user_id means run for all automation-enabled users
        console.log('Mode: cron broadcast (all automation-enabled users)');
        const results = await processAllUsers(supabase, jsearchApiKey, geminiApiKey);
        return jsonRes(200, { processed: results.length, results });
      }

      // Targeted single-user invocation via service role
      console.log(`Mode: service_role single user (${body.user_id})`);
      const result = await fetchJobsForUser(supabase, body.user_id, jsearchApiKey, geminiApiKey);
      return jsonRes(200, { userId: body.user_id, ...result });
    }

    // ── User JWT path — validate token, scope to authenticated user ───────────
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await supabaseUser.auth.getUser();

    if (userError || !user) {
      return jsonRes(401, { error: 'Unauthorized' });
    }

    console.log(`Mode: user JWT (${user.id})`);
    const result = await fetchJobsForUser(supabase, user.id, jsearchApiKey, geminiApiKey);
    return jsonRes(200, { userId: user.id, ...result });

  } catch (err: any) {
    console.error('Unhandled error in fetch-jobs:', err);
    return jsonRes(500, { error: err.message || 'Internal server error' });
  }
});
