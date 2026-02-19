import React from 'react';
import { Search, Mail, Sparkles, ChevronRight } from 'lucide-react';

const LOGO_URL = 'https://mfydmzdowjfitqpswues.supabase.co/storage/v1/object/public/public-assets/W&Blogo.png';

interface LandingPageProps {
  onGetStarted: () => void;
}

export default function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Nav ─────────────────────────────────────────────────────── */}
      <nav className="bg-[#30003b] px-4 md:px-6 py-3 md:py-4 flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-3">
          <img src={LOGO_URL} alt="MyCareerBrain" className="w-8 h-8 md:w-10 md:h-10 rounded-xl object-contain" />
          <span className="font-norwester text-lg md:text-xl text-white tracking-tight">MyCareerBrain</span>
        </div>
        <button
          onClick={onGetStarted}
          className="px-5 md:px-6 py-2.5 bg-[#11ccf5] text-[#30003b] rounded-xl font-bold text-sm hover:bg-[#0ea5c9] transition-colors"
        >
          Sign In
        </button>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="bg-[#30003b] text-white px-4 md:px-6 py-16 md:py-32 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#30003b] to-[#1a0020]" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#11ccf5]/5 rounded-full blur-3xl" />
        <div className="relative z-10 max-w-3xl mx-auto">
          <img src={LOGO_URL} alt="" className="w-16 h-16 md:w-20 md:h-20 rounded-2xl object-contain mx-auto mb-6 md:mb-8" />
          <h1 className="text-3xl md:text-5xl lg:text-6xl leading-tight mb-5 md:mb-6">
            <span className="text-[#11ccf5]">MyCareerBrain</span>
            <br />
            Stop scrolling. Start matching.
          </h1>
          <p className="text-base md:text-xl text-white/70 max-w-2xl mx-auto mb-8 md:mb-10 leading-relaxed font-light">
            AI-powered job scouting that scrapes, analyzes, and delivers
            personalized matches directly to your inbox &mdash; saving you
            hours of manual searching every single day.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onGetStarted}
              className="w-full sm:w-auto px-10 py-4 bg-[#11ccf5] text-[#30003b] rounded-2xl font-black text-lg hover:bg-[#0ea5c9] transition-all shadow-lg shadow-[#11ccf5]/20 flex items-center justify-center gap-2 active:scale-95"
            >
              Get Started <ChevronRight size={20} />
            </button>
            <button
              onClick={onGetStarted}
              className="w-full sm:w-auto px-10 py-4 border-2 border-white/20 text-white rounded-2xl font-bold text-lg hover:border-[#11ccf5] hover:text-[#11ccf5] transition-all"
            >
              Sign In
            </button>
          </div>
        </div>
      </section>

      {/* ── Benefits ────────────────────────────────────────────────── */}
      <section className="bg-white px-4 md:px-6 py-14 md:py-28">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-4xl text-center text-[#30003b] mb-3 md:mb-4">
            How It Works
          </h2>
          <p className="text-center text-slate-500 mb-10 md:mb-16 max-w-xl mx-auto text-sm md:text-base">
            Three simple steps to never miss a perfect opportunity again.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
            <BenefitCard
              icon={<Search size={28} />}
              title="Automated Scouting"
              description="Our AI agent scans job boards around the clock, so you don't have to. It works 24/7 while you focus on what matters."
            />
            <BenefitCard
              icon={<Sparkles size={28} />}
              title="Personalized Scoring"
              description="Every job is scored against your unique profile. You only see opportunities that actually fit your skills and career goals."
            />
            <BenefitCard
              icon={<Mail size={28} />}
              title="Daily Email Digests"
              description="Get your top matches delivered straight to your inbox each morning. Stay ahead of the competition with instant updates."
            />
          </div>
        </div>
      </section>

      {/* ── CTA Band ────────────────────────────────────────────────── */}
      <section className="bg-[#30003b] px-4 md:px-6 py-14 md:py-20 text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-4xl text-white mb-4">
            Ready to find your next role?
          </h2>
          <p className="text-white/60 mb-10 text-lg">
            Create a free account and let your AI career agent get to work.
          </p>
          <button
            onClick={onGetStarted}
            className="w-full sm:w-auto px-12 py-4 bg-[#11ccf5] text-[#30003b] rounded-2xl font-black text-lg hover:bg-[#0ea5c9] transition-all shadow-lg shadow-[#11ccf5]/20 active:scale-95"
          >
            Get Started for Free
          </button>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="bg-[#1a0020] px-4 md:px-6 py-4 flex flex-col md:flex-row items-center justify-center gap-1 md:gap-4 text-[10px] md:text-[11px] text-white/30">
        <span>Impressum &amp; Datenschutz</span>
        <span className="hidden md:inline">&middot;</span>
        <span>Maria Alejandra Diaz Linde &middot; Stuttgart, Germany</span>
      </footer>
    </div>
  );
}

function BenefitCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl md:rounded-[2rem] p-6 md:p-8 text-center hover:shadow-xl hover:shadow-[#11ccf5]/5 transition-all group">
      <div className="w-16 h-16 bg-[#11ccf5]/10 text-[#11ccf5] rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <h3 className="text-xl text-[#30003b] mb-3">{title}</h3>
      <p className="text-slate-500 text-sm leading-relaxed">{description}</p>
    </div>
  );
}
