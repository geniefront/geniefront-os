import React from 'react';
import { User, Sparkles, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import type { StepPreviewItem } from '@gf/contracts';
import { InteractiveTimePicker } from './InteractiveTimePicker';

interface AppointmentStepCardProps {
  step: StepPreviewItem;
  selected: boolean;
  onToggleSelect: (stepIndex: number, selected: boolean) => void;
  onUpdateTime: (stepIndex: number, newStartsAt: string) => void;
  disabled?: boolean;
}

export const AppointmentStepCard: React.FC<AppointmentStepCardProps> = ({
  step,
  selected,
  onToggleSelect,
  onUpdateTime,
  disabled = false,
}) => {
  const isConflict = step.status === 'conflict';
  const isInvalid = step.status === 'invalid';
  const isReady = step.status === 'ready';

  const customerName = step.details.customerName || '未指定客户';
  const serviceName = step.details.serviceName || step.summary;
  const staffName = step.details.staffName || '自动/未指定技师';
  const priceDollars =
    step.details.priceCents !== undefined
      ? `$${(step.details.priceCents / 100).toFixed(2)}`
      : null;

  return (
    <div
      className={`relative rounded-xl border p-3.5 transition-all duration-200 ${
        isConflict
          ? 'border-amber-300 bg-amber-50/40'
          : isInvalid
            ? 'border-rose-300 bg-rose-50/40'
            : selected
              ? 'border-emerald-300/80 bg-white shadow-xs'
              : 'border-zinc-200 bg-zinc-50/50 opacity-75'
      }`}
    >
      {/* 头部：复选框、客户名、状态标签 */}
      <div className="flex items-center justify-between gap-2.5 mb-2.5">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled}
            onChange={(e) => onToggleSelect(step.stepIndex, e.target.checked)}
            className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 border-zinc-300 cursor-pointer disabled:opacity-50"
          />
          <div className="flex items-center gap-1.5 font-medium text-sm text-zinc-900">
            <User className="w-3.5 h-3.5 text-zinc-500" />
            <span>{customerName}</span>
          </div>
        </label>

        <div>
          {isReady && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-800">
              <CheckCircle2 className="w-3 h-3" />
              已就绪
            </span>
          )}
          {isConflict && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
              <AlertTriangle className="w-3 h-3" />
              冲突 (可调时或剔除)
            </span>
          )}
          {isInvalid && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 text-rose-800">
              <ShieldAlert className="w-3 h-3" />
              校验未过
            </span>
          )}
        </div>
      </div>

      {/* 中部：项目名与技师 */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600 mb-2 pl-6">
        <div className="font-medium text-zinc-800 flex items-center gap-1">
          <span>{serviceName}</span>
          {priceDollars && (
            <span className="text-zinc-400 font-normal">({priceDollars})</span>
          )}
        </div>

        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 text-zinc-700 font-medium">
          <Sparkles className="w-3 h-3 text-purple-600" />
          <span>{staffName}</span>
        </div>
      </div>

      {/* 底部：时钟选择器胶囊 */}
      <div className="flex items-center justify-between pl-6 text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-400 text-[11px]">预约时段:</span>
          <InteractiveTimePicker
            currentIso={step.details.startsAt}
            displayTime={step.details.timeDisplay}
            disabled={disabled}
            onSelectTime={(newIso) => onUpdateTime(step.stepIndex, newIso)}
          />
        </div>
      </div>

      {/* 冲突或错误警告栏 */}
      {step.issues && step.issues.length > 0 && (
        <div className="mt-2.5 ml-6 rounded-lg bg-amber-100/70 border border-amber-200/80 p-2 text-xs text-amber-900 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">{step.issues.join('; ')}</p>
            {step.suggestedFix && (
              <p className="text-amber-800 text-[11px] mt-0.5">建议：{step.suggestedFix}</p>
            )}
            {isConflict && (
              <p className="text-amber-700 text-[10px] mt-1">
                提示：若暂不安排该顾客，可取消上方复选框直接执行其余预约。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
