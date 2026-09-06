import React from 'react';
import type { PreviewPayload } from '@gf/contracts';
import { TaskListCard } from './TaskListCard';
import { useCopilotTask } from '../hooks/useCopilotTask';
import type { ExecuteTaskResponse } from '../api';
import { toast } from '@heroui/react';

interface TaskPlanCardProps {
  taskId: string;
  preview: PreviewPayload;
  revision: number;
  executed?: boolean;
  /**
   * 执行完成回调。
   *
   * 带上完整的 execution 结果，调用方才能从里面取出撤销令牌 ——
   * 以前是个无参回调，撤销令牌在这一层就被丢掉了，抽屉上的撤销按钮
   * 因此永远拿不到可兑现的令牌。
   */
  onExecuted?: (execution: ExecuteTaskResponse['execution']) => void;
}

export const TaskPlanCard: React.FC<TaskPlanCardProps> = ({
  taskId,
  preview: initialPreview,
  revision: initialRevision,
  executed: initialExecuted,
  onExecuted,
}) => {
  const {
    preview,
    revision,
    selectedStepIndices,
    toggleStep,
    selectAll,
    deselectAll,
    updateStepTime,
    executePlan,
    isExecuting,
    isRevising,
    isExecuted,
  } = useCopilotTask(onExecuted, {
    taskId,
    preview: initialPreview,
    revision: initialRevision,
  });

  const activePreview = preview || initialPreview;
  const activeRev = revision || initialRevision;

  const handleExecute = async () => {
    try {
      const execution = await executePlan();
      // 局部容错模式下可能只成了一半，别一律报「执行成功」——
      // 前台照着这句话走开，剩下那两单其实没建。
      const failed = execution?.executedSteps.filter((s) => s.status === 'failed') ?? [];
      if (failed.length > 0) {
        toast.warning(`${execution!.executedSteps.length - failed.length} 项已执行，${failed.length} 项失败`);
      } else {
        toast.success('方案执行成功');
      }
    } catch (err: any) {
      toast.danger(err.message || '方案执行失败');
    }
  };

  return (
    <TaskListCard
      taskId={taskId}
      preview={activePreview}
      revision={activeRev}
      selectedStepIndices={selectedStepIndices}
      onToggleSelectStep={toggleStep}
      onSelectAll={selectAll}
      onDeselectAll={deselectAll}
      onUpdateTime={updateStepTime}
      onExecute={handleExecute}
      isExecuting={isExecuting}
      isRevising={isRevising}
      executed={initialExecuted || isExecuted}
    />
  );
};
