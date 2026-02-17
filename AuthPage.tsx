import React, { useState } from 'react';
import { Mail, Lock, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from './AuthProvider';

const LOGO_URL = 'https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/W&Blogo.png';

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
        if (err) { setError(err); }
        else { setSuccessMsg('Check your email for a confirmation link!'); }
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
    <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-10">
          <img src={LOGO_URL} alt="MyCareerBrain" className="w-12 h-12 rounded-xl object-contain" />
          <div>
            <h1 className="font-norwester text-2xl tracking-tight text-[#30003b]">MyCareerBrain</h1>
            <span className="text-[10px] font-medium text-slate-500">Stop scrolling. Start matching.</span>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white p-10 rounded-[2.5rem] shadow-xl shadow-slate-200/40 border border-slate-100">
          <h2 className="text-2xl font-black text-slate-900 text-center mb-2">
            {isSignUp ? 'Create Your Account' : 'Welcome Back'}
          </h2>
          <p className="text-sm text-slate-500 text-center mb-8 font-medium">
            {isSignUp ? 'Start your AI-powered job search' : 'Sign in to your Scout dashboard'}
          </p>

          {/* Google Button */}
          <button
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-3 py-4 px-6 rounded-2xl border border-slate-200 bg-white text-slate-700 font-bold text-sm hover:bg-slate-50 hover:border-slate-300 transition-all mb-6"
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
          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1 h-px bg-slate-100" />
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">or</span>
            <div className="flex-1 h-px bg-slate-100" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-12 pr-4 py-4 rounded-2xl border border-slate-200 bg-slate-50/50 text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] outline-none transition-all"
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-12 pr-4 py-4 rounded-2xl border border-slate-200 bg-slate-50/50 text-slate-700 font-bold text-sm focus:ring-4 focus:ring-[#11ccf5]/20 focus:border-[#11ccf5] outline-none transition-all"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-4 bg-red-50 rounded-2xl text-red-700 text-xs font-bold border border-red-100">
                <AlertCircle size={14} className="flex-shrink-0" />
                {error}
              </div>
            )}

            {successMsg && (
              <div className="flex items-center gap-2 p-4 bg-green-50 rounded-2xl text-green-700 text-xs font-bold border border-green-100">
                <Mail size={14} className="flex-shrink-0" />
                {successMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold text-sm hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 disabled:opacity-50 flex items-center justify-center gap-2 group relative overflow-hidden"
            >
              <span className="relative z-10">
                {loading ? <Loader2 size={18} className="animate-spin" /> : (isSignUp ? 'Create Account' : 'Sign In')}
              </span>
              <div className="absolute inset-0 bg-gradient-to-r from-[#11ccf5] to-[#0ea5c9] opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          </form>

          {/* Toggle */}
          <p className="text-center mt-6 text-sm text-slate-500 font-medium">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              onClick={() => { setIsSignUp(!isSignUp); setError(null); setSuccessMsg(null); }}
              className="text-[#11ccf5] font-bold hover:underline"
            >
              {isSignUp ? 'Sign In' : 'Sign Up'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
