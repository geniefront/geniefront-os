/**
 * 副驾任务持久化数据访问层 (29 §4.2, §8.1, §8.3)
 *
 * 全部读写严格走 withTenant()，受 RLS 保护，保持多租户隔离。
 */

import { withTenant, jsonb, ts } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import type {
  CopilotTask,
  CopilotTaskStatus,
  CopilotPlanRevision,
  CopilotTaskStep,
  CopilotStepStatus,
  CopilotTaskEvent,
  CopilotExecutionMode,
  PreviewPayload,
} from '@gf/contracts';
import type { TimeAnchor } from '@gf/ai';

export async function createTask(
  ctx: CommandContext,
  args: {
    sessionId: string;
    originalGoal: string;
    timeAnchor: TimeAnchor;
  },
): Promise<CopilotTask> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx<{
      id: string;
      org_id: string;
      location_id: string;
      membership_id: string;
      session_id: string;
      original_goal: string;
      status: string;
      current_revision: number;
      time_anchor: any;
      created_at: string;
      updated_at: string;
      expires_at: string;
    }[]>`
      insert into copilot_tasks
        (org_id, location_id, membership_id, session_id, original_goal, status, current_revision, time_anchor)
      values
        (${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId}, ${args.sessionId},
         ${args.originalGoal}, 'collecting', 1, ${jsonb(args.timeAnchor)}::jsonb)
      returning *`;

    return {
      id: row!.id,
      orgId: row!.org_id,
      locationId: row!.location_id,
      membershipId: row!.membership_id,
      sessionId: row!.session_id,
      originalGoal: row!.original_goal,
      status: row!.status as CopilotTaskStatus,
      currentRevision: row!.current_revision,
      timeAnchor: row!.time_anchor,
      createdAt: row!.created_at,
      updatedAt: row!.updated_at,
      expiresAt: row!.expires_at,
    };
  });
}

export async function getTask(
  ctx: CommandContext,
  taskId: string,
): Promise<CopilotTask | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx<{
      id: string;
      org_id: string;
      location_id: string;
      membership_id: string;
      session_id: string;
      original_goal: string;
      status: string;
      current_revision: number;
      time_anchor: any;
      created_at: string;
      updated_at: string;
      expires_at: string;
    }[]>`
      select * from copilot_tasks
      where id = ${taskId} and location_id = ${ctx.locationId}`;

    if (!row) return null;
    return {
      id: row.id,
      orgId: row.org_id,
      locationId: row.location_id,
      membershipId: row.membership_id,
      sessionId: row.session_id,
      originalGoal: row.original_goal,
      status: row.status as CopilotTaskStatus,
      currentRevision: row.current_revision,
      timeAnchor: row.time_anchor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  });
}

export async function updateTaskStatus(
  ctx: CommandContext,
  taskId: string,
  status: CopilotTaskStatus,
  currentRevision?: number,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    if (typeof currentRevision === 'number') {
      await tx`
        update copilot_tasks
        set status = ${status},
            current_revision = ${currentRevision},
            updated_at = now()
        where id = ${taskId} and location_id = ${ctx.locationId}`;
    } else {
      await tx`
        update copilot_tasks
        set status = ${status},
            updated_at = now()
        where id = ${taskId} and location_id = ${ctx.locationId}`;
    }
  });
}

export async function savePlanRevision(
  ctx: CommandContext,
  args: {
    taskId: string;
    revision: number;
    canonicalHash: string;
    previewPayload: PreviewPayload;
    executionMode: CopilotExecutionMode;
    steps: Array<{
      stepIndex: number;
      command: string;
      resolvedInput: Record<string, unknown>;
      summary: string;
      operationKey: string;
      status: CopilotStepStatus;
    }>;
  },
): Promise<CopilotPlanRevision> {
  return withTenant(ctx, async (tx) => {
    const [revRow] = await tx<{
      id: string;
      task_id: string;
      org_id: string;
      location_id: string;
      membership_id: string;
      revision: number;
      canonical_hash: string;
      preview_payload: any;
      execution_mode: string;
      created_at: string;
    }[]>`
      insert into copilot_plan_revisions
        (task_id, org_id, location_id, membership_id, revision, canonical_hash, preview_payload, execution_mode)
      values
        (${args.taskId}, ${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId},
         ${args.revision}, ${args.canonicalHash}, ${jsonb(args.previewPayload)}::jsonb, ${args.executionMode})
      on conflict (task_id, revision)
      do update set
        canonical_hash = excluded.canonical_hash,
        preview_payload = excluded.preview_payload,
        execution_mode = excluded.execution_mode
      returning *`;

    // 同一个 revision 被重写时（模型预检打回后重提），先清掉上一版留下的
    // 尾部步骤行 —— upsert 只覆盖 step_index 相同的行，步骤数变少时多出来的
    // 旧行会留在表里，执行引擎照样会把它们捞出来跑一遍。
    await tx`
      delete from copilot_task_steps
      where task_id = ${args.taskId}
        and revision = ${args.revision}
        and step_index >= ${args.steps.length}`;

    for (const step of args.steps) {
      await tx`
        insert into copilot_task_steps
          (task_id, revision, step_index, org_id, location_id, membership_id,
           command, resolved_input, summary, operation_key, status)
        values
          (${args.taskId}, ${args.revision}, ${step.stepIndex}, ${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId},
           ${step.command}, ${jsonb(step.resolvedInput)}::jsonb, ${step.summary}, ${step.operationKey}, ${step.status})
        on conflict (task_id, revision, step_index)
        do update set
          resolved_input = excluded.resolved_input,
          summary = excluded.summary,
          operation_key = excluded.operation_key,
          status = excluded.status,
          updated_at = now()`;
    }

    await tx`
      update copilot_tasks
      set current_revision = ${args.revision},
          status = 'ready',
          updated_at = now()
      where id = ${args.taskId}`;

    return {
      id: revRow!.id,
      taskId: revRow!.task_id,
      orgId: revRow!.org_id,
      locationId: revRow!.location_id,
      membershipId: revRow!.membership_id,
      revision: revRow!.revision,
      canonicalHash: revRow!.canonical_hash,
      previewPayload: revRow!.preview_payload as PreviewPayload,
      executionMode: revRow!.execution_mode as CopilotExecutionMode,
      createdAt: revRow!.created_at,
    };
  });
}

export async function getRevision(
  ctx: CommandContext,
  taskId: string,
  revisionNumber: number,
): Promise<{ revision: CopilotPlanRevision; steps: CopilotTaskStep[] } | null> {
  return withTenant(ctx, async (tx) => {
    const [revRow] = await tx<{
      id: string;
      task_id: string;
      org_id: string;
      location_id: string;
      membership_id: string;
      revision: number;
      canonical_hash: string;
      preview_payload: any;
      execution_mode: string;
      created_at: string;
    }[]>`
      select * from copilot_plan_revisions
      where task_id = ${taskId} and revision = ${revisionNumber}`;

    if (!revRow) return null;

    const stepRows = await tx<{
      id: string;
      task_id: string;
      revision: number;
      step_index: number;
      org_id: string;
      location_id: string;
      membership_id: string;
      command: string;
      resolved_input: any;
      summary: string;
      operation_key: string;
      status: string;
      execution_result: any;
      error_details: any;
      undo_token: string | null;
      undo_expires_at: string | null;
      attempt: number;
      updated_at: string;
    }[]>`
      select * from copilot_task_steps
      where task_id = ${taskId} and revision = ${revisionNumber}
      order by step_index asc`;

    return {
      revision: {
        id: revRow.id,
        taskId: revRow.task_id,
        orgId: revRow.org_id,
        locationId: revRow.location_id,
        membershipId: revRow.membership_id,
        revision: revRow.revision,
        canonicalHash: revRow.canonical_hash,
        previewPayload: revRow.preview_payload as PreviewPayload,
        executionMode: revRow.execution_mode as CopilotExecutionMode,
        createdAt: revRow.created_at,
      },
      steps: stepRows.map((s) => ({
        id: s.id,
        taskId: s.task_id,
        revision: s.revision,
        stepIndex: s.step_index,
        orgId: s.org_id,
        locationId: s.location_id,
        membershipId: s.membership_id,
        command: s.command,
        resolvedInput: s.resolved_input,
        summary: s.summary,
        operationKey: s.operation_key,
        status: s.status as CopilotStepStatus,
        executionResult: s.execution_result,
        errorDetails: s.error_details,
        undoToken: s.undo_token,
        undoExpiresAt: s.undo_expires_at,
        attempt: s.attempt,
        updatedAt: s.updated_at,
      })),
    };
  });
}

export async function updateStepStatus(
  ctx: CommandContext,
  args: {
    taskId: string;
    revision: number;
    stepIndex: number;
    status: CopilotStepStatus;
    executionResult?: Record<string, unknown> | null | undefined;
    errorDetails?: Record<string, unknown> | null | undefined;
    undoToken?: string | null | undefined;
    undoExpiresAt?: Date | string | null | undefined;
  },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx`
      update copilot_task_steps
      set status = ${args.status},
          execution_result = ${args.executionResult ? jsonb(args.executionResult) : null}::jsonb,
          error_details = ${args.errorDetails ? jsonb(args.errorDetails) : null}::jsonb,
          undo_token = ${args.undoToken ?? null},
          undo_expires_at = ${args.undoExpiresAt ? ts(new Date(args.undoExpiresAt)) : null}::timestamptz,
          attempt = attempt + 1,
          updated_at = now()
      where task_id = ${args.taskId}
        and revision = ${args.revision}
        and step_index = ${args.stepIndex}`;
  });
}

export async function appendTaskEvent(
  ctx: CommandContext,
  taskId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<CopilotTaskEvent> {
  return withTenant(ctx, async (tx) => {
    // 自动原子递增序号
    const [row] = await tx<{
      id: string;
      task_id: string;
      org_id: string;
      location_id: string;
      membership_id: string;
      seq: number;
      event_type: string;
      payload: any;
      created_at: string;
    }[]>`
      insert into copilot_task_events
        (task_id, org_id, location_id, membership_id, seq, event_type, payload)
      values
        (${taskId}, ${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId},
         (select coalesce(max(seq), 0) + 1 from copilot_task_events where task_id = ${taskId}),
         ${eventType}, ${jsonb(payload)}::jsonb)
      returning *`;

    return {
      id: Number(row!.id),
      taskId: row!.task_id,
      orgId: row!.org_id,
      locationId: row!.location_id,
      membershipId: row!.membership_id,
      seq: row!.seq,
      eventType: row!.event_type,
      payload: row!.payload,
      createdAt: row!.created_at,
    };
  });
}

export async function getTaskEventsAfter(
  ctx: CommandContext,
  taskId: string,
  afterSeq: number,
): Promise<CopilotTaskEvent[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx<{
      id: string;
      task_id: string;
      org_id: string;
      location_id: string;
      membership_id: string;
      seq: number;
      event_type: string;
      payload: any;
      created_at: string;
    }[]>`
      select * from copilot_task_events
      where task_id = ${taskId} and seq > ${afterSeq}
      order by seq asc`;

    return rows.map((r) => ({
      id: Number(r.id),
      taskId: r.task_id,
      orgId: r.org_id,
      locationId: r.location_id,
      membershipId: r.membership_id,
      seq: r.seq,
      eventType: r.event_type,
      payload: r.payload,
      createdAt: r.created_at,
    }));
  });
}

/**
 * 崩溃对账查询 (29 §8.3)
 */
export async function findStepByOperationKey(
  ctx: CommandContext,
  operationKey: string,
): Promise<CopilotTaskStep | null> {
  return withTenant(ctx, async (tx) => {
    const [s] = await tx<{
      id: string;
      task_id: string;
      revision: number;
      step_index: number;
      org_id: string;
      location_id: string;
      membership_id: string;
      command: string;
      resolved_input: any;
      summary: string;
      operation_key: string;
      status: string;
      execution_result: any;
      error_details: any;
      undo_token: string | null;
      undo_expires_at: string | null;
      attempt: number;
      updated_at: string;
    }[]>`
      select * from copilot_task_steps
      where operation_key = ${operationKey} and location_id = ${ctx.locationId}
      order by updated_at desc limit 1`;

    if (!s) return null;
    return {
      id: s.id,
      taskId: s.task_id,
      revision: s.revision,
      stepIndex: s.step_index,
      orgId: s.org_id,
      locationId: s.location_id,
      membershipId: s.membership_id,
      command: s.command,
      resolvedInput: s.resolved_input,
      summary: s.summary,
      operationKey: s.operation_key,
      status: s.status as CopilotStepStatus,
      executionResult: s.execution_result,
      errorDetails: s.error_details,
      undoToken: s.undo_token,
      undoExpiresAt: s.undo_expires_at,
      attempt: s.attempt,
      updatedAt: s.updated_at,
    };
  });
}
