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
  const stepIcons = [UserCheck, Smartphone, Sparkles, Bed, CheckCircle2, CreditCard, FileSpreadsheet];
  const labels = {
    en: { progress: 'Day progress', event: 'Live operation event', synced: 'Front desk, staff and room state synchronized' },
    'zh-CN': { progress: '营业进度', event: '实时运营事件', synced: '前台、员工端与房间状态已同步' },
    vi: { progress: 'Tiến độ ngày', event: 'Sự kiện vận hành', synced: 'Đã đồng bộ lễ tân, nhân viên và phòng' },
    ko: { progress: '영업 진행률', event: '실시간 운영 이벤트', synced: '프런트, 직원, 룸 상태 동기화 완료' },
    es: { progress: 'Progreso del día', event: 'Evento operativo', synced: 'Recepción, personal y salas sincronizados' },
  }[currentLang];
  const ActiveIcon = stepIcons[activeStep] ?? Clock;
  const progress = Math.round(((activeStep + 1) / steps.length) * 100);

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
        <div className="relative mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
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
              {React.createElement(stepIcons[i] ?? Clock, { className: `mb-2 h-4 w-4 ${activeStep === i ? 'text-white' : 'text-[#096b61]'}` })}
              <div className={`text-[10px] font-mono font-bold ${activeStep === i ? 'text-white/80' : 'text-[#096b61]'}`}>
                {st.time}
              </div>
              <div className="text-xs font-bold truncate mt-0.5">{st.title}</div>
            </button>
          ))}
        </div>

        {/* Selected Step Spotlight Card */}
        <div className="demo-window">
          <div className="demo-window-bar"><div className="flex items-center gap-3"><span className="demo-icon bg-[#102a2e] text-white"><Clock className="h-4 w-4" /></span><div><div className="text-xs font-extrabold text-[#20383b]">{labels.progress}</div><div className="mt-1 text-[9px] font-bold text-[#708184]">{progress}% · {steps[activeStep].time}</div></div></div><div className="h-1.5 w-28 overflow-hidden rounded-full bg-[#e4eae5] sm:w-48"><div className="h-full rounded-full bg-[#096b61] transition-all duration-500" style={{ width: `${progress}%` }} /></div></div>
          <div className="p-6 sm:p-8 lg:p-10">
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

              <div key={activeStep} className="demo-result-enter"><span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[#edf8f3] text-[#096b61]"><ActiveIcon className="h-5 w-5" /></span><h3 className="text-2xl font-bold text-slate-900">{steps[activeStep].title}</h3><p className="mt-3 text-sm sm:text-base text-slate-600 leading-relaxed">{steps[activeStep].desc}</p></div>

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

            <div key={`event-${activeStep}`} className="demo-result-enter lg:col-span-4 rounded-2xl bg-[#102a2e] border border-[#26494c] p-5 text-white shadow-xl">
              <div className="text-[11px] font-bold text-[#096b61] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <span className="demo-pulse h-2 w-2 rounded-full bg-[#55c3a5]" />
                <span className="text-[#7de0c3]">{labels.event}</span>
              </div>
              <div className="mt-4 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-white/10"><ActiveIcon className="h-4 w-4 text-[#7de0c3]" /></span><div><div className="text-xs font-extrabold">{steps[activeStep].title}</div><div className="mt-1 text-[9px] font-bold text-white/50">{steps[activeStep].time} · {steps[activeStep].actor}</div></div></div>
              <div className="mt-5 rounded-xl border border-white/10 bg-white/[.05] p-3 text-[10px] font-semibold leading-5 text-white/70"><CheckCircle2 className="mb-2 h-4 w-4 text-[#55c3a5]" />{labels.synced}</div>
            </div>
          </div>
          </div>
        </div>
      </div>
    </section>
  );
};
