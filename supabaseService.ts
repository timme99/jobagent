import { supabase } from './supabaseClient';
import type { MasterProfile, SearchStrategy, JobMatch } from './types';

// ── Profile ───────────────────────────────────────────────────────────
export async function saveProfile(
  userId: string,
  profile: MasterProfile,
  sources: any[] = []
): Promise<void> {
  const { error } = await supabase.from('profiles').upsert(
    {
      user_id: userId,
      name: profile.name,
      summary: profile.summary,
      skills: profile.skills,
      experience: profile.experience,
      hidden_strengths: profile.hiddenStrengths,
      sources,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}

export async function loadProfile(
  userId: string
): Promise<{ profile: MasterProfile; sources: any[] } | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return {
    profile: {
      name: data.name,
      summary: data.summary,
      skills: data.skills ?? [],
      experience: data.experience ?? [],
      hiddenStrengths: data.hidden_strengths ?? [],
    },
    sources: data.sources ?? [],
  };
}

// ── Strategy ──────────────────────────────────────────────────────────
export async function saveStrategy(
  userId: string,
  strategy: SearchStrategy
): Promise<void> {
  const { error } = await supabase.from('strategies').upsert(
    {
      user_id: userId,
      priorities: strategy.priorities,
      dealbreakers: strategy.dealbreakers,
      preferred_industries: strategy.preferredIndustries,
      location_preference: strategy.locationPreference,
      seniority_level: strategy.seniorityLevel,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}

export async function loadStrategy(
  userId: string
): Promise<SearchStrategy | null> {
  const { data, error } = await supabase
    .from('strategies')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return {
    priorities: data.priorities ?? [],
    dealbreakers: data.dealbreakers ?? [],
    preferredIndustries: data.preferred_industries ?? [],
    locationPreference: data.location_preference ?? 'flexible',
    seniorityLevel: data.seniority_level ?? 'mid-level',
  };
}

// ── Job Matches ───────────────────────────────────────────────────────

// Always produces the exact shape the DB column expects.
function normalizeReasoning(r: any): { pros: string[]; cons: string[]; riskFactors: string[] } {
  return {
    pros: Array.isArray(r?.pros) ? r.pros : [],
    cons: Array.isArray(r?.cons) ? r.cons : [],
    riskFactors: Array.isArray(r?.riskFactors) ? r.riskFactors : [],
  };
}

export async function saveJobMatches(
  userId: string,
  matches: JobMatch[]
): Promise<void> {
  if (matches.length === 0) return;

  const rows = matches
    // Required by DB: user_id, title, company must be present.
    .filter((m) => m.title && m.company)
    .map((m) => ({
      id: m.id,
      user_id: userId,           // auth.uid() equivalent — always the calling user
      title: m.title,
      company: m.company,
      location: m.location ?? '',
      description: m.description ?? '',
      score: m.score,
      reasoning: normalizeReasoning(m.reasoning), // { pros, cons, riskFactors }
      link: m.link ?? '',
      status: 'pending' as const, // DB constraint: must be 'pending' on initial insert
      source: m.source || 'manual',
    }));

  if (rows.length === 0) return;
  const { error } = await supabase.from('job_matches').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
}

export async function loadJobMatches(userId: string): Promise<JobMatch[]> {
  const { data, error } = await supabase
    .from('job_matches')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'dismissed')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map(rowToJobMatch);
}

export async function loadShortlistedJobs(userId: string): Promise<JobMatch[]> {
  const { data, error } = await supabase
    .from('job_matches')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'accepted')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map(rowToJobMatch);
}

export async function updateJobStatus(
  matchId: string,
  status: 'accepted' | 'dismissed' | 'pending'
): Promise<void> {
  const { error } = await supabase
    .from('job_matches')
    .update({ status })
    .eq('id', matchId);
  if (error) throw error;
}

function rowToJobMatch(row: any): JobMatch {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location ?? '',
    description: row.description ?? '',
    score: row.score ?? 0,
    reasoning: normalizeReasoning(row.reasoning), // always { pros, cons, riskFactors }
    link: row.link ?? '#',
    source: row.source,
    status: row.status,
  };
}

// ── User Settings ─────────────────────────────────────────────────────
export interface UserSettings {
  automationEnabled: boolean;
  matchThreshold: number;
  scanKeywords: string;
  scanLocation: string;
  digestEmail: string;
  displayName: string;
  avatarIcon: string;
  timezone: string;
}

export async function saveSettings(
  userId: string,
  settings: Partial<UserSettings>
): Promise<void> {
  const row: any = { user_id: userId, updated_at: new Date().toISOString() };
  if (settings.automationEnabled !== undefined) row.automation_enabled = settings.automationEnabled;
  if (settings.matchThreshold !== undefined) row.match_threshold = settings.matchThreshold;
  if (settings.scanKeywords !== undefined) row.scan_keywords = settings.scanKeywords;
  if (settings.scanLocation !== undefined) row.scan_location = settings.scanLocation;
  if (settings.digestEmail !== undefined) row.digest_email = settings.digestEmail;
  if (settings.displayName !== undefined) row.display_name = settings.displayName;
  if (settings.avatarIcon !== undefined) row.avatar_icon = settings.avatarIcon;
  if (settings.timezone !== undefined) row.timezone = settings.timezone;
  const { error } = await supabase.from('user_settings').upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function loadSettings(userId: string): Promise<UserSettings> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    return {
      automationEnabled: true,
      matchThreshold: 80,
      scanKeywords: '',
      scanLocation: 'Remote',
      digestEmail: '',
      displayName: '',
      avatarIcon: 'User',
      timezone: '',
    };
  }
  return {
    automationEnabled: data.automation_enabled ?? true,
    matchThreshold: data.match_threshold ?? 80,
    scanKeywords: data.scan_keywords ?? '',
    scanLocation: data.scan_location ?? 'Remote',
    digestEmail: data.digest_email ?? '',
    displayName: data.display_name ?? '',
    avatarIcon: data.avatar_icon ?? 'User',
    timezone: data.timezone ?? '',
  };
}

// ── Init settings on first login ──────────────────────────────────────
export async function ensureUserSettings(userId: string, email: string): Promise<void> {
  const { data } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('user_id', userId)
    .single();
  if (!data) {
    await supabase.from('user_settings').insert({
      user_id: userId,
      digest_email: email,
    });
  }
}
