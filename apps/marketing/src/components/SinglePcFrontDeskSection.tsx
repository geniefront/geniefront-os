import React from 'react';
import { useLanguage } from '../context/LanguageContext';
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
  const { t, openTrialModal } = useLanguage();

  const stepIcons = [Search, UserCheck, PlusCircle, DollarSign];

  return (
    <section id="single-pc" className="py-20 bg-white border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider mb-3">
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
                className="p-6 rounded-2xl bg-slate-50/70 border border-slate-200 shadow-2xs hover:border-blue-300 hover:shadow-xs transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="w-12 h-12 rounded-2xl bg-blue-100/80 text-blue-700 flex items-center justify-center mb-4">
                    <Icon className="w-6 h-6" />
                  </div>
                  <h3 className="font-bold text-base text-slate-900 mb-2">{step.title}</h3>
                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                    {step.desc}
                  </p>
                </div>
                <div className="mt-6 pt-3 border-t border-slate-200/80 text-[11px] font-bold text-blue-600 flex items-center gap-1">
                  <span>Fast Desktop Hotkeys</span>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Single PC Operational Guarantee Callout */}
        <div className="rounded-2xl bg-blue-50/60 border border-blue-200 p-6 sm:p-8 text-slate-900 flex flex-col sm:flex-row items-center justify-between gap-6 shadow-xs">
          <div className="space-y-1 text-center sm:text-left">
            <h4 className="text-lg font-bold text-slate-900 flex items-center justify-center sm:justify-start gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-600" />
              Zero Hardware Dependency
            </h4>
            <p className="text-xs sm:text-sm text-slate-600 max-w-xl">
              No need to buy 10 iPads or force your therapists to buy new phones. Everything can be operated smoothly from your existing front desk Windows or Mac desktop.
            </p>
          </div>
          <button
            id="single-pc-trial-cta"
            onClick={() => openTrialModal()}
            className="shrink-0 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-md transition-all active:scale-98"
          >
            {t.nav.startTrial}
          </button>
        </div>
      </div>
    </section>
  );
};
