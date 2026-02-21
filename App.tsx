
import React, { useState, useMemo, useEffect, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  Briefcase,
  User,
  Target,
  Search,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle2,
  XCircle,
  Menu,
  X,
  FileText,
  Settings,
  Mail,
  Zap,
  ExternalLink,
  Trash2,
  BookmarkCheck,
  Linkedin,
  Info,
  PlusCircle,
  RefreshCw,
  LogOut,
  Coffee,
  Dog,
} from 'lucide-react';
import { MasterProfile, SearchStrategy, JobMatch, AppView } from './types';
import { synthesizeProfile, refineStrategy, scoreJobMatch, fetchLiveJobs } from './geminiService';
import { fetchArbeitsagenturJobs, fetchJSearchJobs } from './jobSources';
import { AuthProvider, useAuth } from './AuthProvider';
import AuthPage from './AuthPage';
import * as db from './supabaseService';
import { supabase } from './supabaseClient';

// ── Error Boundary ────────────────────────────────────────────────────
interface ErrorBoundaryProps { children: ReactNode }
interface ErrorBoundaryState { hasError: boolean; error: Error | null }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-8">
          <div className="bg-white p-12 rounded-[2.5rem] shadow-xl max-w-lg text-center border border-slate-100">
            <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <AlertCircle size={32} />
            </div>
            <h2 className="text-2xl font-black text-slate-900 mb-3">Something Went Wrong</h2>
            <p className="text-slate-500 font-medium mb-2">{this.state.error?.message || 'An unexpected error occurred.'}</p>
            <p className="text-xs text-slate-400 mb-8">Try refreshing or clearing your browser data if this persists.</p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="inline-flex items-center gap-2 text-white px-8 py-3 rounded-2xl font-bold transition-colors"
              style={{ background: '#30003b' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1a0024')}
              onMouseLeave={e => (e.currentTarget.style.background = '#30003b')}
            >
              <RefreshCw size={16} /> Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Avatar options & timezone list ────────────────────────────────────
const AVATAR_OPTIONS = [
  { id: 'User',      label: 'Default',   icon: <User size={18} /> },
  { id: 'Coffee',    label: 'Coffee',    icon: <Coffee size={18} /> },
  { id: 'Sparkles',  label: 'Sparkles',  icon: <Sparkles size={18} /> },
  { id: 'Dog',       label: 'Dog',       icon: <Dog size={18} /> },
  { id: 'Briefcase', label: 'Briefcase', icon: <Briefcase size={18} /> },
];

function getAvatarIcon(id: string, size = 20): React.ReactNode {
  switch (id) {
    case 'Coffee':    return <Coffee size={size} />;
    case 'Sparkles':  return <Sparkles size={size} />;
    case 'Dog':       return <Dog size={size} />;
    case 'Briefcase': return <Briefcase size={size} />;
    default:          return <User size={size} />;
  }
}

const COMMON_TIMEZONES = [
  { label: 'UTC',                                   value: 'UTC' },
  { label: 'London (GMT/BST)',                      value: 'Europe/London' },
  { label: 'Berlin / Paris / Rome (CET/CEST)',      value: 'Europe/Berlin' },
  { label: 'Helsinki / Kyiv (EET/EEST)',            value: 'Europe/Helsinki' },
  { label: 'Moscow (MSK)',                          value: 'Europe/Moscow' },
  { label: 'Dubai (GST)',                           value: 'Asia/Dubai' },
  { label: 'India (IST)',                           value: 'Asia/Kolkata' },
  { label: 'Singapore / Hong Kong (SGT/HKT)',       value: 'Asia/Singapore' },
  { label: 'Tokyo (JST)',                           value: 'Asia/Tokyo' },
  { label: 'Sydney (AEST/AEDT)',                    value: 'Australia/Sydney' },
  { label: 'New York / Toronto (ET)',               value: 'America/New_York' },
  { label: 'Chicago / Dallas (CT)',                 value: 'America/Chicago' },
  { label: 'Denver (MT)',                           value: 'America/Denver' },
  { label: 'Los Angeles / Vancouver (PT)',          value: 'America/Los_Angeles' },
  { label: 'Buenos Aires (ART)',                    value: 'America/Argentina/Buenos_Aires' },
  { label: 'São Paulo (BRT)',                       value: 'America/Sao_Paulo' },
];

function AppContent() {
  const { user, signOut } = useAuth();
  const userId = user!.id;
  const userEmail = user!.email ?? '';

  const [view, setView] = useState<AppView>('profile');
  const [profile, setProfile] = useState<MasterProfile | null>(null);
  const [profileSources, setProfileSources] = useState<any[]>([]);
  const [strategy, setStrategy] = useState<SearchStrategy | null>(null);
  const [matches, setMatches] = useState<JobMatch[]>([]);
  const [shortlistedJobs, setShortlistedJobs] = useState<JobMatch[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Analyzing data...');

  // Automation state
  const [automationEnabled, setAutomationEnabled] = useState(true);
  const [matchThreshold, setMatchThreshold] = useState(80);
  const [digestEmail, setDigestEmail] = useState(userEmail);

  // Profile / identity state
  const [displayName, setDisplayName] = useState('');
  const [avatarIcon, setAvatarIcon] = useState('User');
  const [timezone, setTimezone] = useState('UTC');

  // Digest email state
  const [digestSending, setDigestSending] = useState(false);
  const [digestStatus, setDigestStatus] = useState<string | null>(null);

  // State for inputs
  const [profileUrl, setProfileUrl] = useState('');
  const [cvText, setCvText] = useState('');
  const [extraContext, setExtraContext] = useState('');
  const [messyThoughts, setMessyThoughts] = useState('');
  const [scanKeywords, setScanKeywords] = useState('');
  const [scanLocation, setScanLocation] = useState('Remote');
  const [dataLoaded, setDataLoaded] = useState(false);

  // ── Load all data from Supabase on mount ──────────────────────────
  useEffect(() => {
    async function loadAll() {
      try {
        const [profileData, strategyData, matchesData, shortlistedData, settingsData] = await Promise.all([
          db.loadProfile(userId),
          db.loadStrategy(userId),
          db.loadJobMatches(userId),
          db.loadShortlistedJobs(userId),
          db.loadSettings(userId),
        ]);
        if (profileData) {
          setProfile(profileData.profile);
          setProfileSources(profileData.sources);
        }
        if (strategyData) setStrategy(strategyData);
        setMatches(matchesData.filter(m => m.status !== 'accepted'));
        setShortlistedJobs(shortlistedData);
        setAutomationEnabled(settingsData.automationEnabled);
        setMatchThreshold(settingsData.matchThreshold);
        setScanKeywords(settingsData.scanKeywords);
        setScanLocation(settingsData.scanLocation || 'Remote');
        setDigestEmail(settingsData.digestEmail || userEmail);
        setDisplayName(settingsData.displayName);
        setAvatarIcon(settingsData.avatarIcon || 'User');
        // Use saved timezone; auto-detect and save if this is the first time
        const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const savedTz = settingsData.timezone;
        setTimezone(savedTz || detectedTz);
        if (!savedTz) {
          db.saveSettings(userId, { timezone: detectedTz });
        }
      } catch (e) {
        console.error('Failed to load data from Supabase:', e);
      } finally {
        setDataLoaded(true);
      }
    }
    loadAll();
  }, [userId]);

  const handleSynthesize = async () => {
    if (!profileUrl.trim() && !cvText.trim()) {
      alert('Please provide at least a LinkedIn URL or your CV text.');
      return;
    }
    setIsLoading(true);
    setLoadingText('MyCareerBrain synthesizing unified profile from sources...');
    try {
      const { profile: data, sources } = await synthesizeProfile(profileUrl, cvText, extraContext);
      setProfile(data);
      setProfileSources(sources);
      await db.saveProfile(userId, data, sources);
      setView('strategy');
    } catch (error: any) {
      console.error(error);
      const isRateLimit = error?.message?.includes('429');
      alert(isRateLimit 
        ? 'Rate limit hit. The Gemini API is currently busy. Please wait 60 seconds and try again.' 
        : 'Failed to synthesize profile. Please check your inputs and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefineStrategy = async () => {
    if (!messyThoughts.trim()) return;
    setIsLoading(true);
    setLoadingText('Magic Wand at work: Structuring your future...');
    try {
      const data = await refineStrategy(messyThoughts);
      setStrategy(data);
      await db.saveStrategy(userId, data);
      setView('scanner');
      if (data.priorities?.length > 0) setScanKeywords(data.priorities[0]);
    } catch (error: any) {
      console.error(error);
      const isRateLimit = error?.message?.includes('429');
      alert(isRateLimit ? 'API Quota Exceeded. Please try again in a moment.' : 'Failed to refine strategy.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleScan = async () => {
    if (!profile || !strategy) return;
    setIsLoading(true);
    setLoadingText('Searching across multiple job sources...');
    try {
      const keywords = scanKeywords || profile.skills?.[0] || 'software engineer';

      // Fetch from all three sources in parallel
      const [geminiJobs, arbeitsagenturJobs, jsearchJobs] = await Promise.all([
        fetchLiveJobs(keywords, scanLocation).catch((err) => {
          console.error('Gemini job fetch failed:', err);
          return [] as any[];
        }),
        fetchArbeitsagenturJobs(keywords, scanLocation).catch((err) => {
          console.error('Arbeitsagentur job fetch failed:', err);
          return [] as any[];
        }),
        fetchJSearchJobs(keywords, scanLocation).catch((err) => {
          console.error('JSearch job fetch failed:', err);
          return [] as any[];
        }),
      ]);

      // Tag Gemini results with their source
      const taggedGeminiJobs = geminiJobs.map((j: any) => ({ ...j, source: 'linkedin' }));

      const allJobs = [...taggedGeminiJobs, ...arbeitsagenturJobs, ...jsearchJobs];

      if (allJobs.length === 0) {
        alert('No jobs found from any source. Try different keywords or location.');
        setIsLoading(false);
        return;
      }

      setLoadingText(`Analyzing ${allJobs.length} jobs from ${[geminiJobs.length && 'LinkedIn', arbeitsagenturJobs.length && 'Arbeitsagentur', jsearchJobs.length && 'JSearch'].filter(Boolean).join(', ')}...`);

      // Serial processing instead of Promise.all to respect RPM (Requests Per Minute) limits
      const scoredResults: JobMatch[] = [];
      for (let i = 0; i < allJobs.length; i++) {
        setLoadingText(`Scoring match ${i + 1} of ${allJobs.length}...`);
        const result = await scoreJobMatch(profile, strategy, allJobs[i]);
        result.source = allJobs[i].source;
        scoredResults.push(result);
        // Subtle delay to avoid hitting rate limits on bursts
        if (i < allJobs.length - 1) await new Promise(r => setTimeout(r, 800));
      }

      const sorted = scoredResults.sort((a, b) => b.score - a.score);
      setMatches(sorted);
      await db.saveJobMatches(userId, sorted);
    } catch (error: any) {
      console.error(error);
      const isRateLimit = error?.message?.includes('429');
      alert(isRateLimit ? 'Scanner hit API limits. Retrying later is recommended.' : 'Scanning failed. Try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendDigest = async () => {
    setDigestSending(true);
    setDigestStatus(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setDigestStatus('Not authenticated. Please sign in again.');
        return;
      }
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-digest`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: digestEmail,
            threshold: matchThreshold,
            // test:true is implicit on the server for user-JWT calls,
            // but send it explicitly so it's clear in logs.
            test: true,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setDigestStatus(`Failed: ${data.error || 'Unknown error'}${data.details ? ` — ${JSON.stringify(data.details)}` : ''}`);
      } else if (data.success) {
        if (data.usedMockData) {
          setDigestStatus(`✓ Test email sent to ${data.sentTo} using mock data (no real scans in DB yet). Run a scan first to see real matches.`);
        } else if (data.matchCount === 0) {
          setDigestStatus(`✓ "No matches" email sent to ${data.sentTo}. [Threshold: ${data.threshold}% | Highest score in DB: ${data.highestScore ?? '?'}%]`);
        } else {
          setDigestStatus(`✓ Digest sent to ${data.sentTo} — ${data.matchCount} match${data.matchCount !== 1 ? 'es' : ''} above ${data.threshold}%`);
        }
      } else {
        setDigestStatus(data.message || data.error || 'Unexpected response.');
      }
    } catch (err: any) {
      setDigestStatus(`Error: ${err.message}`);
    } finally {
      setDigestSending(false);
    }
  };

  const handleAcceptJob = async (job: JobMatch) => {
    setShortlistedJobs(prev => [...prev, { ...job, status: 'accepted' }]);
    setMatches(prev => prev.filter(m => m.id !== job.id));
    await db.updateJobStatus(job.id, 'accepted');
  };

  const handleDismissJob = async (jobId: string) => {
    setMatches(prev => prev.filter(m => m.id !== jobId));
    await db.updateJobStatus(jobId, 'dismissed');
  };

  const handleRemoveFromShortlist = async (jobId: string) => {
    setShortlistedJobs(prev => prev.filter(m => m.id !== jobId));
    await db.updateJobStatus(jobId, 'pending');
  };

  const activeMatches = useMemo(() => {
    const shortlistedIds = new Set(shortlistedJobs.map(s => s.id));
    return matches.filter(m => !shortlistedIds.has(m.id));
  }, [matches, shortlistedJobs]);

  if (!dataLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex flex-col items-center gap-4">
          <Loader2 size={40} className="animate-spin" style={{ color: '#30003b' }} />
          <p className="text-slate-500 font-medium">Loading your data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-white selection:bg-[#11ccf5]/20 selection:text-[#30003b]">

      {/* Mobile overlay backdrop — shown when sidebar is open on small screens */}
      {isSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-20"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar — fixed overlay on mobile, static column on desktop */}
      <aside
        className={`
          fixed md:static top-0 bottom-0 left-0 z-30 flex flex-col shadow-2xl
          transition-all duration-500 ease-in-out
          ${isSidebarOpen
            ? 'w-64 translate-x-0'
            : '-translate-x-full md:translate-x-0 md:w-20'}
        `}
        style={{ background: 'linear-gradient(180deg, #30003b 0%, #1a0024 100%)' }}
      >
        <div className="p-5 flex items-center gap-3 min-h-[72px]">
          <img
            src="https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/W%26Blogo.png"
            alt="MyCareerBrain"
            className={`object-contain flex-shrink-0 transition-all duration-300 ${isSidebarOpen ? 'h-8 w-auto' : 'h-7 w-7'}`}
          />
          {isSidebarOpen && (
            <div className="animate-in fade-in slide-in-from-left-2 duration-300 min-w-0">
              <h1 className="text-sm leading-none text-white/90 uppercase tracking-widest truncate">MyCareerBrain</h1>
            </div>
          )}
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4 overflow-y-auto overflow-x-hidden custom-scrollbar">
          <NavItem 
            icon={<User size={20}/>} 
            label="Master Profile" 
            active={view === 'profile'} 
            expanded={isSidebarOpen} 
            onClick={() => setView('profile')} 
          />
          <NavItem 
            icon={<Target size={20}/>} 
            label="Search Strategy" 
            active={view === 'strategy'} 
            expanded={isSidebarOpen} 
            onClick={() => setView('strategy')} 
            disabled={!profile}
          />
          <NavItem 
            icon={<Briefcase size={20}/>} 
            label="Live Scanner" 
            active={view === 'scanner'} 
            expanded={isSidebarOpen} 
            onClick={() => setView('scanner')} 
            disabled={!strategy}
            badge={activeMatches.length > 0 ? activeMatches.length : undefined}
          />
          <NavItem 
            icon={<Settings size={20}/>} 
            label="Automation" 
            active={view === 'automation'} 
            expanded={isSidebarOpen} 
            onClick={() => setView('automation')} 
          />
          <NavItem 
            icon={<Clock size={20}/>} 
            label="History" 
            active={view === 'history'} 
            expanded={isSidebarOpen} 
            onClick={() => setView('history')} 
            badge={shortlistedJobs.length > 0 ? shortlistedJobs.length : undefined}
          />
        </nav>

        <div className="p-4 border-t border-white/10 space-y-2">
          {/* User identity chip */}
          <div className={`flex items-center gap-3 px-2 py-1.5 rounded-2xl ${isSidebarOpen ? '' : 'justify-center'}`}>
            <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                 style={{ background: 'rgba(17,204,245,0.2)', color: '#11ccf5' }}>
              {getAvatarIcon(avatarIcon, 16)}
            </div>
            {isSidebarOpen && (
              <p className="text-xs font-bold text-white/75 truncate flex-1 leading-tight">
                {displayName || userEmail}
              </p>
            )}
          </div>
          <button
            onClick={signOut}
            className="w-full flex items-center justify-center gap-2 p-2 rounded-xl text-white/40 hover:text-red-400 hover:bg-red-400/10 transition-all"
          >
            <LogOut size={16} />
            {isSidebarOpen && <span className="text-xs font-bold">Sign Out</span>}
          </button>
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="w-full flex items-center justify-center p-2 rounded-xl text-white/40 hover:text-white hover:bg-white/10 transition-all"
          >
            {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto relative bg-white">
        <header className="sticky top-0 z-10 glass border-b border-slate-200/60 px-4 md:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Hamburger — mobile only */}
            <button
              className="md:hidden p-2 rounded-xl text-slate-500 hover:bg-slate-100 transition-colors flex-shrink-0"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              aria-label="Toggle menu"
            >
              <Menu size={20} />
            </button>
            {/* Mobile logo strip — visible only when sidebar is hidden on mobile */}
            <img
              src="https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/W%26Blogo.png"
              alt="MyCareerBrain"
              className="md:hidden h-7 w-auto object-contain flex-shrink-0"
            />
            <div className="animate-in fade-in slide-in-from-top-2 duration-500">
              <h2 className="text-xl font-bold text-slate-900 capitalize tracking-tight">{view.replace('-', ' ')}</h2>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-widest mt-0.5 hidden sm:block">MyCareerBrain</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
             <div className="hidden md:flex flex-col items-end mr-2">
                <p className="text-xs font-bold text-slate-800 truncate max-w-[200px]">{displayName || userEmail}</p>
                <p className="text-[10px] font-bold flex items-center gap-1" style={{ color: '#11ccf5' }}><span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#11ccf5' }} /> Live Engine Active</p>
             </div>
             <div className="w-10 h-10 rounded-2xl border-2 border-white shadow-md flex items-center justify-center transition-transform hover:scale-105 cursor-pointer" style={{ background: '#30003b', color: 'white' }} onClick={() => setView('automation')}>
                {getAvatarIcon(avatarIcon, 20)}
             </div>
          </div>
        </header>

        <div className="max-w-6xl mx-auto p-8 pb-20">
          {view === 'profile' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-700">
              <section className="bg-white p-10 rounded-[2.5rem] shadow-xl shadow-slate-200/40 border border-slate-100 group">
                <div className="flex items-center gap-4 mb-8">
                  <div className="p-4 rounded-[1.25rem] transition-transform group-hover:scale-110 group-hover:rotate-3" style={{ background: 'rgba(48,0,59,0.06)', color: '#30003b' }}><Sparkles size={28} fill="currentColor" /></div>
                  <div>
                    <h3 className="text-2xl font-black text-slate-900">Synthesize Professional Intelligence</h3>
                    <p className="text-slate-500 font-medium">Combine multiple sources for a high-fidelity career analysis.</p>
                  </div>
                </div>
                
                <div className="space-y-6">
                  {/* LinkedIn URL Input */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 px-1">
                      <Linkedin size={14} style={{ color: '#30003b' }} /> LinkedIn Profile (Public Link)
                    </label>
                    <div className="relative">
                      <input 
                        type="text"
                        className="w-full pl-6 pr-6 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] transition-all outline-none bg-slate-50/50 text-slate-700 font-bold"
                        placeholder="https://linkedin.com/in/your-profile"
                        value={profileUrl}
                        onChange={(e) => setProfileUrl(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* CV / Bio Input */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 px-1">
                      <FileText size={14} style={{ color: '#30003b' }} /> CV or Professional Career Bio
                    </label>
                    <textarea 
                      className="w-full h-48 p-6 rounded-3xl border border-slate-200 focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] transition-all outline-none resize-none bg-slate-50/50 text-slate-700 font-medium text-sm leading-relaxed"
                      placeholder="Paste your CV text, or talk about your career journey in your own words..."
                      value={cvText}
                      onChange={(e) => setCvText(e.target.value)}
                    />
                  </div>

                  {/* Extra Context Input */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 px-1">
                      <PlusCircle size={14} style={{ color: '#30003b' }} /> Application Extras
                    </label>
                    <textarea 
                      className="w-full h-24 p-6 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] transition-all outline-none resize-none bg-slate-50/50 text-slate-700 font-medium text-sm leading-relaxed"
                      placeholder="Specify any extras you want considered (e.g., 'I speak fluent Spanish', 'Looking for roles with a heavy focus on mentorship')..."
                      value={extraContext}
                      onChange={(e) => setExtraContext(e.target.value)}
                    />
                  </div>

                  <div className="flex items-start gap-2 p-4 bg-amber-50 rounded-2xl border border-amber-100 text-amber-800 text-xs font-bold">
                    <Info size={16} className="mt-0.5 flex-shrink-0" />
                    <p>MyCareerBrain will cross-reference all provided data to identify trajectory patterns and hidden technical strengths.</p>
                  </div>
                </div>

                <div className="mt-10 flex items-center justify-between">
                  <div className="flex gap-2">
                    <div className="px-3 py-1.5 bg-slate-100 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-wider">Quota-Optimized Engine</div>
                    <div className="px-3 py-1.5 bg-slate-100 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-wider">Zero-Cost Infra</div>
                  </div>
                  <button
                    onClick={handleSynthesize}
                    disabled={isLoading || (!profileUrl.trim() && !cvText.trim())}
                    className="group relative overflow-hidden px-10 py-4 rounded-2xl font-bold transition-all disabled:opacity-40 shadow-lg hover:-translate-y-1 flex items-center gap-3"
                    style={{ background: '#11ccf5', color: '#30003b' }}
                    onMouseEnter={e => !isLoading && (e.currentTarget.style.background = '#0db8d9')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#11ccf5')}
                  >
                    <span className="relative z-10 font-black">{isLoading ? 'Synthesizing Intelligence...' : 'Build Unified Profile'}</span>
                    <ChevronRight size={18} className="relative z-10 transition-transform group-hover:translate-x-1" />
                  </button>
                </div>
              </section>

              {profile && (
                <div className="grid lg:grid-cols-3 gap-8 animate-in zoom-in-95 duration-1000">
                  <div className="lg:col-span-2 bg-white p-10 rounded-[2.5rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                    <div className="flex items-center justify-between mb-8">
                       <h4 className="font-black text-2xl text-slate-900 flex items-center gap-3">
                        <div className="w-1.5 h-8 rounded-full" style={{ background: '#30003b' }} />
                        {profile.name}
                      </h4>
                      <button className="p-2 text-slate-400 transition-colors" onMouseEnter={e => (e.currentTarget.style.color='#30003b')} onMouseLeave={e => (e.currentTarget.style.color='')}><Settings size={18}/></button>
                    </div>
                    <p className="text-lg text-slate-600 mb-10 leading-relaxed font-medium bg-slate-50 p-6 rounded-3xl border border-slate-100 italic">
                      "{profile.summary}"
                    </p>
                    <div className="space-y-8 relative">
                      <div className="absolute left-3 top-2 bottom-2 w-0.5 bg-slate-100" />
                      {profile.experience.map((exp, i) => (
                        <div key={i} className="relative pl-12 group/item">
                          <div className="absolute left-0 top-1 w-6 h-6 rounded-full bg-white border-4 group-hover/item:scale-125 transition-transform z-10" style={{ borderColor: '#30003b' }} />
                          <div className="flex justify-between items-start mb-1">
                            <h5 className="font-black text-slate-900 text-lg">{exp.role}</h5>
                          </div>
                          <p className="font-bold text-sm mb-3 tracking-wide" style={{ color: '#30003b' }}>{exp.company}</p>
                          <ul className="space-y-2">
                            {exp.highlights.map((h, j) => (
                              <li key={j} className="text-sm text-slate-500 font-medium flex gap-2">
                                <span className="text-slate-300 select-none">•</span>
                                {h}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-8">
                    <div className="text-white p-8 rounded-[2rem] shadow-2xl relative overflow-hidden group" style={{ background: '#30003b' }}>
                      <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full blur-3xl group-hover:scale-150 transition-transform duration-1000" style={{ background: 'rgba(17,204,245,0.1)' }} />
                      <h4 className="font-black text-lg mb-6 flex items-center gap-2 relative z-10 uppercase tracking-widest" style={{ color: '#11ccf5' }}>
                        <Sparkles size={20} fill="currentColor"/> Hidden Strengths
                      </h4>
                      <div className="flex flex-wrap gap-2 relative z-10">
                        {profile.hiddenStrengths.map((s, i) => (
                          <span key={i} className="px-4 py-2 bg-white/10 rounded-xl text-xs font-bold border border-white/10 hover:bg-white/20 transition-colors cursor-default">{s}</span>
                        ))}
                      </div>
                    </div>
                    <div className="bg-white p-8 rounded-[2rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                      <h4 className="font-black text-slate-900 mb-6 uppercase tracking-widest text-xs flex items-center gap-2">
                        <Zap size={16} style={{ color: '#11ccf5' }} /> Core Competencies
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {profile.skills.map((s, i) => (
                          <span key={i} className="px-3 py-1.5 rounded-lg text-xs font-bold hover:shadow-md transition-all cursor-default" style={{ background: 'rgba(48,0,59,0.06)', color: '#30003b', border: '1px solid rgba(48,0,59,0.1)' }}>{s}</span>
                        ))}
                      </div>
                    </div>
                    {profileSources.length > 0 && (
                      <div className="bg-white p-6 rounded-[2rem] border border-slate-100">
                        <h4 className="font-black text-slate-400 mb-4 uppercase tracking-widest text-[10px]">Scanned Sources</h4>
                        <ul className="space-y-2">
                          {profileSources.map((source, i) => (source.web?.uri || source.maps?.uri) && (
                            <li key={i}>
                              <a href={source.web?.uri || source.maps?.uri} target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold hover:underline flex items-center gap-1" style={{ color: '#30003b' }}>
                                <ExternalLink size={10} /> {source.web?.title || 'LinkedIn Profile'}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === 'strategy' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-700">
               <section className="bg-white p-10 rounded-[2.5rem] shadow-xl shadow-slate-200/40 border border-slate-100 relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-64 h-64 bg-amber-50 rounded-full -mr-32 -mt-32 blur-3xl opacity-50 transition-transform group-hover:scale-110 duration-1000" />
                <div className="flex items-center gap-4 mb-8 relative z-10">
                  <div className="p-4 bg-amber-50 text-amber-600 rounded-[1.25rem]"><Target size={28} /></div>
                  <div>
                    <h3 className="text-2xl font-black text-slate-900">Define Strategic Rules</h3>
                    <p className="text-slate-500 font-medium">The blueprint for your autonomous AI scout.</p>
                  </div>
                </div>
                
                <div className="relative z-10 group/input">
                  <textarea 
                    className="w-full h-40 p-6 pr-16 rounded-3xl border border-slate-200 focus:ring-4 focus:ring-amber-100 focus:border-amber-400 transition-all outline-none resize-none bg-slate-50/50 text-slate-700 font-medium leading-relaxed"
                    placeholder="E.g. I want B2B SaaS roles, Remote-only, German B2, Salary 100k+, no micro-management culture..."
                    value={messyThoughts}
                    onChange={(e) => setMessyThoughts(e.target.value)}
                  />
                  <button 
                    onClick={handleRefineStrategy}
                    disabled={isLoading || !messyThoughts.trim()}
                    className="absolute bottom-6 right-6 p-4 bg-slate-900 text-white rounded-2xl hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 hover:-translate-y-1 group/wand disabled:opacity-40"
                    title="Magic Wand"
                  >
                    {isLoading ? <Loader2 className="animate-spin" /> : <Sparkles className="group-hover/wand:rotate-12 transition-transform" size={24} />}
                  </button>
                </div>
              </section>

              {strategy && (
                <div className="grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-1000">
                  <div className="bg-white p-8 rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40">
                    <h4 className="font-black text-slate-900 mb-6 flex items-center gap-3 text-lg uppercase tracking-tight">
                      <div className="w-8 h-8 rounded-full bg-green-50 text-green-600 flex items-center justify-center"><CheckCircle2 size={18}/></div> 
                      Strategic Priorities
                    </h4>
                    <ul className="space-y-4">
                      {strategy.priorities.map((p, i) => (
                        <li key={i} className="flex gap-4 items-start p-4 bg-slate-50 rounded-2xl border border-slate-100 group/p">
                          <span className="w-6 h-6 bg-white text-slate-400 flex-shrink-0 flex items-center justify-center rounded-lg text-[10px] font-black border border-slate-200 group-hover/p:border-[#30003b] group-hover/p:text-[#30003b] transition-colors shadow-sm">{i+1}</span>
                          <span className="text-sm font-semibold text-slate-700 leading-tight">{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="bg-white p-8 rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40">
                    <h4 className="font-black text-slate-900 mb-6 flex items-center gap-3 text-lg uppercase tracking-tight">
                      <div className="w-8 h-8 rounded-full bg-red-50 text-red-600 flex items-center justify-center"><XCircle size={18}/></div> 
                      Hard Dealbreakers
                    </h4>
                    <ul className="space-y-4">
                      {strategy.dealbreakers.map((d, i) => (
                        <li key={i} className="flex gap-4 items-start p-4 bg-slate-50 rounded-2xl border border-slate-100 group/d">
                          <span className="w-6 h-6 bg-white text-slate-400 flex-shrink-0 flex items-center justify-center rounded-lg text-[10px] font-black border border-slate-200 group-hover/d:border-red-400 group-hover/d:text-red-600 transition-colors shadow-sm">X</span>
                          <span className="text-sm font-semibold text-slate-700 leading-tight">{d}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {view === 'scanner' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-700">
              <div className="flex flex-col md:flex-row items-center justify-between gap-6 bg-white p-8 rounded-[2rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                <div className="flex-1 w-full space-y-4">
                  <h3 className="text-2xl font-black text-slate-900">Opportunity Scanner</h3>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="relative group">
                      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-[#30003b] transition-colors" size={18} />
                      <input 
                        type="text" 
                        placeholder="Keywords (SaaS, Customer Success...)" 
                        className="w-full pl-12 pr-4 py-4 rounded-2xl border border-slate-100 bg-slate-50/50 text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 outline-none transition-all"
                        value={scanKeywords}
                        onChange={(e) => setScanKeywords(e.target.value)}
                      />
                    </div>
                    <div className="relative group">
                      <Target className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-[#30003b] transition-colors" size={18} />
                      <input 
                        type="text" 
                        placeholder="Location (Remote, Berlin...)" 
                        className="w-full pl-12 pr-4 py-4 rounded-2xl border border-slate-100 bg-slate-50/50 text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 outline-none transition-all"
                        value={scanLocation}
                        onChange={(e) => setScanLocation(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleScan}
                  disabled={isLoading}
                  className="w-full md:w-auto flex items-center justify-center gap-3 px-10 py-8 rounded-[2rem] font-black transition-all shadow-lg disabled:opacity-50 active:scale-95"
                  style={{ background: '#11ccf5', color: '#30003b' }}
                  onMouseEnter={e => { if (!isLoading) e.currentTarget.style.background = '#0db8d9'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = '#11ccf5')}
                >
                  {isLoading ? <Loader2 className="animate-spin" size={28} /> : <Zap size={28} fill="currentColor" />}
                  <div className="text-left">
                    <div className="text-sm">Run Deep</div>
                    <div className="text-lg leading-none">Scout Scan</div>
                  </div>
                </button>
              </div>

              {activeMatches.length === 0 && !isLoading && (
                <div className="flex flex-col items-center justify-center py-32 bg-white rounded-[3rem] border-2 border-dashed border-slate-200 text-slate-400 group">
                  <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <Briefcase size={40} className="opacity-20" />
                  </div>
                  <p className="font-black text-xl text-slate-600">No New Intelligence Gathered</p>
                  <p className="text-sm font-medium mt-2">Adjust your strategy or start a new scan above.</p>
                </div>
              )}

              {isLoading && (
                <div className="grid gap-6">
                  {[1,2,3].map(i => (
                    <div key={i} className="bg-white p-8 rounded-[2rem] border border-slate-100 shadow-sm animate-pulse">
                      <div className="h-8 w-1/3 bg-slate-100 rounded-lg mb-6" />
                      <div className="h-4 w-1/4 bg-slate-50 rounded-md mb-4" />
                      <div className="space-y-3">
                        <div className="h-4 w-full bg-slate-50 rounded-md" />
                        <div className="h-4 w-2/3 bg-slate-50 rounded-md" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-6">
                {activeMatches.map((match) => (
                  <JobCard 
                    key={match.id} 
                    match={match} 
                    onAccept={() => handleAcceptJob(match)}
                    onDismiss={() => handleDismissJob(match.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {view === 'automation' && (
            <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-700">

              {/* ── Profile / Identity section ─────────────────────────────── */}
              <section className="bg-white p-10 rounded-[3rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                <div className="flex items-center gap-4 mb-10">
                  <div className="p-4 rounded-2xl" style={{ background: 'rgba(48,0,59,0.06)', color: '#30003b' }}>
                    {getAvatarIcon(avatarIcon, 28)}
                  </div>
                  <div>
                    <h3 className="text-2xl font-black text-slate-900">Your Identity</h3>
                    <p className="text-slate-500 font-medium text-sm">How MyCareerBrain addresses you in digest emails.</p>
                  </div>
                </div>

                <div className="space-y-6">
                  {/* Display name */}
                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <div className="flex-1 mr-4">
                      <h4 className="font-bold text-slate-900">Display Name</h4>
                      <p className="text-xs text-slate-500">Used as the greeting in your morning digest email.</p>
                    </div>
                    <input
                      type="text"
                      className="w-48 px-4 py-3 rounded-2xl border border-slate-200 bg-white text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] outline-none transition-all"
                      placeholder="Your name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      onBlur={() => db.saveSettings(userId, { displayName })}
                    />
                  </div>

                  {/* Avatar picker */}
                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <div>
                      <h4 className="font-bold text-slate-900">Avatar Icon</h4>
                      <p className="text-xs text-slate-500">Shown in the sidebar and header.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {AVATAR_OPTIONS.map(opt => (
                        <button
                          key={opt.id}
                          title={opt.label}
                          onClick={() => { setAvatarIcon(opt.id); db.saveSettings(userId, { avatarIcon: opt.id }); }}
                          className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-all ${
                            avatarIcon === opt.id
                              ? 'text-white shadow-lg scale-110'
                              : 'bg-white border border-slate-200 text-slate-500 hover:border-[#30003b]/30 hover:text-[#30003b]'
                          }`}
                          style={avatarIcon === opt.id ? { background: '#30003b' } : {}}
                        >
                          {opt.icon}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Timezone */}
                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <div>
                      <h4 className="font-bold text-slate-900">Timezone</h4>
                      <p className="text-xs text-slate-500">Auto-detected · controls your 8:00 AM digest delivery.</p>
                    </div>
                    <select
                      className="w-64 px-4 py-3 rounded-2xl border border-slate-200 bg-white text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] outline-none cursor-pointer transition-all"
                      value={timezone}
                      onChange={(e) => { setTimezone(e.target.value); db.saveSettings(userId, { timezone: e.target.value }); }}
                    >
                      {COMMON_TIMEZONES.map(tz => (
                        <option key={tz.value} value={tz.value}>{tz.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              {/* ── Morning Digest section ─────────────────────────────────── */}
               <section className="bg-white p-10 rounded-[3rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                <div className="flex items-center gap-4 mb-10">
                  <div className="p-4 rounded-2xl" style={{ background: 'rgba(17,204,245,0.1)', color: '#30003b' }}><Mail size={28} /></div>
                  <div>
                    <h3 className="text-2xl font-black text-slate-900">Morning Digest Subscription</h3>
                    <p className="text-slate-500 font-medium text-sm">Automated background scanning &amp; email notifications.</p>
                  </div>
                </div>
                
                <div className="space-y-6">
                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <div>
                      <h4 className="font-bold text-slate-900">Enable Daily Scan</h4>
                      <p className="text-xs text-slate-500">MyCareerBrain will run every morning at 8:00 AM in your timezone.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={automationEnabled}
                        onChange={(e) => { setAutomationEnabled(e.target.checked); db.saveSettings(userId, { automationEnabled: e.target.checked }); }}
                      />
                      <div className="w-14 h-8 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-[#30003b]" style={{ '--tw-ring-color': 'rgba(17,204,245,0.3)' } as React.CSSProperties}></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <div>
                      <h4 className="font-bold text-slate-900">Match Threshold</h4>
                      <p className="text-xs text-slate-500">Only notify me for scores above <strong>{matchThreshold}%</strong>.</p>
                    </div>
                    <input
                      type="range"
                      className="w-32 accent-[#30003b]"
                      min={0}
                      max={100}
                      step={5}
                      value={matchThreshold}
                      onChange={(e) => { setMatchThreshold(Number(e.target.value)); db.saveSettings(userId, { matchThreshold: Number(e.target.value) }); }}
                    />
                  </div>

                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <div className="flex-1 mr-4">
                      <h4 className="font-bold text-slate-900">Digest Email</h4>
                      <p className="text-xs text-slate-500">Where to send your daily job digest.</p>
                    </div>
                    <input
                      type="email"
                      className="w-64 px-4 py-3 rounded-2xl border border-slate-200 bg-white text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] outline-none transition-all"
                      placeholder="your@email.com"
                      value={digestEmail}
                      onChange={(e) => setDigestEmail(e.target.value)}
                      onBlur={() => db.saveSettings(userId, { digestEmail })}
                    />
                  </div>

                  {automationEnabled && (
                    <div className="flex items-center gap-2 p-4 bg-green-50 rounded-2xl border border-green-100 text-green-800 text-xs font-bold">
                      <CheckCircle2 size={14} className="flex-shrink-0" />
                      <p>Next automated scan: <strong>8:00 AM {timezone}</strong>. Matches above {matchThreshold}% will be emailed to {digestEmail || 'your email'}.</p>
                    </div>
                  )}

                  <div className="p-8 text-white rounded-[2.5rem] shadow-2xl relative overflow-hidden" style={{ background: '#30003b' }}>
                    <div className="relative z-10">
                      <h4 className="text-xl font-black mb-2 flex items-center gap-2">
                        <Mail size={20} /> Send Digest Now
                      </h4>
                      <p className="text-sm mb-6 leading-relaxed" style={{ color: 'rgba(17,204,245,0.8)' }}>
                        Send a test digest email with your current matches above the threshold. Uses Resend via Supabase Edge Functions.
                      </p>
                      <button
                        onClick={handleSendDigest}
                        disabled={digestSending}
                        className="bg-white px-8 py-3 rounded-2xl font-black text-sm transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                        style={{ color: '#30003b' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(17,204,245,0.15)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                      >
                        {digestSending ? <><Loader2 size={16} className="animate-spin" /> Sending...</> : 'Send Test Digest'}
                      </button>
                      {digestStatus && (
                        <p className={`mt-4 text-sm font-bold ${digestStatus.startsWith('Failed') || digestStatus.startsWith('Error') || digestStatus.startsWith('Not') ? 'text-red-300' : 'text-green-300'}`}>
                          {digestStatus}
                        </p>
                      )}
                    </div>
                    <div className="absolute right-[-10%] top-[-20%] w-64 h-64 rounded-full blur-3xl" style={{ background: 'rgba(17,204,245,0.1)' }} />
                  </div>

                </div>
              </section>
            </div>
          )}

          {view === 'history' && (
            <div className="space-y-8 animate-in fade-in duration-1000">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-black text-slate-900">Shortlisted Intel</h3>
                  <p className="text-slate-500 font-medium">Your curated high-probability opportunities.</p>
                </div>
                {shortlistedJobs.length > 0 && (
                  <div className="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest" style={{ background: 'rgba(48,0,59,0.06)', color: '#30003b', border: '1px solid rgba(48,0,59,0.1)' }}>
                    {shortlistedJobs.length} Saved Matches
                  </div>
                )}
              </div>

              {shortlistedJobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-40">
                  <div className="p-8 rounded-full mb-8" style={{ background: 'rgba(48,0,59,0.06)', color: 'rgba(48,0,59,0.2)' }}>
                    <BookmarkCheck size={64} strokeWidth={1} />
                  </div>
                  <h3 className="text-2xl font-black text-slate-900 mb-2">Shortlist is Empty</h3>
                  <p className="text-slate-500 text-center max-w-sm font-medium">
                    Start scanning and "Accept" jobs to save them here for active applications.
                  </p>
                  <button className="mt-8 font-bold text-sm hover:underline" style={{ color: '#30003b' }} onClick={() => setView('scanner')}>
                    Go to live scanner
                  </button>
                </div>
              ) : (
                <div className="grid gap-6">
                  {shortlistedJobs.map((job) => (
                    <JobCard 
                      key={job.id} 
                      match={job} 
                      onDismiss={() => handleRemoveFromShortlist(job.id)}
                      isShortlisted
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {view === 'legal' && (
            <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-700">
              {/* Hobby Project Notice */}
              <div className="flex items-center gap-3 p-5 bg-amber-50 rounded-3xl border border-amber-100 text-amber-800 text-sm font-medium">
                <Info size={18} className="flex-shrink-0" />
                <p>This is a <strong>private hobby project</strong> and is not operated for commercial purposes. No revenue is generated through this application.</p>
              </div>

              {/* Impressum */}
              <section className="bg-white p-10 rounded-[3rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                <h3 className="text-2xl font-black text-slate-900 mb-6">Impressum</h3>
                <p className="text-sm text-slate-500 mb-4">Angaben gem&auml;&szlig; &sect; 5 TMG</p>
                <div className="text-slate-700 text-sm leading-relaxed space-y-1">
                  <p className="font-bold">Maria Alejandra Diaz Linde</p>
                  <p>Ob. Bismarckstra&szlig;e 93</p>
                  <p>70197 Stuttgart</p>
                  <p>Germany</p>
                </div>
                <h4 className="font-bold text-slate-900 mt-6 mb-2">Haftungsausschluss</h4>
                <p className="text-slate-600 text-sm leading-relaxed">
                  Dieses Projekt ist ein privates Hobbyprojekt und wird nicht gewerblich betrieben. Es werden keine Einnahmen erzielt. Trotz sorgf&auml;ltiger inhaltlicher Kontrolle &uuml;bernehme ich keine Haftung f&uuml;r die Inhalte externer Links. F&uuml;r den Inhalt der verlinkten Seiten sind ausschlie&szlig;lich deren Betreiber verantwortlich.
                </p>
              </section>

              {/* Datenschutzerkl&auml;rung */}
              <section className="bg-white p-10 rounded-[3rem] shadow-xl shadow-slate-200/40 border border-slate-100">
                <h3 className="text-2xl font-black text-slate-900 mb-6">Datenschutzerkl&auml;rung</h3>
                <p className="text-sm text-slate-500 mb-6">gem&auml;&szlig; Art. 13 DSGVO</p>

                <div className="space-y-6 text-slate-700 text-sm leading-relaxed">
                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">1. Verantwortliche Stelle</h4>
                    <p>Maria Alejandra Diaz Linde<br />Ob. Bismarckstra&szlig;e 93, 70197 Stuttgart, Germany</p>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">2. Art und Zweck der Datenverarbeitung</h4>
                    <p>
                      Diese Anwendung ist ein privates, nicht-kommerzielles Hobbyprojekt. Es werden folgende personenbezogene Daten verarbeitet:
                    </p>
                    <ul className="list-disc list-inside mt-2 space-y-1 text-slate-600">
                      <li><strong>E-Mail-Adresse</strong> &ndash; zur Authentifizierung und zum Versand von Job-Digest-E-Mails</li>
                      <li><strong>Profildaten</strong> (Name, Berufserfahrung, F&auml;higkeiten) &ndash; zur KI-gest&uuml;tzten Jobanalyse und -bewertung</li>
                      <li><strong>Sucheinstellungen</strong> (Suchbegriffe, Standort, Schwellenwerte) &ndash; zur Personalisierung der Jobsuche</li>
                      <li><strong>Job-Matches</strong> (Titel, Unternehmen, Bewertungen) &ndash; zur Anzeige und Verwaltung von Suchergebnissen</li>
                    </ul>
                    <p className="mt-2">
                      Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO (Einwilligung durch aktive Nutzung) und Art. 6 Abs. 1 lit. b DSGVO (Vertragserf&uuml;llung).
                    </p>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">3. Drittanbieter und Daten&uuml;bermittlung</h4>
                    <p>Folgende Drittanbieter werden genutzt:</p>
                    <ul className="list-disc list-inside mt-2 space-y-1 text-slate-600">
                      <li><strong>Supabase</strong> (Cloud-Datenbank &amp; Authentifizierung) &ndash; Speicherung der Nutzerdaten</li>
                      <li><strong>Google Gemini API</strong> &ndash; KI-basierte Profilanalyse und Jobbewertung</li>
                      <li><strong>Bundesagentur f&uuml;r Arbeit API</strong> &ndash; Abfrage &ouml;ffentlicher Stellenangebote</li>
                      <li><strong>JSearch / RapidAPI</strong> &ndash; Abfrage internationaler Stellenangebote</li>
                      <li><strong>Resend</strong> &ndash; Versand von E-Mail-Benachrichtigungen</li>
                    </ul>
                    <p className="mt-2">
                      Eine &Uuml;bermittlung in Drittl&auml;nder (z.B. USA) kann bei Nutzung dieser Dienste erfolgen. Grundlage hierf&uuml;r sind die jeweiligen Standardvertragsklauseln (SCCs) und angemessene Schutzma&szlig;nahmen der Anbieter.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">4. Speicherdauer</h4>
                    <p>
                      Ihre Daten werden gespeichert, solange Ihr Nutzerkonto besteht. Bei L&ouml;schung des Kontos werden alle zugeordneten Daten vollst&auml;ndig entfernt.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">5. Ihre Rechte</h4>
                    <p>Sie haben gem&auml;&szlig; DSGVO folgende Rechte:</p>
                    <ul className="list-disc list-inside mt-2 space-y-1 text-slate-600">
                      <li>Auskunftsrecht (Art. 15 DSGVO)</li>
                      <li>Recht auf Berichtigung (Art. 16 DSGVO)</li>
                      <li>Recht auf L&ouml;schung (Art. 17 DSGVO)</li>
                      <li>Recht auf Einschr&auml;nkung der Verarbeitung (Art. 18 DSGVO)</li>
                      <li>Recht auf Daten&uuml;bertragbarkeit (Art. 20 DSGVO)</li>
                      <li>Widerspruchsrecht (Art. 21 DSGVO)</li>
                    </ul>
                    <p className="mt-2">
                      Zur Aus&uuml;bung Ihrer Rechte wenden Sie sich bitte an die oben genannte verantwortliche Stelle.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">6. Cookies und Tracking</h4>
                    <p>
                      Diese Anwendung verwendet keine Tracking-Cookies, keine Analysetools und kein Werbetracking. Es werden lediglich technisch notwendige Session-Daten f&uuml;r die Authentifizierung gespeichert.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-900 mb-2">7. Beschwerderecht</h4>
                    <p>
                      Sie haben das Recht, sich bei einer Datenschutz-Aufsichtsbeh&ouml;rde zu beschweren. Zust&auml;ndige Beh&ouml;rde ist der Landesbeauftragte f&uuml;r den Datenschutz und die Informationsfreiheit Baden-W&uuml;rttemberg.
                    </p>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </main>

      {/* Fixed bottom footer — always visible, centered, with glass blur */}
      <footer
        className="fixed bottom-0 left-0 right-0 z-10 text-center py-2 px-4"
        style={{
          background: 'rgba(255,255,255,0.82)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderTop: '1px solid rgba(0,0,0,0.06)',
        }}
      >
        <p className="text-[11px] text-slate-400 leading-tight">
          <button
            onClick={() => setView('legal')}
            className="font-semibold transition-colors"
            onMouseEnter={e => (e.currentTarget.style.color = '#30003b')}
            onMouseLeave={e => (e.currentTarget.style.color = '')}
          >
            Impressum &amp; Datenschutz
          </button>
          <span className="mx-2 opacity-40">·</span>
          Maria Alejandra Diaz Linde · Stuttgart, Germany
        </p>
      </footer>

      {/* Loading Overlay */}
      {isLoading && view !== 'scanner' && (
        <div className="fixed inset-0 backdrop-blur-md z-50 flex flex-col items-center justify-center text-white p-8 text-center animate-in fade-in duration-300" style={{ background: 'rgba(48,0,59,0.75)' }}>
          <div className="bg-white p-12 rounded-[3.5rem] shadow-[0_0_100px_rgba(17,204,245,0.15)] flex flex-col items-center max-w-md relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1 bg-slate-100 overflow-hidden">
              <div className="h-full animate-progress w-full" style={{ background: '#11ccf5' }} />
            </div>
            <div className="w-20 h-20 rounded-[2rem] flex items-center justify-center mb-8 relative" style={{ background: 'rgba(17,204,245,0.08)' }}>
              <Loader2 size={40} className="animate-spin" style={{ color: '#30003b' }} />
              <div className="absolute inset-0 border-4 rounded-[2rem]" style={{ borderColor: 'rgba(17,204,245,0.2)' }} />
            </div>
            <h3 className="text-2xl font-black text-slate-900 mb-4 tracking-tight">{loadingText}</h3>
            <p className="text-slate-500 font-medium leading-relaxed">
              MyCareerBrain is accessing external profile data and cross-referencing strategic rules for a perfect match.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function AuthenticatedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex flex-col items-center gap-4">
          <Loader2 size={40} className="animate-spin" style={{ color: '#30003b' }} />
          <p className="text-slate-500 font-medium">Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  if (!user) return <AuthPage />;
  return <AppContent />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </ErrorBoundary>
  );
}

function NavItem({ icon, label, active, onClick, expanded, disabled, badge }: { icon: React.ReactNode, label: string, active?: boolean, onClick: () => void, expanded: boolean, disabled?: boolean, badge?: number }) {
  return (
    <button 
      onClick={onClick}
      disabled={disabled}
      className={`
        w-full flex items-center gap-3 p-4 rounded-2xl transition-all duration-300 relative group
        ${active ? 'text-[#11ccf5] shadow-none' : 'text-white/60 hover:bg-white/10 hover:text-white'}
        ${disabled ? 'opacity-20 cursor-not-allowed filter grayscale' : 'cursor-pointer'}
      `}
    >
      <div className={`transition-transform duration-300 ${active ? 'scale-110' : 'group-hover:scale-110 group-hover:rotate-6'}`}>{icon}</div>
      {expanded && <span className="font-bold text-sm whitespace-nowrap tracking-tight">{label}</span>}
      {badge !== undefined && expanded && (
        <span className={`ml-auto px-2 py-0.5 rounded-lg text-[10px] font-black ${active ? 'bg-[#11ccf5]/20 text-[#11ccf5]' : 'bg-white/20 text-white/80'}`}>
          {badge}
        </span>
      )}
      {active && <div className="absolute left-[-1rem] top-1/2 -translate-y-1/2 w-1 h-6 bg-[#11ccf5] rounded-r-full" />}
    </button>
  );
}

interface JobCardProps {
  match: JobMatch;
  onAccept?: () => void;
  onDismiss?: () => void;
  isShortlisted?: boolean;
}

function JobCard({ 
  match, 
  onAccept, 
  onDismiss, 
  isShortlisted 
}: JobCardProps) {
  const [expanded, setExpanded] = useState(false);

  const getScoreColor = (score: number) => {
    if (score >= 85) return 'text-green-600 bg-green-50 border-green-200 shadow-green-100';
    if (score >= 70) return 'text-amber-600 bg-amber-50 border-amber-200 shadow-amber-100';
    return 'text-red-600 bg-red-50 border-red-200 shadow-red-100';
  };

  return (
    <div className={`bg-white rounded-[2.5rem] border border-slate-100 shadow-xl shadow-slate-200/40 transition-all duration-500 overflow-hidden hover:shadow-2xl ${expanded ? 'scale-[1.02] border-[#30003b]/20' : ''}`}>
      <div className="p-8 flex items-start justify-between">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <h4 className="text-2xl font-black text-slate-900 tracking-tight leading-none">{match.title}</h4>
            <div className={`px-4 py-2 rounded-2xl border-2 text-sm font-black shadow-sm ${getScoreColor(match.score)}`}>
              {match.score}% Score
            </div>
            {match.source && (
              <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${
                match.source === 'arbeitsagentur' ? 'bg-blue-50 text-blue-600 border-blue-100' :
                match.source === 'jsearch' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                'bg-violet-50 text-violet-600 border-violet-100'
              }`}>
                {match.source === 'arbeitsagentur' ? 'Arbeitsagentur' : match.source === 'jsearch' ? 'JSearch' : 'LinkedIn'}
              </div>
            )}
            {isShortlisted && (
              <div className="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest" style={{ background: 'rgba(48,0,59,0.06)', color: '#30003b', border: '1px solid rgba(48,0,59,0.1)' }}>
                Shortlisted
              </div>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm font-bold">
            <p className="uppercase tracking-widest" style={{ color: '#30003b' }}>{match.company}</p>
            <div className="w-1 h-1 bg-slate-200 rounded-full" />
            <p className="text-slate-400">{match.location}</p>
          </div>
          
          <div className="mt-8 grid md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Strategic Pros</p>
              <div className="flex flex-wrap gap-2">
                {(match.reasoning.pros || []).map((pro, i) => (
                  <span key={i} className="px-3 py-1.5 bg-green-50 text-green-700 text-[11px] font-bold rounded-xl border border-green-100 flex items-center gap-1.5 shadow-sm">
                    <CheckCircle2 size={12}/> {pro}
                  </span>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Risk Analysis</p>
              <div className="flex flex-wrap gap-2">
                {(match.reasoning.cons || []).slice(0, 3).map((con, i) => (
                  <span key={i} className="px-3 py-1.5 bg-red-50 text-red-700 text-[11px] font-bold rounded-xl border border-red-100 flex items-center gap-1.5 shadow-sm">
                    <AlertCircle size={12}/> {con}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-8 flex items-center gap-4">
            {onAccept && (
              <button 
                onClick={(e) => { e.stopPropagation(); onAccept(); }}
                className="px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all shadow-md flex items-center gap-2"
                style={{ background: '#11ccf5', color: '#30003b' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#0db8d9')}
                onMouseLeave={e => (e.currentTarget.style.background = '#11ccf5')}
              >
                <BookmarkCheck size={14} />
                Save Match
              </button>
            )}
            <button 
              onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
              className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${isShortlisted ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}
            >
              <Trash2 size={14} />
              {isShortlisted ? 'Remove' : 'Dismiss'}
            </button>
            <a 
              href={match.link} 
              target="_blank" 
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="px-6 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-slate-50 transition-all flex items-center gap-2"
            >
              <ExternalLink size={14} />
              Original Post
            </a>
          </div>
        </div>
        
        <button 
          onClick={() => setExpanded(!expanded)}
          className={`p-4 rounded-2xl transition-all duration-300 ${expanded ? 'text-white rotate-180' : 'bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-[#30003b]'}`}
          style={expanded ? { background: '#30003b' } : {}}
        >
          <ChevronDown size={24} />
        </button>
      </div>

      {expanded && (
        <div className="px-8 pb-8 pt-4 border-t border-slate-50 animate-in slide-in-from-top-4 duration-500">
           <div className="grid lg:grid-cols-3 gap-8">
             <div className="lg:col-span-2 space-y-4">
                <h5 className="text-xs font-black text-slate-400 uppercase tracking-widest">Description Intel</h5>
                <div className="bg-slate-50 p-6 rounded-3xl text-sm text-slate-600 font-medium leading-relaxed border border-slate-100 max-h-64 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
                  {match.description}
                </div>
             </div>
             <div className="space-y-6">
                {(match.reasoning.riskFactors || []).length > 0 && (
                  <div className="space-y-3">
                    <h5 className="text-xs font-black text-slate-400 uppercase tracking-widest">AI Warnings</h5>
                    <div className="p-6 bg-amber-50 rounded-[2rem] text-amber-800 text-xs font-bold border border-amber-100 space-y-2 shadow-inner">
                      {match.reasoning.riskFactors.map((risk, i) => (
                        <div key={i} className="flex gap-2">
                          <AlertCircle size={14} className="flex-shrink-0" />
                          <span>{risk}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
             </div>
           </div>
        </div>
      )}
    </div>
  );
}
