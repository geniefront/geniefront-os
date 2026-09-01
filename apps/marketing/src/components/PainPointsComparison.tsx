import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { 
  XCircle, 
  CheckCircle2, 
  AlertTriangle, 
  Sparkles,
  ArrowRight,
  ShieldAlert
} from 'lucide-react';

export const PainPointsComparison: React.FC = () => {
  const { t, openTrialModal } = useLanguage();
  const cols = t.painPoints.columns;

  return (
    <section id="features" className="py-20 bg-slate-50 border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Title */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold uppercase tracking-wider mb-3">
            <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
            <span>{t.painPoints.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.painPoints.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.painPoints.subtitle}
          </p>
        </div>

        {/* 3-Column Comparison Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 items-stretch">
          {/* Column 1: Traditional Paper & WeChat */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center gap-2 text-rose-600 mb-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-bold text-lg text-slate-900">{cols.traditional.title}</h3>
              </div>
              <p className="text-xs text-slate-500 mb-6 leading-relaxed">
                {cols.traditional.desc}
              </p>
              <ul className="space-y-3.5 text-xs sm:text-sm text-slate-700">
                {cols.traditional.points.map((pt, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <XCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-8 pt-4 border-t border-slate-100 text-[11px] font-semibold text-center text-slate-400">
              High Operational Friction & Daily Stress
            </div>
          </div>

          {/* Column 2: Generic Western SaaS */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center gap-2 text-amber-600 mb-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-bold text-lg text-slate-900">{cols.genericSaas.title}</h3>
              </div>
              <p className="text-xs text-slate-500 mb-6 leading-relaxed">
                {cols.genericSaas.desc}
              </p>
              <ul className="space-y-3.5 text-xs sm:text-sm text-slate-700">
                {cols.genericSaas.points.map((pt, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <XCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-8 pt-4 border-t border-slate-100 text-[11px] font-semibold text-center text-slate-400">
              Expensive Per-Seat Penalties & Wrong Fit
            </div>
          </div>

          {/* Column 3: GenieFront OS (Hero Winner Column) */}
          <div className="rounded-2xl bg-gradient-to-b from-[#edf8f3] via-white to-white border-2 border-[#096b61] p-6 sm:p-7 flex flex-col justify-between text-slate-900 shadow-xl relative md:-translate-y-2">
            {/* Top Recommended Tag */}
            <div className="absolute -top-3.5 right-6 px-3 py-1 rounded-full bg-[#096b61] text-white text-[10px] font-extrabold tracking-wider uppercase shadow-md">
              Purpose-Built for Asian Shops
            </div>

            <div>
              <div className="flex items-center gap-2 text-[#096b61] mb-2">
                <Sparkles className="w-5 h-5 text-[#096b61]" />
                <h3 className="font-bold text-xl text-slate-900">{cols.geniefront.title}</h3>
              </div>
              <p className="text-xs text-slate-600 mb-6 leading-relaxed">
                {cols.geniefront.desc}
              </p>
              <ul className="space-y-3.5 text-xs sm:text-sm text-slate-800">
                {cols.geniefront.points.map((pt, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span className="font-medium">{pt}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-8 pt-5 border-t border-slate-200">
              <button
                id="comparison-start-trial-btn"
                onClick={() => openTrialModal()}
                className="w-full py-3 px-4 rounded-xl bg-[#096b61] hover:bg-[#064b46] text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-md shadow-[#096b61]/20 transition-all active:scale-98"
              >
                <span>{t.nav.startTrial}</span>
                <ArrowRight className="w-4 h-4 text-white" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
