-- JobScout AI – Database Schema
-- Run this in your Supabase Dashboard → SQL Editor → New Query → Run

-- ── Profiles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  summary TEXT,
  skills TEXT[],
  experience JSONB DEFAULT '[]'::jsonb,
  hidden_strengths TEXT[],
  sources JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

-- ── Strategies ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.strategies (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  priorities TEXT[],
  dealbreakers TEXT[],
  preferred_industries TEXT[],
  location_preference TEXT CHECK (location_preference IN ('remote', 'hybrid', 'onsite', 'flexible')),
  seniority_level TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own strategy"
  ON public.strategies FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own strategy"
  ON public.strategies FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own strategy"
  ON public.strategies FOR UPDATE USING (auth.uid() = user_id);

-- ── Job Matches ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_matches (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  company TEXT,
  location TEXT,
  description TEXT,
  score NUMERIC DEFAULT 0,
  reasoning JSONB DEFAULT '{"pros":[],"cons":[],"riskFactors":[]}'::jsonb,
  link TEXT,
  source TEXT,
  status TEXT CHECK (status IN ('accepted', 'dismissed', 'pending')) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.job_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own matches"
  ON public.job_matches FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own matches"
  ON public.job_matches FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own matches"
  ON public.job_matches FOR UPDATE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_job_matches_user_id ON public.job_matches(user_id);
CREATE INDEX IF NOT EXISTS idx_job_matches_score ON public.job_matches(user_id, score DESC);

-- ── User Settings ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  automation_enabled BOOLEAN DEFAULT true,
  match_threshold NUMERIC DEFAULT 80,
  scan_keywords TEXT DEFAULT '',
  scan_location TEXT DEFAULT 'Remote',
  digest_email TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own settings"
  ON public.user_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own settings"
  ON public.user_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own settings"
  ON public.user_settings FOR UPDATE USING (auth.uid() = user_id);
