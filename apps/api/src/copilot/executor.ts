/**
 * 服务端任务执行引擎 (29 §4.2, §7.2, §8.1, §8.3)
 *
 * 负责：
 * 1. 任务版本 CAS 抢锁 (防多标签页与双击并发重复提交)；
 * 2. 崩溃对账与幂等重放 (稳定 operation_key 检查)；
 * 3. 事务与命令总线调用；
 * 4. 邮件/短信 Outbox 刷新与生命周期事件发布。
 */

import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { dispatch } from '../bus.js';
import { flushEmails } from '../email/flush.js';
import { flushSms } from '../sms/flush.js';
import {
  getTask,
  updateTaskStatus,
  getRevision,
  updateStepStatus,
  appendTaskEvent,
  findStepByOperationKey,
} from './taskStore.js';

export interface ExecuteTaskResult {
  taskId: string;
  revision: number;
  status: 'completed' | 'partially_completed' | 'failed';
  replayed?: boolean | undefined;
  executedSteps: Array<{
    stepIndex: number;
    command: string;
    status: 'succeeded' | 'failed' | 'skipped' | 'blocked';
    result?: unknown;
    error?: string | undefined;
    undoToken?: string | undefined;
  }>;
}

export async function executeTaskPlan(
  ctx: CommandContext,
  args: {
    taskId: string;
    revision: number;
    selectedStepIndices?: number[] | undefined;
    clientRequestId?: string | undefined;
  },
): Promise<ExecuteTaskResult> {
  const task = await getTask(ctx, args.taskId);
  if (!task) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { resource: 'copilot_task', id: args.taskId } });
  }

  // ── 1. CAS 抢锁 (29 §8.1) ──────────────────────────────────────────────────
  const locked = await withTenant(ctx, async (tx) => {
    const [res] = await tx<{ count: string }[]>`
      update copilot_tasks
      set status = 'running', updated_at = now()
      where id = ${args.taskId}
        and status in ('ready', 'partially_completed')
      returning 1 as count`;
    return Boolean(res);
  });

  if (!locked) {
    // 若已被执行完成，支持幂等重放读取结果
    if (task.status === 'completed' || task.status === 'partially_completed') {
      const revData = await getRevision(ctx, args.taskId, args.revision);
      if (revData) {
        return {
          taskId: args.taskId,
          revision: args.revision,
          status: task.status,
          replayed: true,
          executedSteps: revData.steps.map((s) => ({
            stepIndex: s.stepIndex,
            command: s.command,
            status: s.status === 'succeeded' ? 'succeeded' : (s.status === 'skipped' ? 'skipped' : 'failed'),
            result: s.executionResult,
            error: s.errorDetails ? JSON.stringify(s.errorDetails) : undefined,
            undoToken: s.undoToken ?? undefined,
          })),
        };
      }
    }
    throw new AppError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, {
      details: {
        reason: 'task_already_running_or_finalized',
        currentStatus: task.status,
        taskId: args.taskId,
      },
    });
  }

  // ── 2. 加载目标 Revision 与明细步骤 ───────────────────────────────────────
  const revData = await getRevision(ctx, args.taskId, args.revision);
  if (!revData) {
    await updateTaskStatus(ctx, args.taskId, 'failed');
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { resource: 'copilot_plan_revision', taskId: args.taskId, revision: args.revision },
    });
  }

  const { revision, steps } = revData;
  const isAtomic = revision.executionMode === 'atomic';
  const selectedIndices = args.selectedStepIndices
    ? new Set(args.selectedStepIndices)
    : new Set(steps.map((s) => s.stepIndex));

  const executedSteps: ExecuteTaskResult['executedSteps'] = [];
  let hadFailure = false;
  let hasSuccess = false;

  await appendTaskEvent(ctx, args.taskId, 'TASK_STARTED', {
    revision: args.revision,
    executionMode: revision.executionMode,
    selectedSteps: [...selectedIndices],
  });

  // ── 3. 顺序分派各步骤 ─────────────────────────────────────────────────────
  for (const step of steps) {
    if (!selectedIndices.has(step.stepIndex)) {
      await updateStepStatus(ctx, {
        taskId: args.taskId,
        revision: args.revision,
        stepIndex: step.stepIndex,
        status: 'skipped',
      });
      executedSteps.push({
        stepIndex: step.stepIndex,
        command: step.command,
        status: 'skipped',
      });
      continue;
    }

    if (hadFailure && isAtomic) {
      await updateStepStatus(ctx, {
        taskId: args.taskId,
        revision: args.revision,
        stepIndex: step.stepIndex,
        status: 'blocked',
      });
      executedSteps.push({
        stepIndex: step.stepIndex,
        command: step.command,
        status: 'blocked',
      });
      continue;
    }

    // ── 3.1 崩溃窗口对账检查 (29 §8.3) ──────────────────────────────────────
    const existingStep = await findStepByOperationKey(ctx, step.operationKey);
    if (existingStep && existingStep.status === 'succeeded') {
      executedSteps.push({
        stepIndex: step.stepIndex,
        command: step.command,
        status: 'succeeded',
        result: existingStep.executionResult,
        undoToken: existingStep.undoToken ?? undefined,
      });
      hasSuccess = true;
      continue;
    }

    // ── 3.2 真正执行总线 ────────────────────────────────────────────────────
    await updateStepStatus(ctx, {
      taskId: args.taskId,
      revision: args.revision,
      stepIndex: step.stepIndex,
      status: 'running',
    });

    await appendTaskEvent(ctx, args.taskId, 'STEP_STARTED', {
      stepIndex: step.stepIndex,
      command: step.command,
      summary: step.summary,
    });

    try {
      const dispatchResult = await dispatch(step.command, step.resolvedInput, ctx, {
        idempotencyKey: step.operationKey,
      });

      await updateStepStatus(ctx, {
        taskId: args.taskId,
        revision: args.revision,
        stepIndex: step.stepIndex,
        status: 'succeeded',
        executionResult: dispatchResult.result as Record<string, unknown>,
        undoToken: dispatchResult.undoToken,
        undoExpiresAt: dispatchResult.undoToken ? new Date(Date.now() + 60_000) : null,
      });

      await appendTaskEvent(ctx, args.taskId, 'STEP_SUCCEEDED', {
        stepIndex: step.stepIndex,
        command: step.command,
        result: dispatchResult.result,
        undoToken: dispatchResult.undoToken,
      });

      executedSteps.push({
        stepIndex: step.stepIndex,
        command: step.command,
        status: 'succeeded',
        result: dispatchResult.result,
        undoToken: dispatchResult.undoToken,
      });
      hasSuccess = true;
    } catch (err: any) {
      hadFailure = true;
      const errorMsg = String(err?.message || err);
      const errorDetails = {
        code: err?.code || 'UNKNOWN_ERROR',
        message: errorMsg,
        details: err?.details,
      };

      await updateStepStatus(ctx, {
        taskId: args.taskId,
        revision: args.revision,
        stepIndex: step.stepIndex,
        status: 'failed',
        errorDetails,
      });

      await appendTaskEvent(ctx, args.taskId, 'STEP_FAILED', {
        stepIndex: step.stepIndex,
        command: step.command,
        error: errorDetails,
      });

      executedSteps.push({
        stepIndex: step.stepIndex,
        command: step.command,
        status: 'failed',
        error: errorMsg,
      });
    }
  }

  // ── 4. 刷新通知 Outbox ───────────────────────────────────────────────────
  try {
    const tenantCtx = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
    await flushEmails(tenantCtx);
    await flushSms(tenantCtx);
  } catch (err) {
    console.error('Failed to flush outbox after copilot task execution:', err);
  }

  // ── 5. 判定最终任务生命周期终态 ───────────────────────────────────────────
  let finalStatus: ExecuteTaskResult['status'] = 'completed';
  if (hadFailure) {
    finalStatus = hasSuccess && !isAtomic ? 'partially_completed' : 'failed';
  }

  await updateTaskStatus(ctx, args.taskId, finalStatus);
  await appendTaskEvent(ctx, args.taskId, finalStatus === 'failed' ? 'TASK_FAILED' : 'TASK_COMPLETED', {
    status: finalStatus,
    executedSteps,
  });

  return {
    taskId: args.taskId,
    revision: args.revision,
    status: finalStatus,
    executedSteps,
  };
}
