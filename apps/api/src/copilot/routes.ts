/**
 * 前台 AI 副驾路由集合 (29 §4.2, §8.1, §9.1)
 *
 * 包含：
 * 1. POST /v1/ai/copilot/turns —— 多轮意图编排与方案签发入口；
 * 2. GET  /v1/ai/copilot/tasks/:id —— 任务全量状态快照；
 * 3. GET  /v1/ai/copilot/tasks/:id/events —— SSE 任务粗粒度事件通道 (?after=seq)；
 * 4. POST /v1/ai/copilot/tasks/:id/revise —— 交互式微调接口 (0 Token 毫秒级重签 Revision)；
 * 5. POST /v1/ai/copilot/tasks/:id/execute —— 任务方案执行入口 (CAS 抢锁 + 幂等重放)；
 * 6. POST /v1/ai/copilot/tasks/:id/cancel —— 取消任务；
 * 7. 兼容存量单任务接口：/v1/ai/copilot 与 /v1/ai/copilot/execute。
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError,
  ERROR_CODES,
  getCommand,
  type CommandContext,
  type Permission,
  type CopilotTurnRequest,
  type CopilotReviseRequest,
  type CopilotExecuteRequest,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { costMillicentsNormalized, millicentsToCents, type TimeAnchor } from '@gf/ai';
import { dispatch } from '../bus.js';
import { assertAiAdmission } from '../billing/aiAdmission.js';
import { maybeAutoTopup } from '../billing/autoTopup.js';
import { loadFloorSnapshot } from '../queries/floorSnapshot.js';
import { COPILOT_BODY_LIMIT, parseCopilotImage } from './image.js';
import {
  beginCopilotTurn,
  completeCopilotTurn,
  deleteCopilotSession,
  loadCopilotSessions,
} from './sessionStore.js';
import { issueCopilotProposal, verifyCopilotProposal } from './proposalToken.js';
import { flushEmails } from '../email/flush.js';
import { flushSms } from '../sms/flush.js';
import { runCopilotOrchestration } from './orchestrator.js';
import { executeTaskPlan } from './executor.js';
import { compileTaskPlan } from './preflight.js';
import {
  getTask,
  getRevision,
  savePlanRevision,
  updateTaskStatus,
  appendTaskEvent,
  getTaskEventsAfter,
} from './taskStore.js';
import { createReadOnlyToolExecutors } from './tools/index.js';
import type { CtxFromHeaders } from '../stripe/routes.js';

const MAX_QUESTION_CHARS = 2000;

async function buildTimeAnchor(ctx: CommandContext): Promise<TimeAnchor> {
  const [loc] = await withTenant(ctx, (tx) => tx<{
    name: unknown; timezone: string; cutoff: string;
  }[]>`
    select name, timezone, business_day_cutoff::text as cutoff
    from locations where id = ${ctx.locationId}`);

  const now = new Date();
  const timezone = loc?.timezone || 'America/New_York';
  const cutoff = loc?.cutoff || '04:00';
  const businessDate = businessDateOf(now, timezone, cutoff);

  const localDate = now.toLocaleDateString('en-CA', { timeZone: timezone });
  const localTime = now.toLocaleTimeString('en-GB', { timeZone: timezone });
  const weekday = now.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });

  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
  const parts = dtf.formatToParts(now);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const offsetMatch = tzPart.match(/GMT([+-]\d{2}:\d{2})/);
  const utcOffset = offsetMatch ? offsetMatch[1]! : '+00:00';

  return {
    iso: now.toISOString(),
    localDate,
    localTime,
    weekday,
    timezone,
    utcOffset,
    businessDate,
    cutoff,
  };
}

export function registerCopilotRoutes(
  app: FastifyInstance,
  ctxFromHeaders: CtxFromHeaders,
): void {
  // ── 1. 会话列表与删除 ──────────────────────────────────────────────────────
  app.get('/v1/ai/copilot/sessions', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }
    return { sessions: await loadCopilotSessions(ctx) };
  });

  app.delete<{ Params: { id: string } }>('/v1/ai/copilot/sessions/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }
    const deleted = await deleteCopilotSession(ctx, req.params.id);
    if (!deleted) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { resource: 'copilot_session' } });
    }
    return { ok: true };
  });

  // ── 2. 多意图/多任务回合入口 (Turns) ───────────────────────────────────────
  app.post<{ Body: CopilotTurnRequest }>('/v1/ai/copilot/turns', { bodyLimit: COPILOT_BODY_LIMIT }, async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }

    const question = (req.body?.question ?? '').trim();
    if (question.length > MAX_QUESTION_CHARS) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'question_too_long' } });
    }
    const imageInput = parseCopilotImage(req.body?.image);

    const timeAnchor = await buildTimeAnchor(ctx);
    const turn = await beginCopilotTurn(ctx, req.body?.sessionId, question, Boolean(imageInput));
    const snapshot = await withTenant(ctx, (tx) => loadFloorSnapshot(tx, ctx));

    const readOnlyExecutors = createReadOnlyToolExecutors(ctx);

    // AUD-03 准入闸门：调模型紧邻的前一行
    await assertAiAdmission(ctx);
    const result = await runCopilotOrchestration(ctx, {
      question,
      sessionId: turn.sessionId,
      taskId: req.body?.taskId,
      image: imageInput ? { base64: imageInput.base64, mediaType: imageInput.mediaType } : undefined,
      snapshot,
      timeAnchor,
      readOnlyExecutors,
    });

    const costCents = millicentsToCents(costMillicentsNormalized(result.usage));
    if (costCents > 0) {
      try {
        await maybeAutoTopup(ctx, 'credit', req.log);
      } catch (err) {
        req.log.warn({ err }, 'maybeAutoTopup failed in copilot turn');
      }
    }

    await completeCopilotTurn(ctx, turn, {
      answer: result.answer,
      source: 'model',
      proposal: result.planRevision?.steps[0]
        ? {
            command: result.planRevision.steps[0].command,
            summary: result.planRevision.steps[0].summary,
          }
        : null,
      toolsUsed: result.toolsUsed,
    });

    return {
      taskId: result.task.id,
      sessionId: turn.sessionId,
      answer: result.answer,
      planRevision: result.planRevision,
      canonicalHash: result.canonicalHash,
      revision: result.revision,
      clarification: result.clarification,
      toolsUsed: result.toolsUsed,
      costCents,
    };
  });

  // ── 3. 获取任务状态快照 ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/ai/copilot/tasks/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }

    const task = await getTask(ctx, req.params.id);
    if (!task) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { resource: 'copilot_task', id: req.params.id } });
    }

    const revData = await getRevision(ctx, task.id, task.currentRevision);
    return {
      task,
      revision: revData?.revision ?? null,
      steps: revData?.steps ?? [],
      previewPayload: revData?.revision?.previewPayload ?? null,
    };
  });

  // ── 4. SSE 粗粒度事件通道 (?after=seq) ─────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/v1/ai/copilot/tasks/:id/events',
    async (req, reply) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      const task = await getTask(ctx, req.params.id);
      if (!task) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { resource: 'copilot_task', id: req.params.id } });
      }

      reply.hijack();
      const origin = req.headers.origin;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        ...(origin ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
          'Vary': 'Origin',
        } : {}),
      });
      reply.raw.flushHeaders();

      const afterSeq = Number(req.query.after ?? 0);
      const pastEvents = await getTaskEventsAfter(ctx, req.params.id, afterSeq);

      for (const ev of pastEvents) {
        reply.raw.write(`id: ${ev.seq}\nevent: ${ev.eventType}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
      }

      reply.raw.write(`event: ping\ndata: {}\n\n`);
      reply.raw.end();
    },
  );

  // ── 5. 交互式微调接口 (零 Token 毫秒级重签) ───────────────────────────────
  app.post<{ Params: { id: string }; Body: CopilotReviseRequest }>(
    '/v1/ai/copilot/tasks/:id/revise',
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      const task = await getTask(ctx, req.params.id);
      if (!task) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { resource: 'copilot_task', id: req.params.id } });
      }

      const currentRevData = await getRevision(ctx, task.id, task.currentRevision);
      if (!currentRevData) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { resource: 'copilot_plan_revision' } });
      }

      const timeAnchor = await buildTimeAnchor(ctx);
      const newRevisionNumber = task.currentRevision + 1;

      // 提取原计划入参并合并修改
      const modifiedSteps = currentRevData.steps.map((st) => {
        const mod = req.body.modifications?.find((m) => m.stepIndex === st.stepIndex);
        const resolvedInput = JSON.parse(JSON.stringify(st.resolvedInput));

        if (mod) {
          if (mod.startsAt && Array.isArray(resolvedInput['items']) && resolvedInput['items'][0]) {
            resolvedInput['items'][0].startsAt = mod.startsAt;
          }
          if (mod.membershipId !== undefined && Array.isArray(resolvedInput['items']) && resolvedInput['items'][0]) {
            resolvedInput['items'][0].membershipId = mod.membershipId;
          }
          if (mod.resourceId !== undefined) {
            resolvedInput['resourceId'] = mod.resourceId;
          }
          if (mod.notes !== undefined) {
            resolvedInput['notes'] = mod.notes;
          }
        }

        return {
          stepKey: `step_${st.stepIndex}`,
          command: st.command,
          input: resolvedInput,
          summary: st.summary,
        };
      });

      const planInput = {
        title: currentRevData.revision.previewPayload.title,
        summary: currentRevData.revision.previewPayload.summary,
        executionMode: currentRevData.revision.executionMode,
        steps: modifiedSteps,
      };

      const compiled = await compileTaskPlan(ctx, task.id, newRevisionNumber, planInput, timeAnchor);

      const savedRev = await savePlanRevision(ctx, {
        taskId: task.id,
        revision: newRevisionNumber,
        canonicalHash: compiled.canonicalHash,
        previewPayload: compiled.previewPayload,
        executionMode: compiled.executionMode,
        steps: compiled.compiledSteps.map((s) => ({
          stepIndex: s.stepIndex,
          command: s.command,
          resolvedInput: s.resolvedInput,
          summary: s.summary,
          operationKey: s.operationKey,
          status: s.status,
        })),
      });

      await appendTaskEvent(ctx, task.id, 'PLAN_REVISED', {
        revision: savedRev.revision,
        title: savedRev.previewPayload.title,
        stepsCount: savedRev.previewPayload.steps.length,
        hasConflicts: savedRev.previewPayload.hasConflicts,
      });

      await updateTaskStatus(ctx, task.id, 'ready', savedRev.revision);

      return {
        taskId: task.id,
        revision: savedRev.revision,
        previewPayload: savedRev.previewPayload,
        canonicalHash: savedRev.canonicalHash,
      };
    },
  );

  // ── 6. 确认执行已选方案 ───────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: CopilotExecuteRequest }>(
    '/v1/ai/copilot/tasks/:id/execute',
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      const execution = await executeTaskPlan(ctx, {
        taskId: req.params.id,
        revision: req.body.revision,
        selectedStepIndices: req.body.selectedStepIndices,
        clientRequestId: req.body.clientRequestId,
      });

      return {
        ok: true,
        execution,
      };
    },
  );

  // ── 7. 取消任务 ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/v1/ai/copilot/tasks/:id/cancel', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }

    await updateTaskStatus(ctx, req.params.id, 'cancelled');
    await appendTaskEvent(ctx, req.params.id, 'TASK_CANCELLED', { cancelledBy: ctx.membershipId });
    return { ok: true };
  });

  // ── 8. 存量与流式副驾：POST /v1/ai/copilot & /v1/ai/copilot/stream ───────
  app.post<{ Body: {
    question?: string;
    sessionId?: string;
    image?: { base64: string; mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' };
  } }>('/v1/ai/copilot/stream', { bodyLimit: COPILOT_BODY_LIMIT }, async (req, reply) => {
    reply.hijack();
    const origin = req.headers.origin;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      ...(origin ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin',
      } : {}),
    });
    reply.raw.flushHeaders();

    const sendEvent = (obj: Record<string, unknown>) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // client disconnected
      }
    };

    sendEvent({ type: 'step', step: '正在连接智能引擎...' });

    try {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('ai.use')) {
        sendEvent({ type: 'error', error: 'Permission denied: need ai.use' });
        reply.raw.end();
        return;
      }

      const question = (req.body?.question ?? '').trim();
      const imageInput = parseCopilotImage(req.body?.image);

      const timeAnchor = await buildTimeAnchor(ctx);
      const turn = await beginCopilotTurn(ctx, req.body?.sessionId, question, Boolean(imageInput));
      const snapshot = await withTenant(ctx, (tx) => loadFloorSnapshot(tx, ctx));

      const readOnlyExecutors = createReadOnlyToolExecutors(ctx);

      // AUD-03 准入闸门
      await assertAiAdmission(ctx);
      const result = await runCopilotOrchestration(ctx, {
        question,
        sessionId: turn.sessionId,
        image: imageInput ? { base64: imageInput.base64, mediaType: imageInput.mediaType } : undefined,
        snapshot,
        timeAnchor,
        readOnlyExecutors,
        callbacks: {
          onStep: (step) => sendEvent({ type: 'step', step }),
          onDelta: (delta) => sendEvent({ type: 'delta', delta }),
        },
      });

      const costCents = millicentsToCents(costMillicentsNormalized(result.usage));
      if (costCents > 0) {
        try {
          await maybeAutoTopup(ctx, 'credit', req.log);
        } catch (err) {
          req.log.warn({ err }, 'maybeAutoTopup failed in copilot stream route');
        }
      }

      let legacyProposal: any = null;
      if (result.planRevision && result.planRevision.steps.length > 0) {
        const firstStep = result.planRevision.steps[0]!;
        legacyProposal = finalizeCopilotProposal(
          {
            command: firstStep.command,
            input: firstStep.resolvedInput,
            summary: firstStep.summary,
          },
          ctx,
          req.log,
        );
        sendEvent({ type: 'proposal', proposal: legacyProposal });
      }

      await completeCopilotTurn(ctx, turn, {
        answer: result.answer,
        source: 'model',
        proposal: legacyProposal ? { command: legacyProposal.command, summary: legacyProposal.summary } : null,
        toolsUsed: result.toolsUsed,
      });

      sendEvent({
        type: 'done',
        answer: result.answer,
        proposal: legacyProposal,
        source: 'model',
        costCents,
        sessionId: turn.sessionId,
        toolsUsed: result.toolsUsed,
        taskId: result.task.id,
        planRevision: result.planRevision,
        revision: result.revision,
      });
    } catch (err: any) {
      req.log.error({ err }, 'copilot stream error');
      sendEvent({
        type: 'error',
        error: err?.message || 'AI processing error',
      });
    } finally {
      try {
        reply.raw.end();
      } catch {
        // ignore
      }
    }
  });

  app.post<{ Body: {
    question?: string;
    sessionId?: string;
    image?: { base64: string; mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' };
  } }>('/v1/ai/copilot', { bodyLimit: COPILOT_BODY_LIMIT }, async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }

    const question = (req.body?.question ?? '').trim();
    const imageInput = parseCopilotImage(req.body?.image);

    const timeAnchor = await buildTimeAnchor(ctx);
    const turn = await beginCopilotTurn(ctx, req.body?.sessionId, question, Boolean(imageInput));
    const snapshot = await withTenant(ctx, (tx) => loadFloorSnapshot(tx, ctx));

    const readOnlyExecutors = createReadOnlyToolExecutors(ctx);

    // AUD-03 准入闸门
    await assertAiAdmission(ctx);
    const result = await runCopilotOrchestration(ctx, {
      question,
      sessionId: turn.sessionId,
      image: imageInput ? { base64: imageInput.base64, mediaType: imageInput.mediaType } : undefined,
      snapshot,
      timeAnchor,
      readOnlyExecutors,
    });

    const costCents = millicentsToCents(costMillicentsNormalized(result.usage));
    if (costCents > 0) {
      try {
        await maybeAutoTopup(ctx, 'credit', req.log);
      } catch (err) {
        req.log.warn({ err }, 'maybeAutoTopup failed in legacy copilot route');
      }
    }

    let legacyProposal: any = null;
    if (result.planRevision && result.planRevision.steps.length > 0) {
      const firstStep = result.planRevision.steps[0]!;
      legacyProposal = finalizeCopilotProposal(
        {
          command: firstStep.command,
          input: firstStep.resolvedInput,
          summary: firstStep.summary,
        },
        ctx,
        req.log,
      );
    }

    await completeCopilotTurn(ctx, turn, {
      answer: result.answer,
      source: 'model',
      proposal: legacyProposal ? { command: legacyProposal.command, summary: legacyProposal.summary } : null,
      toolsUsed: result.toolsUsed,
    });

    return {
      answer: result.answer,
      proposal: legacyProposal,
      source: 'model' as const,
      costCents,
      sessionId: turn.sessionId,
      toolsUsed: result.toolsUsed,
      taskId: result.task.id,
      planRevision: result.planRevision,
      revision: result.revision,
    };
  });

  // ── 9. 存量兼容：POST /v1/ai/copilot/execute ──────────────────────────────
  app.post<{ Body: { proposalToken?: string; taskId?: string; revision?: number } }>(
    '/v1/ai/copilot/execute',
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      if (req.body?.taskId && req.body?.revision) {
        return executeTaskPlan(ctx, {
          taskId: req.body.taskId,
          revision: req.body.revision,
        });
      }

      const token = String(req.body?.proposalToken ?? '');
      const proposal = verifyCopilotProposal(token, ctx);
      const def = getCommand(proposal.command);
      if (!def || def.ai.exposed === false || def.system === true) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { command: proposal.command, reason: 'copilot_command_not_exposed' },
        });
      }
      const parsed = def.input.safeParse(proposal.input);
      if (!parsed.success) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'copilot_proposal_schema_changed' },
        });
      }

      const out = await dispatch(proposal.command, parsed.data, { ...ctx, actorKind: 'ai' }, {
        idempotencyKey: `copilot:${proposal.proposalId}`,
      });
      const undo = reversibleCopilotProposal(ctx, proposal, out.result);
      if (['appointment.create', 'appointment.reschedule', 'appointment.cancel', 'form.share'].includes(proposal.command)) {
        const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
        void flushEmails(tenant, req.log);
        void flushSms(tenant, req.log);
      }
      return {
        ...out,
        proposalId: proposal.proposalId,
        command: proposal.command,
        ...(undo ? {
          undoProposalToken: undo.token,
          undoExpiresAt: undo.payload.expiresAt,
        } : {}),
      };
    },
  );
}

export function finalizeCopilotProposal(
  proposal: { command: string; input: Record<string, unknown>; summary: string } | null,
  ctx: CommandContext,
  log: { warn: (o: unknown, m: string) => void },
) {
  if (!proposal) return null;
  const def = getCommand(proposal.command);
  if (!def || def.ai.exposed === false || def.system === true) {
    log.warn({ command: proposal.command }, 'copilot proposed unknown or hidden command');
    return null;
  }
  if (def.permission && !ctx.permissions.has(def.permission as Permission)) {
    log.warn({ command: proposal.command, need: def.permission }, 'copilot proposed forbidden command');
    return null;
  }
  const parsed = def.input.safeParse(proposal.input);
  if (!parsed.success) {
    log.warn({ command: proposal.command, issues: parsed.error.issues }, 'copilot proposed invalid command input');
    return null;
  }
  const canonicalInput = parsed.data as Record<string, unknown>;
  if (proposal.command === 'appointment.create') canonicalInput['source'] = 'ai_copilot';
  const issued = issueCopilotProposal(
    ctx,
    proposal.command,
    canonicalInput,
    proposal.summary,
  );
  return {
    command: proposal.command,
    input: canonicalInput,
    summary: proposal.summary,
    confirm: def.ai.confirm,
    proposalId: issued.payload.proposalId,
    proposalToken: issued.token,
    expiresAt: issued.payload.expiresAt,
  };
}

function reversibleCopilotProposal(
  ctx: CommandContext,
  proposal: { command: string; input: Record<string, unknown> },
  result: unknown,
) {
  if (proposal.command === 'appointment.create') {
    const appt = result as { appointmentId?: string };
    if (!appt?.appointmentId) return null;
    return issueCopilotProposal(
      ctx,
      'appointment.cancel',
      { appointmentId: appt.appointmentId, reason: 'input_error', notifyCustomer: false },
      '撤销刚才创建的预约',
      new Date(),
      60_000,
    );
  }
  return null;
}
