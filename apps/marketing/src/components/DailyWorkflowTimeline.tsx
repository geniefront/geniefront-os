import React, { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';
import { 
  Clock, 
  Sparkles, 
  UserCheck, 
  Smartphone, 
  Bed, 
  CreditCard, 
  FileSpreadsheet,
  CheckCircle2,
  ChevronRight
} from 'lucide-react';

export const DailyWorkflowTimeline: React.FC = () => {
  const { t, currentLang } = useLanguage();
  const ui = uiText[currentLang];
  const [activeStep, setActiveStep] = useState(0);

  const steps = t.workflow.steps;

  return (
    <section id="how-it-works" className="py-20 bg-slate-50/70 border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#edf8f3] border border-[#b9d6cc] text-[#096b61] text-xs font-bold uppercase tracking-wider mb-3">
            <Clock className="w-3.5 h-3.5" />
            <span>{t.workflow.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.workflow.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.workflow.subtitle}
          </p>
        </div>

        {/* Interactive Step Navigator */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-8">
          {steps.map((st, i) => (
            <button
              key={i}
              id={`timeline-step-${i}`}
              onClick={() => setActiveStep(i)}
              className={`p-3 rounded-xl border text-left transition-all ${
                activeStep === i
                  ? 'bg-[#096b61] text-white border-[#096b61] shadow-md shadow-[#096b61]/15'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <div className={`text-[10px] font-mono font-bold ${activeStep === i ? 'text-white/80' : 'text-[#096b61]'}`}>
                {st.time}
              </div>
              <div className="text-xs font-bold truncate mt-0.5">{st.title}</div>
            </button>
          ))}
        </div>

        {/* Selected Step Spotlight Card */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 lg:p-10 shadow-sm">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-8 space-y-4">
              <div className="flex items-center gap-3">
                <span className="px-3 py-1 rounded-full bg-[#edf8f3] text-[#096b61] font-mono font-bold text-xs border border-[#b9d6cc]">
                  {steps[activeStep].time}
                </span>
                <span className="text-xs font-semibold text-slate-500">
                  {ui.role}: <strong className="text-slate-900">{steps[activeStep].actor}</strong>
                </span>
              </div>

              <h3 className="text-2xl font-bold text-slate-900">
                {steps[activeStep].title}
              </h3>

              <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                {steps[activeStep].desc}
              </p>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => setActiveStep((prev) => (prev > 0 ? prev - 1 : steps.length - 1))}
                  className="px-3.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700 border border-slate-200 transition-colors"
                >
                  ← {ui.previousStep}
                </button>
                <button
                  onClick={() => setActiveStep((prev) => (prev < steps.length - 1 ? prev + 1 : 0))}
                  className="px-3.5 py-2 rounded-lg bg-[#096b61] hover:bg-[#064b46] text-xs font-bold text-white flex items-center gap-1.5 shadow-xs transition-colors"
                >
                  <span>{ui.nextStep}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-white" />
                </button>
              </div>
            </div>

            <div className="lg:col-span-4 rounded-2xl bg-slate-50 border border-slate-200 p-5 text-slate-900">
              <div className="text-[11px] font-bold text-[#096b61] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                {ui.operationalImpact}
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                {steps[activeStep].desc}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
