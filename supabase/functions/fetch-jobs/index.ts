// supabase/functions/fetch-jobs/index.ts
// Server-side proxy for the Arbeitsagentur Jobsuche API.
// Browsers cannot call rest.arbeitsagentur.de directly due to CORS.
// This Edge Function runs on Deno (server side) so there is no CORS restriction.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

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
    const { keywords = '', location = 'Remote' } = await req.json().catch(() => ({}));

    if (!keywords) {
      return jsonRes(400, { error: 'keywords is required' });
    }

    // ── Arbeitsagentur Jobsuche API (public, no user key needed) ────────────
    const params = new URLSearchParams({
      was: keywords,
      wo: location,
      page: '1',
      size: '10',
    });

    console.log(`Fetching Arbeitsagentur jobs: was="${keywords}" wo="${location}"`);

    const aaRes = await fetch(
      `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?${params}`,
      {
        method: 'GET',
        headers: { 'X-API-Key': 'jobboerse-jobsuche' },
      }
    );

    if (!aaRes.ok) {
      console.error(`Arbeitsagentur API error: ${aaRes.status} ${aaRes.statusText}`);
      // Return empty list rather than hard-failing the whole scan.
      return jsonRes(200, { jobs: [], source: 'arbeitsagentur', error: `API ${aaRes.status}` });
    }

    const data = await aaRes.json();
    const stellenangebote: any[] = data.stellenangebote ?? [];

    const jobs = stellenangebote.map((job: any) => {
      const ort = [job.arbeitsort?.ort, job.arbeitsort?.region, job.arbeitsort?.land]
        .filter(Boolean)
        .join(', ');
      return {
        // No `id` field — Supabase will generate a UUID on insert.
        // We keep a stable external reference for deduplication if needed later.
        externalId: `aa-${job.hashId}`,
        title: job.titel || job.beruf || 'Untitled Position',
        company: job.arbeitgeber || 'Unknown Employer',
        location: ort || 'Germany',
        link: `https://www.arbeitsagentur.de/jobsuche/suche?id=${job.hashId}`,
        description: `${job.beruf || ''}. Eintritt: ${job.eintrittsdatum || 'N/A'}. Ref: ${job.refnr || 'N/A'}`,
        source: 'arbeitsagentur',
      };
    });

    console.log(`Returned ${jobs.length} Arbeitsagentur jobs`);
    return jsonRes(200, { jobs });

  } catch (err: any) {
    console.error('Unhandled error in fetch-jobs:', err);
    return jsonRes(500, { error: err.message || 'Internal server error' });
  }
});
