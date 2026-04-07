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
  description: string;
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
    _t: String(Date.now()),
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
      description: '',
      link: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${extractedId}`,
      source: 'arbeitsagentur',
    };
  });
}

// ── Phase 2: JSearch (RapidAPI) ──────────────────────────────────────────────

// Maps location strings to ISO 3166-1 alpha-2 country codes for the JSearch country param.
function getCountryCode(location: string): string {
  const loc = location.toLowerCase();
  if (/germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|düsseldorf|stuttgart/.test(loc)) return 'de';
  if (/spain|españa|madrid|barcelona|seville|sevilla|valencia/.test(loc)) return 'es';
  if (/france|paris|lyon|marseille|toulouse|bordeaux/.test(loc)) return 'fr';
  if (/netherlands|holland|amsterdam|rotterdam|den haag|eindhoven/.test(loc)) return 'nl';
  if (/austria|österreich|vienna|wien|graz|salzburg/.test(loc)) return 'at';
  if (/switzerland|schweiz|suisse|zurich|zürich|geneva|genf|basel/.test(loc)) return 'ch';
  if (/uk|united kingdom|england|london|manchester|birmingham|edinburgh/.test(loc)) return 'gb';
  if (/canada|toronto|vancouver|montreal|calgary|ottawa/.test(loc)) return 'ca';
  if (/australia|sydney|melbourne|brisbane|perth|adelaide/.test(loc)) return 'au';
  if (/poland|polska|warsaw|warszawa|krakow|kraków|wroclaw|wrocław/.test(loc)) return 'pl';
  if (/italy|italia|rome|roma|milan|milano|florence|firenze|naples|napoli/.test(loc)) return 'it';
  if (/sweden|stockholm/.test(loc)) return 'se';
  if (/denmark|copenhagen/.test(loc)) return 'dk';
  if (/norway|oslo/.test(loc)) return 'no';
  if (/ireland|dublin/.test(loc)) return 'ie';
  if (/portugal|lisbon|porto/.test(loc)) return 'pt';
  if (/belgium|brussels/.test(loc)) return 'be';
  if (/japan|tokyo/.test(loc)) return 'jp';
  if (/singapore/.test(loc)) return 'sg';
  if (/israel|tel aviv/.test(loc)) return 'il';
  return 'us';
}

// Strips Boolean operators so plain-text search APIs return results.
// The original keywords string is kept for Gemini scoring (strict AI filter).
function simplifyKeywordsForJSearch(keywords: string): string {
  return keywords
    .replace(/\bAND\b/gi, ' ')
    .replace(/\bOR\b/gi, ' ')
    .replace(/[()"""'']/g, ' ')   // strip parentheses and all quote variants
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchJSearchJobs(
  keywords: string,
  location: string,
  jsearchApiKey: string,
): Promise<NormalizedJob[]> {
  const searchKeywords = simplifyKeywordsForJSearch(keywords);
  if (searchKeywords !== keywords) {
    console.log(`[JSearch] Boolean keywords detected — simplified for API: "${searchKeywords}"`);
  }
  const query = `${searchKeywords} in ${location}`;
  const countryCode = getCountryCode(location);
  const jsearchUrl =
    `https://jsearch.p.rapidapi.com/search` +
    `?query=${encodeURIComponent(query)}` +
    `&country=${countryCode}` +
    `&page=1` +
    `&num_pages=1` +
    `&date_posted=all` +
    `&_t=${Date.now()}`;
  console.log(`[JSearch] Request URL: ${jsearchUrl}`);
  console.log(`[JSearch] Headers: X-RapidAPI-Key=***${jsearchApiKey.slice(-4)}, X-RapidAPI-Host=jsearch.p.rapidapi.com`);

  const res = await fetch(jsearchUrl, {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': jsearchApiKey,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[JSearch] API error: ${res.status} ${res.statusText}`);
    console.error(`[JSearch] Error body: ${errorBody}`);
    return [];
  }

  const data = await res.json();
  const jobs: any[] = (data.data ?? []).slice(0, 10);

  if (jobs.length === 0) {
    console.warn(`[JSearch] 0 results. Full response: ${JSON.stringify(data)}`);
  } else {
    console.log(`[JSearch] Received ${jobs.length} result(s)`);
  }

  return jobs.map((job: any) => {
    const loc = [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ');
    return {
      external_id: `js-${job.job_id}`,
      title: job.job_title || 'Untitled Position',
      company: job.employer_name || 'Unknown Company',
      location: job.job_is_remote ? `Remote (${loc})` : loc || 'Not specified',
      description: job.job_description ?? '',
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
 * Call Gemini REST API to score a BATCH of jobs (5–10) against the candidate's profile
 * in a single API call. Uses gemini-3.1-flash-lite-preview for cost efficiency.
 * Returns an array of results keyed by the job's position index in the input array.
 */
async function scoreJobsBatch(
  jobs: Array<{ id: string; title: string; company: string; location: string; description: string }>,
  profile: { name: string; summary: string; skills: string[]; experience: any[]; hidden_strengths: string[] },
  strategy: { priorities: string[]; dealbreakers: string[]; seniority_level: string; location_preference: string } | null,
  keywords: string,
  geminiApiKey: string,
): Promise<Array<AiScoreResult & { jobId: string }>> {
  if (jobs.length === 0) return [];

  const recentRoles = (profile.experience ?? [])
    .slice(0, 3)
    .map((e: any) => `${e.role} at ${e.company}`)
    .join('; ') || 'Not specified';

  const strategyContext = strategy
    ? `\nPriorities: ${(strategy.priorities ?? []).slice(0, 3).join(', ')}\nDealbreakers: ${(strategy.dealbreakers ?? []).slice(0, 3).join(', ')}\nSeniority: ${strategy.seniority_level}`
    : '';

  const jobsList = jobs
    .map((job, i) => {
      const descSnippet = job.description ? `\n   Description: ${job.description.slice(0, 300)}` : '';
      return `${i + 1}. Title: ${job.title}\n   Company: ${job.company}\n   Location: ${job.location}${descSnippet}`;
    })
    .join('\n\n');

  const prompt = `You are a career AI scout. Score these ${jobs.length} jobs for the candidate. Return ONLY a valid JSON array, nothing else.

CANDIDATE:
Name: ${profile.name || 'Candidate'}
Summary: ${(profile.summary || '').slice(0, 300)}
Skills: ${(profile.skills ?? []).slice(0, 15).join(', ')}
Recent Roles: ${recentRoles}
Target Keywords: ${keywords}${strategyContext}

JOBS TO SCORE:
${jobsList}

Score each job 0-100 where 90+=perfect strategic fit, 70-89=strong match, 50-69=moderate, <50=poor.
Return exactly this JSON array with one entry per job (same order, 1-indexed):
[
  {
    "job_index": 1,
    "score": N,
    "reasoning": {
      "strategic_pros": ["why this fits their skills/goals"],
      "risk_analysis": ["gap or concern"],
      "ai_warnings": ["hard dealbreaker if any, else empty"],
      "description_intel": "One sentence describing what this role actually does."
    }
  }
]
Keep strategic_pros and risk_analysis to 2-3 items each. ai_warnings can be empty array.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1500,
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[AI] Gemini batch API error ${res.status}:`, errText.slice(0, 200));
    return [];
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    console.error('[AI] Empty batch response from Gemini');
    return [];
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    console.error('[AI] Failed to parse batch response JSON');
    return [];
  }

  const results: Array<AiScoreResult & { jobId: string }> = [];
  for (const item of parsed) {
    const idx = (item.job_index ?? 0) - 1;
    if (idx < 0 || idx >= jobs.length) continue;
    const r = item.reasoning ?? {};
    results.push({
      jobId: jobs[idx].id,
      score: typeof item.score === 'number' ? Math.min(100, Math.max(0, Math.round(item.score))) : 0,
      reasoning: {
        strategic_pros: Array.isArray(r.strategic_pros) ? r.strategic_pros : [],
        risk_analysis:  Array.isArray(r.risk_analysis)  ? r.risk_analysis  : [],
        ai_warnings:    Array.isArray(r.ai_warnings)    ? r.ai_warnings    : [],
        description_intel: typeof r.description_intel === 'string' ? r.description_intel : '',
      },
    });
  }
  return results;
}

/**
 * Call gemini-3.1-pro-preview to synthesize a brief executive summary of top matches.
 * Called once at the end of analyzeNewJobs — logged to console only (no schema change).
 */
async function synthesizeDailyDigest(
  topJobs: Array<{ title: string; company: string; score: number; pros: string[] }>,
  geminiApiKey: string,
): Promise<void> {
  if (topJobs.length === 0) return;

  const jobSummary = topJobs
    .map((j, i) => `${i + 1}. "${j.title}" at ${j.company} (${j.score}%) — ${j.pros.slice(0, 2).join('; ')}`)
    .join('\n');

  const prompt = `You are a strategic career advisor. In 2-3 sentences, synthesize an executive summary for a job seeker about their top matches today. Be direct and actionable.

TOP MATCHES:
${jobSummary}

Return only the summary text, no headers or labels.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 200 },
      }),
    },
  );

  if (!res.ok) {
    console.warn(`[DIGEST] Pro preview synthesis failed (${res.status}) — skipping`);
    return;
  }

  const data = await res.json();
  const summary = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (summary) console.log(`[DIGEST] Strategic summary: ${summary.trim()}`);
}

/**
 * After inserting new jobs, score the top 10 against the user's Master Profile.
 * Jobs are processed in batches of 5 (one Gemini call per batch) to save tokens.
 * Also runs recovery mode for any existing unscored jobs (score=0).
 * Cross-user score reuse is applied before calling Gemini for further token savings.
 */
async function analyzeNewJobs(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  insertedJobs: Array<{ id: string; title: string; company: string; location: string; description?: string }>,
  keywords: string,
  geminiApiKey: string,
): Promise<void> {
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

  // ── Recovery Mode: pick up previously unscored jobs ──────────────────────
  const { data: recoveryRows } = await supabase
    .from('job_matches')
    .select('id, title, company, location, description, link')
    .eq('user_id', userId)
    .eq('score', 0)
    .eq('status', 'pending')
    .not('id', 'in', `(${insertedJobs.map(j => `'${j.id}'`).join(',') || "''"})`)
    .limit(5);

  const recoveryJobs = (recoveryRows ?? []).map((r: any) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description ?? '',
    link: r.link ?? '',
  }));

  if (recoveryJobs.length > 0) {
    console.log(`[AI] Recovery mode: found ${recoveryJobs.length} previously unscored job(s)`);
  }

  // Combine new + recovery jobs; take top 10 total
  const newJobsWithDesc = insertedJobs.slice(0, 10).map(j => ({
    ...j,
    description: (j as any).description ?? '',
    link: (j as any).link ?? '',
  }));
  const allJobsToScore = [...newJobsWithDesc, ...recoveryJobs].slice(0, 10);

  if (allJobsToScore.length === 0) {
    console.log(`[AI] No jobs to score for user ${userId}`);
    return;
  }

  // ── Pre-IA Security Filter: skip jobs with very short descriptions ────────
  const jobsPassingFilter = allJobsToScore.filter(job => {
    if (job.description && job.description.length > 0 && job.description.length < 200) {
      console.log(`[AI] Skipping "${job.title}" — description too short (${job.description.length} chars) for reliable scoring`);
      return false;
    }
    return true;
  });

  console.log(`[AI] Scoring ${jobsPassingFilter.length} job(s) for user ${userId} (${allJobsToScore.length - jobsPassingFilter.length} skipped by pre-IA filter)`);

  // ── Global Data Strategy: reuse scores from other users ──────────────────
  const jobLinks = jobsPassingFilter.map(j => j.link).filter(Boolean);
  const reuseMap = new Map<string, { score: number; reasoning: any }>();

  if (jobLinks.length > 0) {
    const { data: existingScores } = await supabase
      .from('job_matches')
      .select('link, score, reasoning')
      .in('link', jobLinks)
      .gt('score', 0);

    for (const row of existingScores ?? []) {
      if (row.link && !reuseMap.has(row.link)) {
        reuseMap.set(row.link, { score: row.score, reasoning: row.reasoning });
      }
    }
  }

  const reusedJobs: Array<AiScoreResult & { jobId: string }> = [];
  const jobsNeedingGemini = jobsPassingFilter.filter(job => {
    const reused = job.link ? reuseMap.get(job.link) : undefined;
    if (reused) {
      console.log(`[AI] Reusing score for "${job.title}" from another user (${reused.score}%)`);
      reusedJobs.push({ jobId: job.id, score: reused.score, reasoning: reused.reasoning });
      return false;
    }
    return true;
  });

  // ── Batch Scoring with Gemini Flash Lite ─────────────────────────────────
  const allScored: Array<AiScoreResult & { jobId: string }> = [...reusedJobs];

  const BATCH_SIZE = 5;
  for (let i = 0; i < jobsNeedingGemini.length; i += BATCH_SIZE) {
    const batch = jobsNeedingGemini.slice(i, i + BATCH_SIZE);
    console.log(`[AI] Scoring batch of ${batch.length} job(s) (positions ${i + 1}–${i + batch.length})...`);
    try {
      const batchResults = await scoreJobsBatch(batch, profile, strategy, keywords, geminiApiKey);
      for (const r of batchResults) {
        console.log(`[AI] "${batch.find(j => j.id === r.jobId)?.title}" → ${r.score}%`);
      }
      allScored.push(...batchResults);
    } catch (err: any) {
      console.error(`[AI] Batch scoring failed for positions ${i + 1}–${i + batch.length}:`, err.message);
    }
    if (i + BATCH_SIZE < jobsNeedingGemini.length) await sleep(500);
  }

  console.log(`[AI] Scored ${allScored.length}/${jobsPassingFilter.length} jobs for user ${userId}`);

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

  // ── Final Digest Synthesis with gemini-3.1-pro-preview ───────────────────
  const topScored = [...allScored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(r => {
      const job = allJobsToScore.find(j => j.id === r.jobId);
      return {
        title: job?.title ?? 'Unknown',
        company: job?.company ?? 'Unknown',
        score: r.score,
        pros: r.reasoning.strategic_pros,
      };
    });

  await synthesizeDailyDigest(topScored, geminiApiKey);
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

  // 3. Phase 2 — JSearch (always runs alongside BA to supplement with descriptions)
  let jsearchJobs: NormalizedJob[] = [];
  if (jsearchApiKey) {
    console.log(`[${userId}] Running JSearch in parallel (BA returned ${baJobs.length} result(s))`);
    try {
      jsearchJobs = await fetchJSearchJobs(keywords, location, jsearchApiKey);
    } catch (err) {
      console.error(`[${userId}] JSearch fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`[${userId}] JSEARCH_API_KEY not set — skipping JSearch`);
  }

  const allJobs = [...baJobs, ...jsearchJobs];
  console.log(
    `[${userId}] Total candidates: ${allJobs.length} (BA: ${baJobs.length}, JSearch: ${jsearchJobs.length})`,
  );

  if (allJobs.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  // 4. Upsert all fetched jobs — conflict target is (user_id, link).
  //    status / score / reasoning are intentionally excluded from the payload so
  //    the DB never overwrites a user's 'accepted'/'dismissed' decision or an
  //    existing AI score. New rows get those values from column defaults.
  //    created_at is always set to now() so re-surfaced jobs sort to the top.
  const rows = allJobs
    .filter((j) => j.link)
    .map((job) => ({
      user_id: userId,
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description ?? '',
      link: job.link,
      source: job.source,
      // status / score / reasoning / created_at omitted — preserved by ON CONFLICT DO UPDATE
      // created_at is intentionally omitted: new rows get the DB default (now()),
      // existing rows keep their original discovery date so the Daily Digest
      // does not treat re-surfaced jobs as brand-new every scan.
    }));

  if (rows.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  for (const row of rows) {
    console.log(`[DB] Upserted job: ${row.title}`);
  }

  const { data: upsertedRows, error: upsertError } = await supabase
    .from('job_matches')
    .upsert(rows, { onConflict: 'user_id,link' })
    .select('id, title, company, location, description, link');

  console.log('Database Result:', { data: upsertedRows?.length ?? null, error: upsertError?.message ?? null });

  if (upsertError) {
    const msg = `Upsert failed for ${userId}: ${upsertError.message}`;
    console.error(msg);
    errors.push(msg);
    return { inserted: 0, skipped: 0, errors };
  }

  const insertedCount = upsertedRows?.length ?? 0;
  console.log(`[${userId}] Upserted ${insertedCount} job(s)`);
  // ── Phase 3: AI Scout — score top 10 new jobs against the user's Master Profile
  if (geminiApiKey && upsertedRows && upsertedRows.length > 0) {
    await analyzeNewJobs(supabase, userId, upsertedRows, keywords, geminiApiKey);
  } else if (!geminiApiKey) {
    console.warn('[AI] GEMINI_API_KEY not configured — skipping AI analysis. Add it as a Supabase secret.');
  }

  return { inserted: insertedCount, skipped: 0, errors };
}

// ── Broadcast: iterate all automation-enabled users ──────────────────────────

async function processAllUsers(
  supabase: ReturnType<typeof createClient>,
  jsearchApiKey: string | null,
  geminiApiKey: string | null,
): Promise<Record<string, unknown>[]> {
  // Explicitly build a service-role client with persistSession:false so the
  // Supabase SDK never tries browser-style session management inside a Deno
  // edge function (which silently degrades to anon auth and RLS blocks all rows).
  const serviceSupabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  console.log('[SYSTEM] Querying user_settings (automation_enabled=true) with service-role client...');

  const { data: allSettings, error: settingsError } = await serviceSupabase
    .from('user_settings')
    .select('user_id, scan_keywords')
    .eq('automation_enabled', true);

  if (settingsError) {
    console.error('[SYSTEM] Failed to load user_settings:', settingsError.message);
    return [{ error: 'Failed to load user_settings', details: settingsError.message }];
  }

  console.log('[SYSTEM] Profiles found in DB:', allSettings?.length || 0);

  const users = allSettings ?? [];

  if (users.length === 0) {
    console.warn('[SYSTEM] No users with automation_enabled=true found — loop will not run. Check the user_settings table.');
    return [];
  }

  console.log(`[SYSTEM] Starting global scan for ${users.length} users....`);

  const results: Record<string, unknown>[] = [];

  for (const s of users) {
    console.log(`[SYSTEM] Processing user: ${s.user_id} | Keywords: ${s.scan_keywords || '(none)'}`);
    try {
      const result = await fetchJobsForUser(serviceSupabase, s.user_id, jsearchApiKey, geminiApiKey);
      results.push({ userId: s.user_id, ...result });
    } catch (err: any) {
      console.error(`[SYSTEM] Error processing user ${s.user_id}:`, err?.message ?? String(err));
      results.push({ userId: s.user_id, error: err?.message ?? String(err) });
    }
    await sleep(500); // avoid thundering-herd on external APIs
  }

  return results;
}

// ── Request handler ───────────────────────────────────────────────────────────

serve(async (req: Request) => {
  console.log('--- DEPLOYMENT VERIFIED: VERSION 3.5 ---');
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
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonRes(401, { error: 'Missing Authorization header' });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    // Auth debug: log token shape so we can diagnose 401s from the cron SQL call
    const isJwt = token.split('.').length === 3;
    console.log(`Auth debug: header="${authHeader.slice(0, 15)}...", token length=${token.length}, looks like JWT=${isJwt}, serviceRoleKey length=${serviceRoleKey?.length ?? 0}`);

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
