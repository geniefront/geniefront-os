import { useState, useCallback } from 'react';
import type { PreviewPayload } from '@gf/contracts';
import {
  reviseCopilotTask,
  executeCopilotTask,
  type ExecuteTaskResponse,
} from '../api';
import { useSession } from '@/lib/session';

export function useCopilotTask(
  onTaskExecuted?: (execution: ExecuteTaskResponse['execution']) => void,
  initialData?: { taskId?: string | null; preview?: PreviewPayload | null; revision?: number },
) {
  const { membershipId } = useSession();

  const [activeTaskId, setActiveTaskId] = useState<string | null>(initialData?.taskId ?? null);
  const [preview, setPreview] = useState<PreviewPayload | null>(initialData?.preview ?? null);
  const [revision, setRevision] = useState<number>(initialData?.revision ?? 1);
  const [selectedStepIndices, setSelectedStepIndices] = useState<number[]>(() => {
    if (!initialData?.preview) return [];
    const readyIndices = initialData.preview.steps
      .filter((s) => s.status === 'ready')
      .map((s) => s.stepIndex);
    return readyIndices.length > 0 ? readyIndices : initialData.preview.steps.map((s) => s.stepIndex);
  });
  const [isRevising, setIsRevising] = useState<boolean>(false);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [isExecuted, setIsExecuted] = useState<boolean>(false);
  const [lastExecution, setLastExecution] = useState<ExecuteTaskResponse['execution'] | null>(null);

  // 初始化设置计划方案
  const setPlan = useCallback((taskId: string, newPreview: PreviewPayload, rev: number) => {
    setActiveTaskId(taskId);
    setPreview(newPreview);
    setRevision(rev);
    // 默认选中所有无冲突的步骤；若全为 ready 则全选
    const readyIndices = newPreview.steps
      .filter((s) => s.status === 'ready')
      .map((s) => s.stepIndex);
    setSelectedStepIndices(readyIndices.length > 0 ? readyIndices : newPreview.steps.map((s) => s.stepIndex));
    setIsExecuted(false);
    setLastExecution(null);
  }, []);

  // 勾选 / 取消勾选单步
  const toggleStep = useCallback((stepIndex: number, selected: boolean) => {
    setSelectedStepIndices((prev) => {
      if (selected) {
        return prev.includes(stepIndex) ? prev : [...prev, stepIndex].sort((a, b) => a - b);
      } else {
        return prev.filter((idx) => idx !== stepIndex);
      }
    });
  }, []);

  // 全选
  const selectAll = useCallback(() => {
    if (!preview) return;
    setSelectedStepIndices(preview.steps.map((s) => s.stepIndex));
  }, [preview]);

  // 全撤
  const deselectAll = useCallback(() => {
    setSelectedStepIndices([]);
  }, []);

  // 零 Token 微调时间 (29 §10.2)
  const updateStepTime = useCallback(
    async (stepIndex: number, newStartsAt: string) => {
      if (!activeTaskId || !preview) return;
      setIsRevising(true);
      try {
        const res = await reviseCopilotTask(
          activeTaskId,
          {
            expectedRevision: revision,
            selectedStepIndices,
            modifications: [{ stepIndex, startsAt: newStartsAt }],
          },
          membershipId,
        );

        setPreview(res.previewPayload);
        setRevision(res.revision);
      } catch (err) {
        console.error('Failed to revise task time:', err);
      } finally {
        setIsRevising(false);
      }
    },
    [activeTaskId, preview, revision, selectedStepIndices, membershipId],
  );

  // 确认执行所选步骤
  const executePlan = useCallback(async () => {
    if (!activeTaskId || !preview || selectedStepIndices.length === 0) return;
    setIsExecuting(true);
    try {
      const res = await executeCopilotTask(
        activeTaskId,
        {
          revision,
          selectedStepIndices,
        },
        membershipId,
      );

      setLastExecution(res.execution);
      setIsExecuted(true);
      onTaskExecuted?.(res.execution);
      return res.execution;
    } catch (err) {
      console.error('Failed to execute task:', err);
      throw err;
    } finally {
      setIsExecuting(false);
    }
  }, [activeTaskId, preview, revision, selectedStepIndices, membershipId, onTaskExecuted]);

  return {
    activeTaskId,
    preview,
    revision,
    selectedStepIndices,
    isRevising,
    isExecuting,
    isExecuted,
    lastExecution,
    setPlan,
    toggleStep,
    selectAll,
    deselectAll,
    updateStepTime,
    executePlan,
  };
}
