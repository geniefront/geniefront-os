import React from 'react';
import { BedDouble, ArrowRight, CheckCircle2, AlertTriangle, ShieldAlert } from 'lucide-react';
import type { StepPreviewItem } from '@gf/contracts';

interface RoomStatusStepCardProps {
  step: StepPreviewItem;
  selected: boolean;
  onToggleSelect: (stepIndex: number, selected: boolean) => void;
  disabled?: boolean;
}

const STATUS_LABELS: Record<string, { label: string; bg: string; text: string }> = {
  available: { label: '空闲可用', bg: 'bg-emerald-100', text: 'text-emerald-800' },
  cleaning: { label: '清洁打扫中', bg: 'bg-amber-100', text: 'text-amber-800' },
  in_service: { label: '使用中', bg: 'bg-blue-100', text: 'text-blue-800' },
  maintenance: { label: '维护故障', bg: 'bg-zinc-200', text: 'text-zinc-800' },
};

export const RoomStatusStepCard: React.FC<RoomStatusStepCardProps> = ({
  step,
  selected,
  onToggleSelect,
  disabled = false,
}) => {
  const isReady = step.status === 'ready';
  const isConflict = step.status === 'conflict';
  const isInvalid = step.status === 'invalid';

  const roomName = String(step.details['roomName'] || step.summary);
  const currentStatus = String(step.details['currentStatus'] || '未知');
  const targetStatus = String(step.details['targetStatus'] || 'available');

  const curr = STATUS_LABELS[currentStatus] || {
    label: currentStatus,
    bg: 'bg-zinc-100',
    text: 'text-zinc-700',
  };
  const target = STATUS_LABELS[targetStatus] || {
    label: targetStatus,
    bg: 'bg-emerald-100',
    text: 'text-emerald-800',
  };

  return (
    <div
      className={`relative rounded-xl border p-3.5 transition-all duration-200 ${
        isConflict
          ? 'border-amber-300 bg-amber-50/40'
          : isInvalid
            ? 'border-rose-300 bg-rose-50/40'
            : selected
              ? 'border-blue-300/80 bg-white shadow-xs'
              : 'border-zinc-200 bg-zinc-50/50 opacity-75'
      }`}
    >
      <div className="flex items-center justify-between gap-2.5 mb-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled}
            onChange={(e) => onToggleSelect(step.stepIndex, e.target.checked)}
            className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-zinc-300 cursor-pointer disabled:opacity-50"
          />
          <div className="flex items-center gap-1.5 font-medium text-sm text-zinc-900">
            <BedDouble className="w-3.5 h-3.5 text-blue-600" />
            <span>{roomName}</span>
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
              冲突
            </span>
          )}
          {isInvalid && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 text-rose-800">
              <ShieldAlert className="w-3 h-3" />
              无效
            </span>
          )}
        </div>
      </div>

      {/* 状态变迁指示 */}
      <div className="flex items-center gap-2 pl-6 text-xs">
        <span className={`px-2 py-0.5 rounded-md font-medium ${curr.bg} ${curr.text}`}>
          {curr.label}
        </span>
        <ArrowRight className="w-3.5 h-3.5 text-zinc-400" />
        <span className={`px-2 py-0.5 rounded-md font-medium ${target.bg} ${target.text}`}>
          {target.label}
        </span>
      </div>

      {/* 错误提示 */}
      {step.issues && step.issues.length > 0 && (
        <div className="mt-2.5 ml-6 rounded-lg bg-rose-100/70 border border-rose-200/80 p-2 text-xs text-rose-900 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-700 shrink-0 mt-0.5" />
          <p className="font-medium">{step.issues.join('; ')}</p>
        </div>
      )}
    </div>
  );
};
