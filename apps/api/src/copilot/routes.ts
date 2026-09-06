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
 * 7. 非流式入口 /v1/ai/copilot（SSE 不可用时的回退）；
 * 8. /v1/ai/copilot/execute —— **只用于撤销令牌**，不再承担正向执行。
 *
 * ## 执行只有一条路：task + revision
 *
 * 早先这里在返回方案的同时，还会把 `planRevision.steps[0]` 单独签发成一个
 * legacy `proposalToken` 发给前端，于是同一个方案有两条执行通道：
 * 走 token 的那条只执行第 0 步、且完全不回写 `copilot_tasks` 状态，任务
 * 仍停在 `ready`，前台再点一次卡片就会把整批**重跑一遍** —— 同一单建两次。
 * 多步方案里第 1 步之后的步骤在 legacy 卡片上还会静默消失。
 *
 * 现在正向执行**只有** `POST /tasks/:id/execute` 一条路，它有 CAS 抢锁和
 * 幂等重放。`proposalToken` 只留给执行完之后签发的撤销令牌。
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
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
import {
  costMillicentsNormalized,
  billableTokensNormalized,
  millicentsToCents,
  LUNA_MODEL,
  type NormalizedUsage,
  formatStoreProfile,
  formatBookingCalendar,
  roughTokens,
  CONTEXT_TOKEN_BUDGETS,
  type TimeAnchor,
} from '@gf/ai';
import { dispatch } from '../bus.js';
import { assertAiAdmission } from '../billing/aiAdmission.js';
import { maybeAutoTopup } from '../billing/autoTopup.js';
import { loadFloorSnapshot } from '../queries/floorSnapshot.js';
import { loadStoreProfile } from '../queries/storeProfile.js';
import { loadBookingCalendar } from '../queries/bookingCalendar.js';
import { COPILOT_BODY_LIMIT, parseCopilotImage } from './image.js';
import {
  beginCopilotTurn,
  completeCopilotTurn,
  deleteCopilotSession,
  loadCopilotSessions,
} from './sessionStore.js';
import { verifyCopilotProposal } from './proposalToken.js';
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

/** 任务事件流的增量轮询间隔 */
const TASK_EVENT_POLL_MS = 1_000;
/** 任务事件流的最长挂起时间。超过就让客户端带 ?after= 重连 */
const TASK_EVENT_STREAM_MAX_MS = 10 * 60_000;

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

/**
 * 一轮对话要用的全部上下文，一次查齐。
 *
 * `/turns`、`/stream`、`/v1/ai/copilot` 三条路共用这一个函数 —— 早先三处
 * 各自抄了一遍取数逻辑，改一处漏两处，模型在不同入口看到的世界不一样。
 */
async function buildCopilotContext(ctx: CommandContext, log: FastifyBaseLogger): Promise<{
  timeAnchor: TimeAnchor;
  snapshot: Awaited<ReturnType<typeof loadFloorSnapshot>>;
  storeProfileText: string;
  calendarText: string;
}> {
  const timeAnchor = await buildTimeAnchor(ctx);

  const { snapshot, profile, calendar } = await withTenant(ctx, async (tx) => ({
    snapshot: await loadFloorSnapshot(tx, ctx),
    profile: await loadStoreProfile(tx, ctx),
    calendar: await loadBookingCalendar(tx, ctx, timeAnchor.businessDate, timeAnchor.timezone),
  }));

  const storeProfileText = formatStoreProfile(profile);
  const calendarText = formatBookingCalendar(calendar);

  // 预算告警。这几个数字不是省钱阈值（实测 input 极便宜），而是异常探针：
  // 某一段突然翻十倍，通常意味着一条 SQL 漏了 location 过滤。
  const sizes = {
    storeProfile: roughTokens(storeProfileText),
    calendar: roughTokens(calendarText),
    services: profile.services.length,
    staff: profile.staff.length,
    rooms: profile.rooms.length,
    appointments: calendar.days.reduce((n, d) => n + d.items.length, 0),
  };
  log.debug(sizes, 'copilot context assembled');
  if (sizes.storeProfile > CONTEXT_TOKEN_BUDGETS.STORE_PROFILE) {
    log.warn({ ...sizes, budget: CONTEXT_TOKEN_BUDGETS.STORE_PROFILE }, 'copilot store profile over budget');
  }
  if (sizes.calendar > CONTEXT_TOKEN_BUDGETS.BOOKING_CALENDAR) {
    log.warn({ ...sizes, budget: CONTEXT_TOKEN_BUDGETS.BOOKING_CALENDAR }, 'copilot booking calendar over budget');
  }

  return { timeAnchor, snapshot, storeProfileText, calendarText };
}

/**
 * 副驾一轮对话的用量落库与扣费。
 *
 * ⚠️ **这段在 Luna 重构（cbf4487）里被整个漏掉了。**
 *
 * 重构前的副驾路由会 `dispatch('ai.recordAssist', …)`，由 `handlers/ai.ts`
 * 在同一个事务里往 `usage_events` 记一条、从 `credit_ledger` 扣一笔积分。
 * 重构后的三条入口都只算了个 `costCents` 交给前端显示，**记账那一步没了** ——
 * 于是自那以后每一次副驾提问：
 *   - `usage_events` 里没有 ai_assist 行（成本报表看不到副驾）；
 *   - `credit_ledger` 不扣积分（门店在免费用）；
 *   - `assertAiAdmission` 的「额度耗尽就拒」因此永远不会触发，
 *     成本敞口没有上界 —— 而那个闸门存在的全部意义就是给它一个上界。
 *
 * ⚠️ 记账失败**不能**让这一轮失败：模型已经调完、钱已经花出去了，
 * 这时候抛错只会让前台看到「AI 出错」而账本依旧对不上。记 warn 让运维捞。
 */
async function recordCopilotUsage(
  ctx: CommandContext,
  result: { usage: NormalizedUsage; rounds: number; planRevision: unknown },
  log: FastifyBaseLogger,
): Promise<number> {
  const costMillicents = costMillicentsNormalized(result.usage);
  const costCents = millicentsToCents(costMillicents);

  try {
    await dispatch('ai.recordAssist', {
      feature: 'desk_copilot',
      model: LUNA_MODEL,
      tokens: billableTokensNormalized(result.usage),
      costMillicents,
      // rounds 的契约上限是 10，编排器的上限是 6；夹一下以防日后有人调高了
      // COPILOT_MAX_ROUNDS 却忘了这里 —— 那会让记账整条失败。
      rounds: Math.max(1, Math.min(10, result.rounds)),
      hadProposal: result.planRevision !== null,
    }, ctx, { systemOrigin: 'anthropic_usage' });
  } catch (err) {
    log.warn({ err, costMillicents }, 'copilot usage recording failed');
  }

  if (costCents > 0) {
    try {
      await maybeAutoTopup(ctx, 'credit', log);
    } catch (err) {
      log.warn({ err }, 'maybeAutoTopup failed after copilot turn');
    }
  }

  return costCents;
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

    const turn = await beginCopilotTurn(ctx, req.body?.sessionId, question, Boolean(imageInput));
    const context = await buildCopilotContext(ctx, req.log);

    const readOnlyExecutors = createReadOnlyToolExecutors(ctx);

    // AUD-03 准入闸门：调模型紧邻的前一行
    await assertAiAdmission(ctx);
    const result = await runCopilotOrchestration(ctx, {
      question,
      sessionId: turn.sessionId,
      history: turn.history,
      taskId: req.body?.taskId,
      image: imageInput ? { base64: imageInput.base64, mediaType: imageInput.mediaType } : undefined,
      ...context,
      readOnlyExecutors,
    });

    const costCents = await recordCopilotUsage(ctx, result, req.log);

    await completeCopilotTurn(ctx, turn, {
      answer: result.answer,
      source: 'model',
      proposal: summariseRevisionForHistory(result.planRevision),
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

      // ⚠️ 这里以前回放完历史事件就直接 `reply.raw.end()` —— 名义上是 SSE，
      // 实际上是一个一次性的 GET。执行过程中产生的 STEP_STARTED /
      // STEP_SUCCEEDED 事件前端一个也收不到，任务进度只能靠 execute 那一发
      // 同步 POST 的返回值一次性看到。
      //
      // 现在保持连接：先补齐 ?after= 之后的历史，然后按 1 秒轮询增量推送，
      // 任务进入终态就正常收尾。事件表本身就是有序 seq 的追加日志，轮询它
      // 比引入进程内 pub/sub 简单得多，而且多实例部署下天然正确。
      let lastSeq = Number(req.query.after ?? 0);
      if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0;

      let closed = false;
      const keepalive = setInterval(() => {
        if (closed) { clearInterval(keepalive); return; }
        try { reply.raw.write(': ping\n\n'); } catch { closed = true; }
      }, 15_000);
      const finish = () => {
        clearInterval(keepalive);
        if (closed) return;
        closed = true;
        try { reply.raw.end(); } catch { /* 客户端已断开 */ }
      };
      reply.raw.on('close', () => { closed = true; clearInterval(keepalive); });

      const TERMINAL = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);
      const deadline = Date.now() + TASK_EVENT_STREAM_MAX_MS;

      try {
        while (!closed && Date.now() < deadline) {
          const events = await getTaskEventsAfter(ctx, req.params.id, lastSeq);
          for (const ev of events) {
            lastSeq = Math.max(lastSeq, ev.seq);
            reply.raw.write(
              `id: ${ev.seq}\nevent: ${ev.eventType}\ndata: ${JSON.stringify(ev.payload)}\n\n`,
            );
          }

          const current = await getTask(ctx, req.params.id);
          if (!current || TERMINAL.has(current.status)) break;

          await new Promise((resolve) => setTimeout(resolve, TASK_EVENT_POLL_MS));
        }
      } catch (err) {
        req.log.warn({ err, taskId: req.params.id }, 'copilot task event stream aborted');
      } finally {
        finish();
      }
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

      // 提取原计划入参并合并修改。
      //
      // ⚠️ 同一个 stepIndex 可能收到多条修改（一单里的两个项目各改各的时间），
      // 所以按 stepIndex 收集成数组，不能用 find 只取第一条。
      const modsByStep = new Map<number, NonNullable<CopilotReviseRequest['modifications']>>();
      for (const mod of req.body.modifications ?? []) {
        const list = modsByStep.get(mod.stepIndex) ?? [];
        list.push(mod);
        modsByStep.set(mod.stepIndex, list);
      }

      const modifiedSteps = currentRevData.steps.map((st) => {
        const resolvedInput = JSON.parse(JSON.stringify(st.resolvedInput));
        const items: Array<Record<string, unknown>> = Array.isArray(resolvedInput['items'])
          ? resolvedInput['items']
          : [];

        for (const mod of modsByStep.get(st.stepIndex) ?? []) {
          // itemIndex 缺省时改整步的所有项目 —— 「把这单整体挪到 18:00」是
          // 前台最常见的说法；旧实现写死 items[0]，多项目的单只挪得动头一项，
          // 剩下的还留在原时间，结果是一单被拆成两个时段。
          const targets = mod.itemIndex === undefined
            ? items
            : (items[mod.itemIndex] ? [items[mod.itemIndex]!] : []);

          for (const item of targets) {
            if (mod.startsAt) item['startsAt'] = mod.startsAt;
            if (mod.membershipId !== undefined) item['membershipId'] = mod.membershipId;
            if (mod.resourceId !== undefined) item['resourceId'] = mod.resourceId;
          }

          // resource.setStatus 这类命令的 resourceId 在顶层，不在 items 里
          if (mod.resourceId !== undefined && items.length === 0) {
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

    const keepaliveTimer = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(keepaliveTimer);
      }
    }, 10_000);

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

      const turn = await beginCopilotTurn(ctx, req.body?.sessionId, question, Boolean(imageInput));
      const context = await buildCopilotContext(ctx, req.log);

      const readOnlyExecutors = createReadOnlyToolExecutors(ctx);

      // AUD-03 准入闸门
      await assertAiAdmission(ctx);
      const result = await runCopilotOrchestration(ctx, {
        question,
        sessionId: turn.sessionId,
        history: turn.history,
        image: imageInput ? { base64: imageInput.base64, mediaType: imageInput.mediaType } : undefined,
        ...context,
        readOnlyExecutors,
        callbacks: {
          onStep: (step) => sendEvent({ type: 'step', step }),
          onDelta: (delta) => sendEvent({ type: 'delta', delta }),
        },
      });

      const costCents = await recordCopilotUsage(ctx, result, req.log);

      await completeCopilotTurn(ctx, turn, {
        answer: result.answer,
        source: 'model',
        proposal: summariseRevisionForHistory(result.planRevision),
        toolsUsed: result.toolsUsed,
      });

      sendEvent({
        type: 'done',
        answer: result.answer,
        source: 'model',
        costCents,
        sessionId: turn.sessionId,
        toolsUsed: result.toolsUsed,
        taskId: result.task.id,
        planRevision: result.planRevision,
        canonicalHash: result.canonicalHash,
        revision: result.revision,
        clarification: result.clarification,
      });
    } catch (err: any) {
      req.log.error({ err }, 'copilot stream error');
      sendEvent({
        type: 'error',
        error: err?.message || 'AI processing error',
      });
    } finally {
      clearInterval(keepaliveTimer);
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

    const turn = await beginCopilotTurn(ctx, req.body?.sessionId, question, Boolean(imageInput));
    const context = await buildCopilotContext(ctx, req.log);

    const readOnlyExecutors = createReadOnlyToolExecutors(ctx);

    // AUD-03 准入闸门
    await assertAiAdmission(ctx);
    const result = await runCopilotOrchestration(ctx, {
      question,
      sessionId: turn.sessionId,
      history: turn.history,
      image: imageInput ? { base64: imageInput.base64, mediaType: imageInput.mediaType } : undefined,
      ...context,
      readOnlyExecutors,
    });

    const costCents = await recordCopilotUsage(ctx, result, req.log);

    await completeCopilotTurn(ctx, turn, {
      answer: result.answer,
      source: 'model',
      proposal: summariseRevisionForHistory(result.planRevision),
      toolsUsed: result.toolsUsed,
    });

    return {
      answer: result.answer,
      source: 'model' as const,
      costCents,
      sessionId: turn.sessionId,
      toolsUsed: result.toolsUsed,
      taskId: result.task.id,
      planRevision: result.planRevision,
      canonicalHash: result.canonicalHash,
      revision: result.revision,
      clarification: result.clarification,
    };
  });

  // ── 9. POST /v1/ai/copilot/execute —— 只用于撤销令牌 ──────────────────────
  //
  // ⚠️ 这条路**不再接受正向执行**。
  //
  // 它以前既能跑撤销令牌，也能跑正向的方案令牌，还能用 taskId+revision 走
  // 一遍不加锁的执行 —— 三条入口共存的结果就是同一个方案被执行两次。
  // 正向执行现在只走 `POST /tasks/:id/execute`（有 CAS 抢锁与幂等重放）。
  app.post<{ Body: { proposalToken?: string } }>(
    '/v1/ai/copilot/execute',
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      const token = String(req.body?.proposalToken ?? '');
      const proposal = verifyCopilotProposal(token, ctx);

      if (!UNDO_COMMANDS.has(proposal.command)) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: {
            command: proposal.command,
            reason: 'copilot_forward_execution_must_use_task_endpoint',
          },
        });
      }

      const def = getCommand(proposal.command);
      if (!def || def.ai.exposed === false || def.system === true) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { command: proposal.command, reason: 'copilot_command_not_exposed' },
        });
      }
      if (def.permission && !ctx.permissions.has(def.permission as Permission)) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { command: proposal.command, need: def.permission },
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
      const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
      void flushEmails(tenant, req.log);
      void flushSms(tenant, req.log);

      return { ...out, proposalId: proposal.proposalId, command: proposal.command };
    },
  );
}

/**
 * 允许经 `proposalToken` 执行的命令白名单。
 *
 * 只有执行成功之后由 `executor.ts` 反签发的撤销动作在列。任何正向写入
 * （建单、改期、发短信…）都必须走 task + revision 那条有锁的路。
 */
export const UNDO_COMMANDS = new Set(['appointment.cancel']);

/**
 * 会话历史里给方案留的一行摘要。
 *
 * 只用于「上一轮我提了什么」的对话记忆，**不含任何可执行令牌** ——
 * 历史里放令牌正是当初重复建单的来源。
 */
export function summariseRevisionForHistory(
  planRevision: { title: string; steps: Array<{ command: string; summary: string }> } | null,
): { command: string; summary: string } | null {
  if (!planRevision || planRevision.steps.length === 0) return null;
  const first = planRevision.steps[0]!;
  if (planRevision.steps.length === 1) {
    return { command: first.command, summary: first.summary };
  }
  return {
    command: `${first.command} 等 ${planRevision.steps.length} 项`,
    summary: planRevision.title,
  };
}
