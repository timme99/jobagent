import React, { useState } from 'react';
import { Mail, Lock, Loader2, AlertCircle, Brain, Target, Zap, CheckCircle2 } from 'lucide-react';
import { useAuth } from './AuthProvider';

const LOGO = 'https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/W%26Blogo.png';

const FEATURES = [
  {
    icon: Brain,
    title: 'Deep Career Intelligence',
    body: 'AI synthesises your CV, LinkedIn and goals into a single, high-fidelity career profile.',
  },
  {
    icon: Target,
    title: 'Precision Job Scoring',
    body: 'Every role is scored against your real priorities and dealbreakers — not just keywords.',
  },
  {
    icon: Zap,
    title: 'Zero-Effort Daily Digest',
    body: 'Top matches land in your inbox at 8 AM in your timezone. No dashboard-checking required.',
  },
  {
    icon: CheckCircle2,
    title: 'Autonomous Strategy Engine',
    body: 'Define your rules once. The Brain handles sourcing, filtering and ranking from then on.',
  },
];

export default function AuthPage() {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      if (isSignUp) {
        const { error: err } = await signUp(email, password);
        if (err) setError(err);
        else setSuccessMsg('Check your email for a confirmation link!');
      } else {
        const { error: err } = await signIn(email, password);
        if (err) setError(err);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    const { error: err } = await signInWithGoogle();
    if (err) setError(err);
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row">

      {/* ── LEFT — Brand / pitch panel ─────────────────────────────── */}
      <div className="relative flex-1 flex flex-col px-10 py-12 overflow-hidden"
           style={{ background: 'linear-gradient(145deg, #30003b 0%, #1a0024 100%)' }}>

        {/* Decorative glows */}
        <div className="absolute -top-40 -right-40 w-[28rem] h-[28rem] rounded-full pointer-events-none"
             style={{ background: 'radial-gradient(circle, rgba(17,204,245,0.12) 0%, transparent 70%)' }} />
        <div className="absolute -bottom-24 -left-24 w-72 h-72 rounded-full pointer-events-none"
             style={{ background: 'radial-gradient(circle, rgba(17,204,245,0.07) 0%, transparent 70%)' }} />

        {/* Logo */}
        <div className="relative z-10 mb-14">
          <img
            src={LOGO}
            alt="MyCareerBrain"
            className="h-11 w-auto object-contain"
            onError={(e) => {
              const el = e.target as HTMLImageElement;
              el.style.display = 'none';
              const fb = document.createElement('span');
              fb.className = 'text-white font-heading text-2xl tracking-wide';
              fb.textContent = 'MyCareerBrain';
              el.parentNode?.appendChild(fb);
            }}
          />
        </div>

        {/* Headline */}
        <div className="relative z-10 flex-1 flex flex-col justify-center max-w-lg">
          <h1 className="text-[3.5rem] md:text-[4.5rem] leading-[1.05] text-white mb-5">
            Your Career,<br />
            <span style={{ color: '#11ccf5' }}>Outsmarted.</span>
          </h1>
          <p className="text-white/65 text-lg leading-relaxed mb-12" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
            MyCareerBrain is your autonomous AI career agent — it learns who you are,
            scouts the market every morning, and delivers only the roles worth your time.
          </p>

          {/* Feature list */}
          <ul className="space-y-6">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-start gap-4">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
                     style={{ background: 'rgba(17,204,245,0.15)' }}>
                  <Icon size={17} style={{ color: '#11ccf5' }} />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm leading-tight mb-0.5">{title}</p>
                  <p className="text-white/55 text-sm leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Impressum footer — pinned to bottom of left panel */}
        <div className="relative z-10 mt-14 pt-6 border-t border-white/10">
          <p className="text-white/30 text-xs leading-relaxed">
            © 2025 MyCareerBrain &middot; Maria Alejandra Diaz Linde &middot; Stuttgart, Germany
          </p>
          <p className="text-white/25 text-xs mt-1">
            A private, non-commercial hobby project. &middot;{' '}
            <a href="#impressum" className="underline hover:text-white/50 transition-colors">
              Impressum &amp; Datenschutz
            </a>
          </p>
        </div>
      </div>

      {/* ── RIGHT — Auth form ───────────────────────────────────────── */}
      <div className="flex items-center justify-center bg-white px-8 py-16 md:w-[460px] md:flex-shrink-0">
        <div className="w-full max-w-sm">

          {/* Mobile-only logo */}
          <div className="md:hidden flex justify-center mb-10">
            <img src={LOGO} alt="MyCareerBrain" className="h-10 w-auto" />
          </div>

          <h2 className="text-[2rem] leading-tight mb-1" style={{ color: '#30003b' }}>
            {isSignUp ? 'Get Started' : 'Welcome Back'}
          </h2>
          <p className="text-slate-500 text-sm mb-8">
            {isSignUp
              ? 'Create your MyCareerBrain account'
              : 'Sign in to your career dashboard'}
          </p>

          {/* Google OAuth */}
          <button
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-3 py-3.5 px-5 rounded-2xl border-2 border-slate-200 bg-white text-slate-700 font-semibold text-sm transition-all mb-6"
            style={{ transition: 'border-color 0.2s' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#30003b55')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '')}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
              <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332Z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.166 6.656 3.58 9 3.58Z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-slate-100" />
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">or</span>
            <div className="flex-1 h-px bg-slate-100" />
          </div>

          {/* Email / password form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-11 pr-4 py-3.5 rounded-2xl border-2 border-slate-200 bg-slate-50/60 text-slate-800 text-sm outline-none transition-all"
                style={{ '--tw-ring-color': 'rgba(17,204,245,0.2)' } as React.CSSProperties}
                onFocus={e => { e.currentTarget.style.borderColor = '#11ccf5'; e.currentTarget.style.boxShadow = '0 0 0 4px rgba(17,204,245,0.12)'; }}
                onBlur={e  => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
              <input
                type="password"
                placeholder="Password (min. 6 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-11 pr-4 py-3.5 rounded-2xl border-2 border-slate-200 bg-slate-50/60 text-slate-800 text-sm outline-none transition-all"
                onFocus={e => { e.currentTarget.style.borderColor = '#11ccf5'; e.currentTarget.style.boxShadow = '0 0 0 4px rgba(17,204,245,0.12)'; }}
                onBlur={e  => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 rounded-xl text-red-700 text-xs font-semibold border border-red-100">
                <AlertCircle size={14} className="flex-shrink-0" />
                {error}
              </div>
            )}
            {successMsg && (
              <div className="flex items-center gap-2 p-3 bg-green-50 rounded-xl text-green-700 text-xs font-semibold border border-green-100">
                <Mail size={14} className="flex-shrink-0" />
                {successMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 text-white rounded-2xl font-bold text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: '#30003b', boxShadow: '0 8px 24px rgba(48,0,59,0.25)' }}
              onMouseEnter={e => !loading && (e.currentTarget.style.background = '#1a0024')}
              onMouseLeave={e => (e.currentTarget.style.background = '#30003b')}
            >
              {loading
                ? <Loader2 size={18} className="animate-spin" />
                : (isSignUp ? 'Create Account' : 'Sign In')}
            </button>
          </form>

          <p className="text-center mt-6 text-sm text-slate-500">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              onClick={() => { setIsSignUp(!isSignUp); setError(null); setSuccessMsg(null); }}
              className="font-bold transition-colors"
              style={{ color: '#30003b' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#11ccf5')}
              onMouseLeave={e => (e.currentTarget.style.color = '#30003b')}
            >
              {isSignUp ? 'Sign In' : 'Sign Up Free'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
