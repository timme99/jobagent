/**
 * External job source integrations: Arbeitsagentur (German Federal Employment Agency)
 * and JSearch (RapidAPI).
 */

// ── Arbeitsagentur Jobsuche API ──────────────────────────────────────
// Docs: https://jobsuche.api.bund.dev/
// Public API key is "jobboerse-jobsuche" (no user-specific key needed).

interface ArbeitsagenturJob {
  hashId: string;
  titel: string;
  arbeitgeber: string;
  arbeitsort: { ort: string; region: string; land: string };
  beruf: string;
  refnr: string;
  eintrittsdatum: string;
  aktuelleVeroeffentlichungsdatum: string;
  modifikationsTimestamp: string;
}

interface ArbeitsagenturResponse {
  stellenangebote: ArbeitsagenturJob[];
  maxErgebnisse: number;
  page: number;
}

export async function fetchArbeitsagenturJobs(
  keywords: string,
  location: string
): Promise<{ id: string; title: string; company: string; location: string; link: string; description: string; source: string }[]> {
  const params = new URLSearchParams({
    was: keywords,
    wo: location,
    page: '1',
    size: '10',
  });

  const res = await fetch(
    `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'X-API-Key': 'jobboerse-jobsuche',
      },
    }
  );

  if (!res.ok) {
    console.error(`Arbeitsagentur API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data: ArbeitsagenturResponse = await res.json();
  const jobs = data.stellenangebote ?? [];

  return jobs.map((job) => {
    const ort = [job.arbeitsort?.ort, job.arbeitsort?.region, job.arbeitsort?.land]
      .filter(Boolean)
      .join(', ');
    return {
      id: `aa-${job.hashId}`,
      title: job.titel || job.beruf || 'Untitled Position',
      company: job.arbeitgeber || 'Unknown Employer',
      location: ort || 'Germany',
      link: `https://www.arbeitsagentur.de/jobsuche/suche?id=${job.hashId}`,
      description: `${job.beruf || ''}. Eintritt: ${job.eintrittsdatum || 'N/A'}. Ref: ${job.refnr || 'N/A'}`,
      source: 'arbeitsagentur',
    };
  });
}

// ── Arbeitsagentur Job Details (enriches description) ────────────────

export async function fetchArbeitsagenturJobDetails(
  hashId: string
): Promise<string> {
  try {
    const res = await fetch(
      `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${hashId}`,
      {
        method: 'GET',
        headers: { 'X-API-Key': 'jobboerse-jobsuche' },
      }
    );
    if (!res.ok) return '';
    const data = await res.json();
    return data.stellenbeschreibung || data.beschreibung || '';
  } catch {
    return '';
  }
}

// ── JSearch API (RapidAPI) ───────────────────────────────────────────
// Docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  job_city: string;
  job_state: string;
  job_country: string;
  job_description: string;
  job_is_remote: boolean;
  job_apply_link: string;
  job_google_link: string;
  job_posted_at_datetime_utc: string;
}

interface JSearchResponse {
  status: string;
  data: JSearchJob[];
}

export async function fetchJSearchJobs(
  keywords: string,
  location: string
): Promise<{ id: string; title: string; company: string; location: string; link: string; description: string; source: string }[]> {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.warn('JSearch: RAPIDAPI_KEY not configured, skipping.');
    return [];
  }

  const query = `${keywords} in ${location}`;
  const params = new URLSearchParams({
    query,
    page: '1',
    num_pages: '1',
  });

  const res = await fetch(
    `https://jsearch.p.rapidapi.com/search?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    }
  );

  if (!res.ok) {
    console.error(`JSearch API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data: JSearchResponse = await res.json();
  const jobs = data.data ?? [];

  return jobs.slice(0, 10).map((job) => {
    const loc = [job.job_city, job.job_state, job.job_country]
      .filter(Boolean)
      .join(', ');
    return {
      id: `js-${job.job_id}`,
      title: job.job_title || 'Untitled Position',
      company: job.employer_name || 'Unknown Company',
      location: job.job_is_remote ? `Remote (${loc})` : loc || 'Not specified',
      link: job.job_apply_link || job.job_google_link || '#',
      description: (job.job_description || '').slice(0, 2000),
      source: 'jsearch',
    };
  });
}
