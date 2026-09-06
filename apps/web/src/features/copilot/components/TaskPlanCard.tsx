import React from 'react';
import type { PreviewPayload } from '@gf/contracts';
import { TaskListCard } from './TaskListCard';
import { useCopilotTask } from '../hooks/useCopilotTask';
import { toast } from '@heroui/react';

interface TaskPlanCardProps {
  taskId: string;
  preview: PreviewPayload;
  revision: number;
  executed?: boolean;
  onExecutionComplete?: () => void;
}

export const TaskPlanCard: React.FC<TaskPlanCardProps> = ({
  taskId,
  preview: initialPreview,
  revision: initialRevision,
  executed: initialExecuted,
  onExecutionComplete,
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
  } = useCopilotTask(onExecutionComplete, {
    taskId,
    preview: initialPreview,
    revision: initialRevision,
  });

  const activePreview = preview || initialPreview;
  const activeRev = revision || initialRevision;

  const handleExecute = async () => {
    try {
      await executePlan();
      toast.success('方案执行成功');
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
