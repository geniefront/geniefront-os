import React, { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';
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
  const { t, currentLang } = useLanguage();
  const ui = uiText[currentLang];
  const [activeQueryIndex, setActiveQueryIndex] = useState(0);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const labels = {
    en: { pipeline: 'AI import pipeline', ready: 'Ready', steps: ['Capture', 'Extract', 'Approve'], context: 'Context', contextValue: 'Live queue', policy: 'Policy', policyValue: 'Human review', audit: 'Audit', auditValue: 'Logged' },
    'zh-CN': { pipeline: 'AI 菜单导入流程', ready: '可以开始', steps: ['拍摄', '识别', '审核'], context: '业务上下文', contextValue: '实时队列', policy: '执行策略', policyValue: '人工审核', audit: '审计记录', auditValue: '全程留痕' },
    vi: { pipeline: 'Quy trình nhập AI', ready: 'Sẵn sàng', steps: ['Chụp', 'Trích xuất', 'Duyệt'], context: 'Ngữ cảnh', contextValue: 'Hàng đợi trực tiếp', policy: 'Chính sách', policyValue: 'Người duyệt', audit: 'Kiểm toán', auditValue: 'Đã ghi lại' },
    ko: { pipeline: 'AI 메뉴 가져오기', ready: '준비됨', steps: ['촬영', '추출', '승인'], context: '업무 문맥', contextValue: '실시간 대기열', policy: '실행 정책', policyValue: '사람 검토', audit: '감사 기록', auditValue: '기록됨' },
    es: { pipeline: 'Flujo de importación con IA', ready: 'Listo', steps: ['Capturar', 'Extraer', 'Aprobar'], context: 'Contexto', contextValue: 'Cola en vivo', policy: 'Política', policyValue: 'Revisión humana', audit: 'Auditoría', auditValue: 'Registrado' },
  }[currentLang];

  const queries = t.aiSection.copilot.sampleQueries;
  const proposalResponses = [
    t.heroPreview.sampleProposal,
    t.industries.items[1]?.desc,
    t.workflow.steps[2]?.desc,
    t.pricing.perLocationNotice,
  ];

  const handleQuerySelect = (idx: number) => {
    setActiveQueryIndex(idx);
    setIsConfirmed(false);
    setFeedback(null);
  };

  const handleConfirmAction = () => {
    setIsConfirmed(true);
    setFeedback(t.heroPreview.confirmedMessage);
  };

  const handleUndoAction = () => {
    setIsConfirmed(false);
    setFeedback(t.heroPreview.undoneMessage);
  };

  return (
    <section id="ai-features" className="py-20 bg-slate-50 border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#edf8f3] border border-[#b9d6cc] text-[#096b61] text-xs font-bold uppercase tracking-wider mb-3">
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
          <div className="demo-window flex flex-col justify-between p-7 sm:p-8">
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

              <div className="mb-6 overflow-hidden rounded-2xl border border-[#dfe5df] bg-[#f7f8f3]">
                <div className="flex items-center justify-between border-b border-[#dfe5df] bg-white px-4 py-3"><span className="demo-panel-title"><Layers className="h-4 w-4 text-[#e86f37]" />{labels.pipeline}</span><span className="demo-status"><span className="demo-status-dot" />{labels.ready}</span></div>
                <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 p-4 text-center">
                  {[{ icon: Camera, label: '01', text: labels.steps[0] }, { icon: Sparkles, label: '02', text: labels.steps[1] }, { icon: FileCheck2, label: '03', text: labels.steps[2] }].map((step, index) => <React.Fragment key={step.label}><div className="rounded-xl border border-[#dfe5df] bg-white p-3"><step.icon className="mx-auto h-4 w-4 text-[#096b61]" /><div className="mt-2 text-[8px] font-extrabold text-[#8a9998]">{step.label}</div><div className="text-[9px] font-extrabold text-[#20383b]">{step.text}</div></div>{index < 2 && <ArrowRight className="h-3.5 w-3.5 text-[#9aa9a7]" />}</React.Fragment>)}
                </div>
              </div>

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
                <Camera className="w-4 h-4 text-[#a6ead6]" />
                <span>{t.aiSection.menuOnboarding.tryScanBtn}</span>
              </button>
            </div>
          </div>

          {/* Pillar 2: AI Front Desk Copilot */}
          <div className="demo-window flex flex-col justify-between border-2 border-[#096b61] p-7 text-slate-900 sm:p-8">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-2xl bg-[#edf8f3] text-[#096b61] flex items-center justify-center">
                  <MessageSquare className="w-6 h-6" />
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-[#edf8f3] text-[#096b61] border border-[#b9d6cc]">
                  {t.aiSection.copilot.badge}
                </span>
              </div>

              <h3 className="text-2xl font-bold text-slate-900 mb-2">
                {t.aiSection.copilot.title}
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-4">
                {t.aiSection.copilot.desc}
              </p>

              <div className="mb-4 grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-[#dfe5df] bg-[#f7f8f3] p-2.5"><div className="text-[8px] font-bold uppercase text-[#8a9998]">{labels.context}</div><div className="mt-1 text-[10px] font-extrabold text-[#20383b]">{labels.contextValue}</div></div>
                <div className="rounded-xl border border-[#dfe5df] bg-[#f7f8f3] p-2.5"><div className="text-[8px] font-bold uppercase text-[#8a9998]">{labels.policy}</div><div className="mt-1 text-[10px] font-extrabold text-[#20383b]">{labels.policyValue}</div></div>
                <div className="rounded-xl border border-[#dfe5df] bg-[#f7f8f3] p-2.5"><div className="text-[8px] font-bold uppercase text-[#8a9998]">{labels.audit}</div><div className="mt-1 text-[10px] font-extrabold text-[#20383b]">{labels.auditValue}</div></div>
              </div>

              {/* Sample Natural Language Prompts */}
              <div className="mb-4">
                <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  {t.aiSection.copilot.badge}
                </div>
                <div className="space-y-1.5">
                  {queries.map((q, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleQuerySelect(idx)}
                      aria-pressed={activeQueryIndex === idx}
                      className={`w-full text-left p-2.5 rounded-xl text-xs transition-all border ${
                        activeQueryIndex === idx
                          ? 'bg-[#edf8f3] text-[#096b61] border-[#80b9a8] font-medium'
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
                  <span className="font-bold text-[#096b61] flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                    {t.heroPreview.copilotProposalTitle}
                  </span>
                  <span className="text-amber-700 font-mono text-[10px] bg-amber-50 px-2 py-0.5 rounded border border-amber-200 font-semibold">{ui.noDirectWrite}</span>
                </div>

                <p key={activeQueryIndex} className="demo-result-enter text-xs text-slate-800 bg-white p-3 rounded-lg border border-slate-200 leading-relaxed shadow-2xs">
                  {proposalResponses[activeQueryIndex]}
                </p>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleConfirmAction}
                      disabled={isConfirmed}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
                        isConfirmed
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-[#096b61] hover:bg-[#064b46] text-white active:scale-95 shadow-xs'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{isConfirmed ? `${ui.confirmed} ✓` : ui.confirmAction}</span>
                    </button>
                    <button
                      onClick={handleUndoAction}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1.5 active:scale-95 transition-colors shadow-2xs"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
                      <span>{ui.undo}</span>
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
