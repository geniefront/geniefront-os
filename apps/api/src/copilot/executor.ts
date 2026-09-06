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
import { issueCopilotProposal } from './proposalToken.js';
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

/**
 * 撤销令牌的有效期。
 *
 * 前台按错一下，抬头发现建错了单，5 分钟够她反应过来；再久就该走正常的
 * 预约取消流程了 —— 那条路有取消原因、有通知客人的开关，撤销按钮没有。
 */
const UNDO_TTL_MS = 5 * 60_000;

/**
 * 为可逆的步骤签发一枚撤销令牌。
 *
 * ⚠️ 这里签出来的令牌是**唯一**还能走 `POST /v1/ai/copilot/execute` 的东西，
 * 且那条路只放行 `appointment.cancel`（见 routes.ts 的 UNDO_COMMANDS）。
 *
 * 早先执行结果里的 `undoToken` 塞的是命令总线返回的审计条目 id，前端拿到
 * 之后没有任何接口能兑现它 —— 撤销按钮点了就是一个 400。
 */
function issueUndoToken(
  ctx: CommandContext,
  command: string,
  result: unknown,
): string | undefined {
  if (command !== 'appointment.create') return undefined;
  const appt = result as { appointmentId?: string } | null;
  if (!appt?.appointmentId) return undefined;

  // ⚠️ 签发失败绝不能把已经成功的写入拖成 failed。
  //
  // 签名要读 APP_JWT_SECRET，配置缺失或密钥轮换的瞬间会抛 —— 而这一步跑到
  // 这里时预约**已经真的建好了**。让它冒泡出去会被外层 catch 记成步骤失败，
  // 前台看到「建单失败」，实际库里躺着一条单，比没有撤销按钮糟糕得多。
  try {
    return issueCopilotProposal(
      ctx,
      'appointment.cancel',
      { appointmentId: appt.appointmentId, reason: 'input_error', notifyCustomer: false },
      '撤销刚才创建的预约',
      new Date(),
      UNDO_TTL_MS,
    ).token;
  } catch {
    return undefined;
  }
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

      const undoToken = issueUndoToken(ctx, step.command, dispatchResult.result);

      await updateStepStatus(ctx, {
        taskId: args.taskId,
        revision: args.revision,
        stepIndex: step.stepIndex,
        status: 'succeeded',
        executionResult: dispatchResult.result as Record<string, unknown>,
        undoToken,
        undoExpiresAt: undoToken ? new Date(Date.now() + UNDO_TTL_MS) : null,
      });

      // 事件流里不放令牌：SSE 会被回放、会落库，撤销令牌不该跟着到处跑。
      await appendTaskEvent(ctx, args.taskId, 'STEP_SUCCEEDED', {
        stepIndex: step.stepIndex,
        command: step.command,
        result: dispatchResult.result,
      });

      executedSteps.push({
        stepIndex: step.stepIndex,
        command: step.command,
        status: 'succeeded',
        result: dispatchResult.result,
        undoToken,
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
