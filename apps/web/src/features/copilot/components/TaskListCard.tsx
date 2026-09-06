import React from 'react';
import {
  Sparkles,
  Layers,
  CheckCheck,
  XSquare,
  Play,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import type { PreviewPayload, StepPreviewItem } from '@gf/contracts';
import { AppointmentStepCard } from './AppointmentStepCard';
import { RoomStatusStepCard } from './RoomStatusStepCard';

interface TaskListCardProps {
  taskId: string;
  preview: PreviewPayload;
  revision: number;
  selectedStepIndices: number[];
  onToggleSelectStep: (stepIndex: number, selected: boolean) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onUpdateTime: (stepIndex: number, newStartsAt: string) => void;
  onExecute: () => void;
  isExecuting?: boolean;
  isRevising?: boolean;
  executed?: boolean;
}

export const TaskListCard: React.FC<TaskListCardProps> = ({
  preview,
  revision,
  selectedStepIndices,
  onToggleSelectStep,
  onSelectAll,
  onDeselectAll,
  onUpdateTime,
  onExecute,
  isExecuting = false,
  isRevising = false,
  executed = false,
}) => {
  const steps = preview.steps;
  const totalCount = steps.length;
  const selectedCount = selectedStepIndices.length;

  const selectedSteps = steps.filter((s) => selectedStepIndices.includes(s.stepIndex));
  const hasSelectedConflicts = selectedSteps.some((s) => s.status !== 'ready');
  const canExecuteNow = selectedCount > 0 && !hasSelectedConflicts && !isExecuting && !executed;

  // 渲染单步
  const renderStep = (step: StepPreviewItem) => {
    const isSelected = selectedStepIndices.includes(step.stepIndex);

    if (step.command === 'appointment.create' || step.command === 'appointment.createBatch') {
      return (
        <AppointmentStepCard
          key={step.stepIndex}
          step={step}
          selected={isSelected}
          disabled={isExecuting || executed || isRevising}
          onToggleSelect={onToggleSelectStep}
          onUpdateTime={onUpdateTime}
        />
      );
    }

    if (step.command === 'resource.setStatus') {
      return (
        <RoomStatusStepCard
          key={step.stepIndex}
          step={step}
          selected={isSelected}
          disabled={isExecuting || executed || isRevising}
          onToggleSelect={onToggleSelectStep}
        />
      );
    }

    // 通用回退卡片
    return (
      <div
        key={step.stepIndex}
        className={`rounded-xl border p-3 text-xs transition-all ${
          isSelected ? 'border-zinc-300 bg-white' : 'border-zinc-200 bg-zinc-50 opacity-75'
        }`}
      >
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isSelected}
            disabled={isExecuting || executed || isRevising}
            onChange={(e) => onToggleSelectStep(step.stepIndex, e.target.checked)}
            className="w-4 h-4 rounded text-zinc-800"
          />
          <span className="font-medium text-zinc-900">{step.summary}</span>
        </label>
      </div>
    );
  };

  return (
    <div className="rounded-2xl border border-zinc-200/90 bg-white shadow-md overflow-hidden my-3">
      {/* 方案头部 */}
      <div className="bg-gradient-to-r from-zinc-50 via-white to-zinc-50 border-b border-zinc-100 p-3.5">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-teal-50 text-teal-600">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h4 className="font-semibold text-zinc-900 text-sm">{preview.title}</h4>
              <p className="text-zinc-500 text-xs mt-0.5">{preview.summary}</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-100 text-zinc-600 border border-zinc-200/60">
              <Layers className="w-3 h-3 text-zinc-400" />
              v{revision}
            </span>
            {preview.executionMode === 'atomic' ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-50 text-purple-700 border border-purple-200/60">
                整体原子性
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60">
                独立批次执行
              </span>
            )}
          </div>
        </div>

        {/* 快捷批量选择操作条 */}
        <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-zinc-100/80 text-xs">
          <div className="flex items-center gap-2 text-zinc-500 font-medium">
            <span>已选: {selectedCount} / {totalCount} 步</span>
            {isRevising && (
              <span className="inline-flex items-center gap-1 text-teal-600 text-[11px]">
                <Loader2 className="w-3 h-3 animate-spin" />
                重新校验中...
              </span>
            )}
          </div>

          {!executed && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={isExecuting || isRevising}
                onClick={onSelectAll}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 transition-colors cursor-pointer disabled:opacity-50"
              >
                <CheckCheck className="w-3 h-3 text-zinc-500" />
                全选
              </button>
              <button
                type="button"
                disabled={isExecuting || isRevising}
                onClick={onDeselectAll}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 transition-colors cursor-pointer disabled:opacity-50"
              >
                <XSquare className="w-3 h-3 text-zinc-500" />
                全撤
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 步骤列表 */}
      <div className="p-3 space-y-2.5 max-h-[380px] overflow-y-auto">
        {steps.map(renderStep)}
      </div>

      {/* 底部操作区 */}
      <div className="bg-zinc-50/80 border-t border-zinc-100 p-3 flex flex-col gap-2">
        {hasSelectedConflicts && (
          <div className="flex items-center gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200/80 rounded-lg p-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>选中的步骤中包含冲突项，请先调整时段或取消勾选该步骤后执行。</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-zinc-500">
            {executed ? (
              <span className="text-emerald-700 font-medium flex items-center gap-1">
                ✓ 方案已确认并成功执行
              </span>
            ) : (
              <span>点击右侧按钮提交命令总线执行</span>
            )}
          </div>

          {!executed && (
            <button
              type="button"
              disabled={!canExecuteNow}
              onClick={onExecute}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold shadow-sm transition-all cursor-pointer ${
                canExecuteNow
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white hover:shadow-md'
                  : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
              }`}
            >
              {isExecuting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>执行中...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>确认执行所选 ({selectedCount})</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
