/**
 * 「AI 正在思考」的过程折叠条。
 *
 * 流式进行时默认展开并高亮最新一步，结束后收起成一行「思考了 N 步」。
 * 前台真正关心的是「它是不是卡住了」，所以进行中只突出**最新那一步**，
 * 而不是把七八行滚动日志堆在她眼前。
 */

import React, { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';

export function ThinkingAccordion({ steps, isStreaming }: { steps?: string[]; isStreaming?: boolean }) {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(isStreaming ?? false);

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
    }
  }, [isStreaming]);

  if (!steps || steps.length === 0) {
    if (!isStreaming) return null;
  }

  const cleanStep = (s: string) => s.replace(/\s*\(第\s*\d+(\/\d+)?\s*轮\)/g, '').trim();
  const latestStep = steps && steps.length > 0 ? cleanStep(steps[steps.length - 1]) : t('schedule.copilotThinking');

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl border border-teal-500/30 bg-gradient-to-r from-teal-500/10 via-emerald-500/5 to-transparent text-xs transition-all shadow-2xs">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-medium text-teal-800 hover:bg-teal-500/10 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 overflow-hidden">
          {isStreaming ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-600"></span>
            </span>
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-600 text-[10px] text-white font-bold">
              ✓
            </span>
          )}
          <span className="truncate text-[11px] font-semibold text-slate-700">
            {isStreaming ? (
              <span className="text-teal-700 font-bold">{latestStep}</span>
            ) : (
              <span>{t('schedule.copilotThinkingPrefix')}{steps?.length || 0}  {t('schedule.copilotThinkingSuffix')}</span>
            )}
          </span>
        </div>
        <ChevronRight
          className={`h-3.5 w-3.5 text-teal-600 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-90' : ''
          }`}
        />
      </button>

      {isOpen && steps && steps.length > 0 && (
        <div className="border-t border-teal-500/20 px-3 py-2 space-y-1.5 bg-white/60">
          {steps.map((st, idx) => (
            <div key={idx} className="flex items-center gap-2 text-[11px] text-slate-600 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500 shrink-0" />
              <span className="truncate">{cleanStep(st)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
