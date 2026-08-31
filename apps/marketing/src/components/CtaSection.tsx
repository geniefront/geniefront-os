import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { Sparkles, ArrowRight, ShieldCheck, Play } from 'lucide-react';

export const CtaSection: React.FC = () => {
  const { t, openTrialModal } = useLanguage();

  const handleScrollToDemo = () => {
    const el = document.getElementById('hero-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <section className="py-20 bg-slate-50/80 border-t border-slate-200">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <div className="rounded-3xl bg-blue-600 border border-blue-500 p-8 sm:p-12 lg:p-16 text-white shadow-xl relative overflow-hidden">
          {/* Subtle Ambient Glow */}
          <div className="absolute top-0 right-1/4 w-96 h-96 bg-white/10 rounded-full blur-3xl pointer-events-none" />

          <div className="relative z-10 space-y-6 max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/15 border border-white/20 text-blue-100 text-xs font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Built for Asian-Owned Shops in the US</span>
            </div>

            <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-white tracking-tight leading-[1.2]">
              {t.cta.title}
            </h2>

            <p className="text-sm sm:text-base text-blue-100 leading-relaxed max-w-2xl mx-auto">
              {t.cta.subtitle}
            </p>

            <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3.5">
              <button
                id="bottom-cta-trial-btn"
                onClick={() => openTrialModal()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-xl bg-white hover:bg-slate-50 text-blue-700 font-bold text-sm sm:text-base shadow-lg transition-all active:scale-98"
              >
                <span>{t.cta.button}</span>
                <ArrowRight className="w-4 h-4 text-blue-600" />
              </button>

              <button
                id="bottom-cta-demo-btn"
                onClick={handleScrollToDemo}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-blue-700/80 hover:bg-blue-700 text-white border border-blue-400/40 font-semibold text-sm sm:text-base transition-colors"
              >
                <Play className="w-4 h-4 text-white fill-white/20" />
                <span>{t.cta.bookDemo}</span>
              </button>
            </div>

            <div className="flex items-center justify-center gap-2 text-xs text-blue-100/90 pt-2">
              <ShieldCheck className="w-4 h-4 text-blue-200" />
              <span>{t.cta.termsNotice}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
