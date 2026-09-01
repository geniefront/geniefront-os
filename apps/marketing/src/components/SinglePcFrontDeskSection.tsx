import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';
import { 
  Monitor, 
  Search, 
  UserCheck, 
  PlusCircle, 
  DollarSign, 
  CheckCircle2, 
  ArrowRight,
  ShieldCheck
} from 'lucide-react';

export const SinglePcFrontDeskSection: React.FC = () => {
  const { t, currentLang, openTrialModal } = useLanguage();
  const ui = uiText[currentLang];

  const stepIcons = [Search, UserCheck, PlusCircle, DollarSign];

  return (
    <section id="single-pc" className="py-20 bg-white border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#edf8f3] border border-[#b9d6cc] text-[#096b61] text-xs font-bold uppercase tracking-wider mb-3">
            <Monitor className="w-3.5 h-3.5" />
            <span>{t.singlePcSection.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.singlePcSection.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.singlePcSection.subtitle}
          </p>
        </div>

        {/* 4 Core Steps on Single PC */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          {t.singlePcSection.steps.map((step, idx) => {
            const Icon = stepIcons[idx] || Monitor;
            return (
              <div
                key={idx}
                className="p-6 rounded-2xl bg-slate-50/70 border border-slate-200 shadow-2xs hover:border-[#b9d6cc] hover:shadow-xs transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="w-12 h-12 rounded-2xl bg-[#d9f2e8]/80 text-[#096b61] flex items-center justify-center mb-4">
                    <Icon className="w-6 h-6" />
                  </div>
                  <h3 className="font-bold text-base text-slate-900 mb-2">{step.title}</h3>
                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                    {step.desc}
                  </p>
                </div>
                <div className="mt-6 pt-3 border-t border-slate-200/80 text-[11px] font-bold text-[#096b61] flex items-center gap-1">
                  <span>{ui.desktopShortcuts}</span>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Single PC Operational Guarantee Callout */}
        <div className="rounded-2xl bg-[#edf8f3]/70 border border-[#b9d6cc] p-6 sm:p-8 text-slate-900 flex flex-col sm:flex-row items-center justify-between gap-6 shadow-xs">
          <div className="space-y-1 text-center sm:text-left">
            <h4 className="text-lg font-bold text-slate-900 flex items-center justify-center sm:justify-start gap-2">
              <ShieldCheck className="w-5 h-5 text-[#096b61]" />
              {t.singlePcSection.badge}
            </h4>
            <p className="text-xs sm:text-sm text-slate-600 max-w-xl">
              {t.singlePcSection.desc}
            </p>
          </div>
          <button
            id="single-pc-trial-cta"
            onClick={() => openTrialModal()}
            className="shrink-0 px-6 py-3 rounded-xl bg-[#096b61] hover:bg-[#064b46] text-white font-bold text-xs sm:text-sm shadow-md transition-all active:scale-98"
          >
            {t.nav.startTrial}
          </button>
        </div>
      </div>
    </section>
  );
};
