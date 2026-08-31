import React, { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { 
  Sparkles, 
  Camera, 
  Check, 
  RotateCcw, 
  ShieldAlert, 
  CheckCircle2, 
  ArrowRight,
  MessageSquare,
  FileCheck2,
  Lock,
  Layers
} from 'lucide-react';

interface AiCopilotShowcaseProps {
  onOpenMenuScanner: () => void;
}

export const AiCopilotShowcase: React.FC<AiCopilotShowcaseProps> = ({ onOpenMenuScanner }) => {
  const { t } = useLanguage();
  const [activeQueryIndex, setActiveQueryIndex] = useState(0);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const queries = t.aiSection.copilot.sampleQueries;

  const handleQuerySelect = (idx: number) => {
    setActiveQueryIndex(idx);
    setIsConfirmed(false);
    setFeedback(null);
  };

  const handleConfirmAction = () => {
    setIsConfirmed(true);
    setFeedback('✓ Action confirmed by Front Desk: System schedule updated and staff PWA notified.');
  };

  const handleUndoAction = () => {
    setIsConfirmed(false);
    setFeedback('↺ Action undone: Schedule restored to previous state.');
  };

  return (
    <section id="ai-features" className="py-20 bg-slate-50 border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t.aiSection.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.aiSection.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.aiSection.subtitle}
          </p>
        </div>

        {/* 2 Big Feature Pillar Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">
          {/* Pillar 1: AI Photo Menu Onboarding */}
          <div className="rounded-3xl bg-white border border-slate-200 p-7 sm:p-8 flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
                  <Camera className="w-6 h-6" />
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                  {t.aiSection.menuOnboarding.badge}
                </span>
              </div>

              <h3 className="text-2xl font-bold text-slate-900 mb-2">
                {t.aiSection.menuOnboarding.title}
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-6">
                {t.aiSection.menuOnboarding.desc}
              </p>

              <ul className="space-y-3 text-xs sm:text-sm text-slate-700 mb-6">
                {t.aiSection.menuOnboarding.points.map((pt, idx) => (
                  <li key={idx} className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Menu Scanner Simulation Trigger */}
            <div className="pt-5 border-t border-slate-100">
              <button
                id="open-menu-scanner-btn"
                onClick={onOpenMenuScanner}
                className="w-full py-3.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-md transition-all active:scale-98"
              >
                <Camera className="w-4 h-4 text-blue-300" />
                <span>{t.aiSection.menuOnboarding.tryScanBtn}</span>
              </button>
            </div>
          </div>

          {/* Pillar 2: AI Front Desk Copilot */}
          <div className="rounded-3xl bg-white border-2 border-blue-600/80 p-7 sm:p-8 text-slate-900 flex flex-col justify-between shadow-lg">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <MessageSquare className="w-6 h-6" />
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                  {t.aiSection.copilot.badge}
                </span>
              </div>

              <h3 className="text-2xl font-bold text-slate-900 mb-2">
                {t.aiSection.copilot.title}
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-4">
                {t.aiSection.copilot.desc}
              </p>

              {/* Sample Natural Language Prompts */}
              <div className="mb-4">
                <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  Interactive Front Desk Questions:
                </div>
                <div className="space-y-1.5">
                  {queries.map((q, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleQuerySelect(idx)}
                      className={`w-full text-left p-2.5 rounded-xl text-xs transition-all border ${
                        activeQueryIndex === idx
                          ? 'bg-blue-50 text-blue-700 border-blue-400 font-medium'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100/70'
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              {/* AI Proposal Card Simulation */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-blue-700 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                    AI Copilot Proposal (Awaiting Click)
                  </span>
                  <span className="text-amber-700 font-mono text-[10px] bg-amber-50 px-2 py-0.5 rounded border border-amber-200 font-semibold">No Direct DB Write</span>
                </div>

                <p className="text-xs text-slate-800 bg-white p-2.5 rounded-lg border border-slate-200 leading-relaxed shadow-2xs">
                  {activeQueryIndex === 0 && 'Lily V. (Turn 1.0) is next for 60m Massage. Room 2 is sanitized and ready.'}
                  {activeQueryIndex === 1 && 'Suite B (Double Room) is open from 2:00 PM to 3:30 PM with Kevin & May.'}
                  {activeQueryIndex === 2 && 'Set Helen T. on 30 min meal break. Turn priority #2 preserved for 12:45 PM.'}
                  {activeQueryIndex === 3 && 'Today: 14 Walk-ins ($1,120) • 18 Appointments ($1,740) • Total: $2,860.'}
                </p>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleConfirmAction}
                      disabled={isConfirmed}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
                        isConfirmed
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-blue-600 hover:bg-blue-700 text-white active:scale-95 shadow-xs'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{isConfirmed ? 'Confirmed ✓' : 'Confirm Action'}</span>
                    </button>
                    <button
                      onClick={handleUndoAction}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1.5 active:scale-95 transition-colors shadow-2xs"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
                      <span>Undo</span>
                    </button>
                  </div>
                </div>

                {feedback && (
                  <div className="text-[11px] text-emerald-800 font-medium p-2 rounded bg-emerald-50 border border-emerald-200">
                    {feedback}
                  </div>
                )}
              </div>
            </div>

            {/* Strict Safety Notice Callout */}
            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
              <Lock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>{t.aiSection.humanInLoopNotice}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
