/**
 * 前台 AI 副驾的入口（05 §6）
 *
 * ## 为什么这条路由不走 /v1/commands
 *
 * 和 `POST /v1/blueprint/:id/extract` 是同一个理由（server.ts 有长注释）：
 * 模型调用要几秒，而命令都跑在数据库事务里 —— 塞进去会占住连接和快照。
 *
 * 这里只做编排：**查快照 → 问模型 → 把提案原样返回**。
 * 提案**不执行** —— 前台在卡片上点确认，那一下才走 `/v1/commands/:name`，
 * 用的是**她自己的身份**，权限、容量检查、审计、撤销窗口一样不少。
 *
 * ## 三道安全边界（05 §10）
 *
 * 1. **AI 的权限 ⊆ 操作人的权限。** 提案由前台自己的会话执行，
 *    所以模型提一条她没权限的命令，结果是 PERMISSION_DENIED —— 没有后门。
 * 2. **AI 调不了未注册的命令。** `propose_command` 的 `command` 是
 *    strict tool use 的枚举，取自 `commandCatalogText()`。
 * 3. **AI 不写数据库。** 这个文件里一次 `dispatch` 写操作都没有，
 *    只有一条记用量的。
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, commandCatalogText, getCommand, pickText,
  type CommandContext,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import {
  askCopilot, formatFloorSnapshot, routeLocally, roughTokens,
  SNAPSHOT_TOKEN_BUDGET, SONNET_5_RATES, COPILOT_MODEL,
  costMillicents, billableTokens,
  type ReadOnlyTool, type CopilotImageInput,
} from '@gf/ai';
import { dispatch } from '../bus';
import { loadFloorSnapshot } from '../queries/floorSnapshot';
import { loadSlotContext, summariseSlots } from '../queries/slots';
import { loadRooms } from '../queries/rooms';
import { loadCustomerAnalytics, loadRevenueTrends } from '../queries/analytics';
import { loadCustomerDetail } from '../queries/customer';
import { loadStaffDirectory } from '../queries/staffList';
import { loadRoster } from '../queries/roster';
import { loadDeskSettings, loadCheckoutSettings } from '../queries/settings';
import { loadPackages } from '../queries/marketing';
import { loadReviewsSummary } from '../queries/reviews';
import { maybeAutoTopup } from '../billing/autoTopup';
import type { CtxFromHeaders } from '../stripe/routes';

/** 一次提问最多多长。再长的多半是粘贴进来的东西，不是一句问话 */
const MAX_QUESTION_CHARS = 2000;

export function registerCopilotRoutes(
  app: FastifyInstance,
  ctxFromHeaders: CtxFromHeaders,
): void {

  app.post<{ Body: {
    question?: string;
    sessionId?: string;
    image?: { base64: string; mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' };
    history?: Array<{ role?: string; text?: string }>;
  } }>('/v1/ai/copilot', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }

    let question = (req.body?.question ?? '').trim();
    const hasImage = Boolean(req.body?.image?.base64);

    if (!question && hasImage) {
      question = '请分析这张预约截图中的信息，识别客人姓名、手机号、服务项目、预约时间、技师和金额，并提议创建预约。';
    }

    if (!question || question.length > MAX_QUESTION_CHARS) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: `问题要在 1–${MAX_QUESTION_CHARS} 个字之间`, got: question.length },
      });
    }

    // ── 1. 现场快照 ───────────────────────────────────────────────────────
    const snapshot = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadFloorSnapshot(tx, ctx));

    const snapshotText = formatFloorSnapshot(snapshot);

    // 快照悄悄膨胀是成本失控最常见的起点（05 §7.2 第 1 条）。
    // 超预算就告警，而不是默默多付钱
    const snapTokens = roughTokens(snapshotText);
    if (snapTokens > SNAPSHOT_TOKEN_BUDGET) {
      req.log.warn({ snapTokens, budget: SNAPSHOT_TOKEN_BUDGET, locationId: ctx.locationId },
                   'copilot snapshot over token budget');
    }

    // ── 2. 先试确定性路由 (无图片时才尝试本地快速响应) ────────────────────
    //
    // ⭐ **最省钱的 AI 调用是没发生的那次**（05 §7.2 第 3 条）。
    // 前台 60–70% 的提问是「几个人在等」「谁有空」，答案快照里已经有了
    if (!hasImage) {
      const local = routeLocally(question, snapshot);
      if (local) {
        return {
          answer: local.text,
          proposal: null,
          source: 'local' as const,
          intent: local.intent,
          costCents: 0,
          snapshot: snapshotText,
        };
      }
    }

    // ── 3. 问模型 ────────────────────────────────────────────────────────
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      req.log.error('ANTHROPIC_API_KEY 未配置，前台副驾不可用');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    }

    const imageInput: CopilotImageInput | undefined = hasImage && req.body?.image
      ? {
          base64: req.body.image.base64,
          mediaType: req.body.image.mediaType ?? 'image/png',
        }
      : undefined;

    const result = await askCopilot({
      apiKey,
      commandCatalog: commandCatalogText(),
      snapshot: snapshotText,
      question,
      image: imageInput,
      history: (req.body?.history ?? [])
        .filter((h): h is { role: 'user' | 'assistant'; text: string } =>
          (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
        .slice(-3),
      tools: readOnlyTools(ctx),
      log: req.log,
    });

    /**
     * ⚠️ 缓存没命中要看得见。
     *
     * 系统提示 + 命令目录逐字节稳定时，第二次调用起 `cacheRead` 就该 > 0。
     * 一直是 0 说明有东西在偷偷让缓存失效（05 §6.2），而表现只是
     * 「账单比预期高一点」—— 不主动看根本发现不了。
     */
    req.log.info({
      locationId: ctx.locationId,
      cacheRead: result.usage.cacheReadInputTokens ?? 0,
      cacheWrite: result.usage.cacheCreationInputTokens ?? 0,
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
      rounds: result.rounds,
      toolsUsed: result.toolsUsed,
      snapTokens,
    }, 'copilot call');

    // ── 4. 提案的最后一道关：命令必须存在且暴露给 AI ────────────────────
    //
    // strict tool use 的枚举理论上保证了这一点，但**枚举是从文本里抽的**，
    // 而文本是我们自己生成的 —— 这里再确认一次，代价是一次 map 查找
    let proposal = result.proposal;
    if (proposal) {
      const def = getCommand(proposal.command);
      if (!def || def.ai.exposed === false) {
        req.log.warn({ command: proposal.command }, 'copilot proposed unknown command');
        proposal = null;
      } else {
        proposal = { ...proposal, confirm: def.ai.confirm };
      }
    }

    // ── 5. 记用量并扣费 ──────────────────────────────────────────────────
    const cost = costMillicents(result.usage, SONNET_5_RATES);
    const charged = await recordUsage(ctx, {
      tokens: billableTokens(result.usage),
      costMillicents: cost,
      rounds: result.rounds,
      hadProposal: Boolean(proposal),
    }, req.log);

    // 扣完费顺手看一眼要不要自动续充（事务外，失败只记日志）
    void maybeAutoTopup(ctx, 'credit', req.log);

    return {
      answer: result.answer,
      proposal,
      source: 'model' as const,
      model: COPILOT_MODEL,
      rounds: result.rounds,
      toolsUsed: result.toolsUsed,
      stopped: result.stopped ?? null,
      costCents: charged,
      snapshot: snapshotText,
      sessionId: req.body?.sessionId ?? null,
    };
  });

  app.post<{ Body: {
    question?: string;
    sessionId?: string;
    image?: { base64: string; mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' };
    history?: Array<{ role?: string; text?: string }>;
  } }>('/v1/ai/copilot/stream', async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }

    let question = (req.body?.question ?? '').trim();
    const hasImage = Boolean(req.body?.image?.base64);

    if (!question && hasImage) {
      question = '请分析这张预约截图中的信息，识别客人姓名、手机号、服务项目、预约时间、技师和金额，并提议创建预约。';
    }

    if (!question || question.length > MAX_QUESTION_CHARS) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: `问题要在 1–${MAX_QUESTION_CHARS} 个字之间`, got: question.length },
      });
    }

    const origin = req.headers.origin;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    if (origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'false');
      reply.raw.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Membership-Id');
    }
    reply.raw.statusCode = 200;

    const sendEvent = (event: Record<string, unknown>) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {}
    };

    sendEvent({ type: 'step', step: '⚡ 正在读取现场快照与工位状态...' });

    // ── 1. 现场快照 ───────────────────────────────────────────────────────
    const snapshot = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadFloorSnapshot(tx, ctx));

    const snapshotText = formatFloorSnapshot(snapshot);

    // ── 2. 先试确定性路由 ──────────────────────────────────────────────────
    if (!hasImage) {
      const local = routeLocally(question, snapshot);
      if (local) {
        sendEvent({ type: 'step', step: '⚡ 本地规则引擎即时命中' });
        sendEvent({ type: 'delta', delta: local.text });
        sendEvent({
          type: 'done',
          answer: local.text,
          proposal: null,
          source: 'local',
          intent: local.intent,
          costCents: 0,
          snapshot: snapshotText,
          sessionId: req.body?.sessionId ?? null,
        });
        reply.raw.end();
        return;
      }
    }

    // ── 3. 问模型 ────────────────────────────────────────────────────────
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      sendEvent({ type: 'error', error: 'ANTHROPIC_API_KEY 未配置，前台副驾不可用' });
      reply.raw.end();
      return;
    }

    sendEvent({ type: 'step', step: '🧠 正在分析技师技能与智能排单...' });

    const imageInput: CopilotImageInput | undefined = hasImage && req.body?.image
      ? {
          base64: req.body.image.base64,
          mediaType: req.body.image.mediaType ?? 'image/png',
        }
      : undefined;

    let streamedText = '';

    const result = await askCopilot({
      apiKey,
      commandCatalog: commandCatalogText(),
      snapshot: snapshotText,
      question,
      image: imageInput,
      history: (req.body?.history ?? [])
        .filter((h): h is { role: 'user' | 'assistant'; text: string } =>
          (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
        .slice(-3),
      tools: readOnlyTools(ctx),
      callbacks: {
        onStep: (step) => {
          sendEvent({ type: 'step', step });
        },
        onDelta: (delta) => {
          streamedText += delta;
          sendEvent({ type: 'delta', delta });
        },
      },
      log: req.log,
    });

    let proposal = result.proposal;
    if (proposal) {
      const def = getCommand(proposal.command);
      if (!def || def.ai.exposed === false) {
        req.log.warn({ command: proposal.command }, 'copilot proposed unknown command');
        proposal = null;
      } else {
        proposal = { ...proposal, confirm: def.ai.confirm };
      }
      sendEvent({ type: 'proposal', proposal });
    }

    // ── 4. 记用量并扣费 ──────────────────────────────────────────────────
    const cost = costMillicents(result.usage, SONNET_5_RATES);
    const charged = await recordUsage(ctx, {
      tokens: billableTokens(result.usage),
      costMillicents: cost,
      rounds: result.rounds,
      hadProposal: Boolean(proposal),
    }, req.log);

    void maybeAutoTopup(ctx, 'credit', req.log);

    sendEvent({
      type: 'done',
      answer: result.answer || streamedText,
      proposal,
      source: 'model',
      costCents: charged,
      snapshot: snapshotText,
      toolsUsed: result.toolsUsed,
      sessionId: req.body?.sessionId ?? null,
    });

    reply.raw.end();
  });

  /**
   * 只读工具集。
   *
   * ⚠️ **每一个都必须是只读的。** 模型可以随便调、调多少次都行，
   * 不用前台确认 —— 这个性质是整个设计成立的前提（05 §6.3）。
   * 想加一个「顺便帮她建一下」的工具时，回来读这一句。
   *
   * 每个工具都在自己的 `withTenant` 里跑，所以 RLS 照常生效：
   * 模型问不出别的店的数据，问不出它无权看的字段。
   */
  function readOnlyTools(ctx: CommandContext): ReadOnlyTool[] {
    const tenant = {
      orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId,
    };

    return [
      {
        name: 'find_customer',
        description:
          '按姓名或手机号找客人，返回 id、上次到店时间。' +
          '**同名多人会全部返回** —— 这时候要在回答里让前台点一个，不要自己挑。',
        inputSchema: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: '姓名的一部分，或手机号后几位' },
          },
        },
        run: async (input) => {
          const raw = String(input['query'] ?? '').trim();
          if (raw.length < 2) return { customers: [], note: '关键词太短' };
          const digits = raw.replace(/\D/g, '');
          const byPhone = digits.length >= 3;

          const rows = await withTenant(tenant, (tx) => byPhone
            ? tx<CustomerHit[]>`
                select c.id, c.display_name, c.phone_e164, c.no_show_count,
                       (select max(a.business_date)::text from appointments a
                         where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
                from customers c
                where c.merged_into_id is null
                  and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
                order by c.display_name limit 8`
            : tx<CustomerHit[]>`
                select c.id, c.display_name, c.phone_e164, c.no_show_count,
                       (select max(a.business_date)::text from appointments a
                         where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
                from customers c
                where c.merged_into_id is null and c.display_name ilike ${'%' + raw + '%'}
                order by c.display_name limit 8`);

          return {
            // 决策 21：同号多人必须让前台选，这句话直接写进返回里 ——
            // 比藏在 system prompt 里可靠得多
            guidance: rows.length > 1
              ? '找到多位。请把他们列出来让前台点一位，不要替她选。'
              : undefined,
            customers: rows.map((r) => ({
              customerId: r.id,
              name: r.display_name,
              // 决策 23：快照和副驾不脱敏 —— 前台需要一眼认人
              phone: ctx.permissions.has('customer.view_contact')
                ? r.phone_e164
                : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
              lastVisitOn: r.last_visit_on,
              noShowCount: r.no_show_count,
            })),
          };
        },
      },

      {
        name: 'find_open_slots',
        description:
          '查真实空档。**报时间之前必须先调这个** —— ' +
          '你自己按时长推算出来的时间，店里可能根本没有那个空档。',
        inputSchema: {
          type: 'object',
          required: ['durationMin'],
          additionalProperties: false,
          properties: {
            durationMin: { type: 'number', description: '要多长时间（分钟）' },
            around: { type: 'string', description: 'ISO 时间，大概在什么时候。不给就是现在' },
            staffName: { type: 'string', description: '客人指名的技师姓名。不指名就不填' },
          },
        },
        run: async (input) => {
          const durationMin = Number(input['durationMin']) || 45;
          const aroundRaw = input['around'];
          const around = typeof aroundRaw === 'string' ? new Date(aroundRaw) : new Date();
          if (Number.isNaN(around.getTime())) return { error: 'around 不是合法时间' };

          const wanted = typeof input['staffName'] === 'string' ? input['staffName'] : null;
          const preferred = wanted ? await membershipByName(wanted) : null;
          // 指名了但找不到这个人：**别退回成「查所有人」** ——
          // 那会报一堆别的技师的空档，在电话里是彻底的答非所问
          if (wanted && !preferred) {
            return { error: `店里没有叫「${wanted}」的可排单技师`, slots: [] };
          }

          const { businessDate, timezone, slots } = await withTenant(tenant,
            (tx) => loadSlotContext(tx, ctx.locationId, around, durationMin, preferred));

          const top = summariseSlots(slots, minutesOf(around, timezone), 5);
          return {
            businessDate,
            timezone,
            guidance: top.length === 0
              ? '这一天没有空档。告诉前台换一天，不要自己另报时间。'
              : '只能从下面这些时间里选，不要自己推算别的时间。',
            slots: top.map((s) => ({ startsAt: s.startsAt.toISOString(), staff: s.staff })),
          };
        },
      },

      {
        name: 'get_appointments',
        description:
          '查某一天的预约。**只查今天以外的日子用它** —— ' +
          '今天的已经在现场快照里了，再查一遍是白花钱。',
        inputSchema: {
          type: 'object',
          required: ['businessDate'],
          additionalProperties: false,
          properties: {
            businessDate: { type: 'string', description: 'YYYY-MM-DD' },
          },
        },
        run: async (input) => {
          const date = String(input['businessDate'] ?? '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日期要写成 YYYY-MM-DD' };

          const rows = await withTenant(tenant, (tx) => tx<{
            item_id: string; appointment_id: string; starts_at: string | Date;
            duration_min: number; customer_name: string | null; walk_in_name: string | null;
            service_name: unknown; staff_name: unknown; status: string; is_request: boolean;
          }[]>`
            select ai.id as item_id, ai.appointment_id, ai.starts_at, ai.duration_min,
                   c.display_name as customer_name, a.walk_in_name,
                   s.name as service_name, sp.display_name as staff_name,
                   ai.status, ai.is_request
            from appointment_items ai
            join appointments a on a.id = ai.appointment_id
            join services s on s.id = ai.service_id
            left join staff_profiles sp on sp.membership_id = ai.membership_id
            left join customers c on c.id = a.customer_id
            where ai.location_id = ${ctx.locationId}
              and a.business_date = ${date}
              and ai.status <> 'cancelled'
            order by ai.starts_at limit 40`);

          return {
            businessDate: date,
            appointments: rows.map((r) => ({
              // ⭐ id 必须给：模型要提 reschedule / cancel 的提案就得有它，
              // 而快照里刻意不带 id（省 token，也避免它记错）
              appointmentId: r.appointment_id,
              itemId: r.item_id,
              startsAt: new Date(r.starts_at).toISOString(),
              durationMin: r.duration_min,
              customer: r.customer_name ?? r.walk_in_name ?? '临时客人',
              service: pickText(r.service_name, ctx.locale),
              staff: r.staff_name ? pickText(r.staff_name, ctx.locale) : null,
              status: r.status,
              isRequest: r.is_request,
            })),
          };
        },
      },

      {
        /**
         * ⭐ 没有这个工具，任何针对技师的命令都提不对。
         *
         * 实测漏掉它的后果：问「把 Kim 标记成休息中」，模型给出
         * `rotation.setBreak { membershipId: "Kim" }` —— 一个名字填在
         * uuid 字段上。Zod 会拦下来（前台看到「参数不对」），但那次调用
         * 的钱已经花了，而且前台会觉得这个功能不好用。
         *
         * 快照里刻意不带 uuid（省 token、也避免模型记错），
         * 所以「名字 → id」必须有一条明确的路。
         */
        name: 'list_staff',
        description:
          '列出本店的技师（membershipId、姓名、今天是否可排单）。'
          + '**任何要填 membershipId 的命令都得先调这个** —— '
          + '现场快照里只有名字没有 id，不要自己编一个。',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        run: async () => {
          const rows = await withTenant(tenant, (tx) => tx<{
            membership_id: string; display_name: unknown; is_bookable: boolean;
            level_key: string | null;
          }[]>`
            select sp.membership_id, sp.display_name, sp.is_bookable, sl.key as level_key
            from staff_profiles sp
            join memberships m on m.id = sp.membership_id and m.status = 'active'
            left join staff_levels sl on sl.id = sp.level_id
            where sp.location_id = ${ctx.locationId}
            order by sp.is_bookable desc, sp.display_name->>'en' limit 100`);
          return {
            staff: rows.map((r) => ({
              membershipId: r.membership_id,
              name: pickText(r.display_name, ctx.locale),
              isBookable: r.is_bookable,
              level: r.level_key,
            })),
          };
        },
      },

      {
        name: 'list_services',
        description: '列出本店在用的项目（名称、时长、价格）。开单和排预约前用它对上项目 id。',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        run: async () => {
          const rows = await withTenant(tenant, (tx) => tx<{
            id: string; name: unknown; duration_min: number; base_price_cents: number;
          }[]>`
            select id, name, duration_min, base_price_cents from services
            where location_id = ${ctx.locationId} and active = true
            order by sort, name->>'en' limit 200`);
          return {
            services: rows.map((r) => ({
              serviceId: r.id,
              name: pickText(r.name, ctx.locale),
              durationMin: r.duration_min,
              priceCents: r.base_price_cents,
            })),
          };
        },
      },

      {
        name: 'list_rooms',
        description:
          '列出本店所有房间与工位资源（名称、resourceId、当前状态 available/cleaning/in_service/maintenance、容量、正在服务中的客人与技师）。'
          + '**变更房间状态（如设置打扫中 cleaning、空闲 available）前必须先调这个查出 resourceId**。',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        run: async () => {
          const { rooms, metrics } = await withTenant(tenant, (tx) => loadRooms(tx, ctx));
          return {
            metrics,
            rooms: rooms.map((r) => ({
              resourceId: r.id,
              name: r.name,
              type: r.type,
              status: r.status,
              capacity: r.capacity,
              currentSession: r.currentSession ? {
                customer: r.currentSession.customerName,
                service: r.currentSession.serviceName,
                staff: r.currentSession.staffNames.join(', '),
                endsAt: r.currentSession.estimatedEndAt,
              } : null,
              upcomingSession: r.upcomingSession ? {
                customer: r.upcomingSession.customerName,
                service: r.upcomingSession.serviceName,
                startsInMinutes: r.upcomingSession.startsInMinutes,
              } : null,
            })),
          };
        },
      },

      {
        name: 'get_revenue_analytics',
        description:
          '查询今日或指定日期区间的门店营收、工单量、客单价指标与品类占比。'
          + '**前台询问今日营收或客单价时必须先调这个**。',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', description: '起始日期 YYYY-MM-DD，不传默认今日' },
            to: { type: 'string', description: '结束日期 YYYY-MM-DD，不传默认今日' },
          },
        },
        run: async (input) => {
          const today = new Date().toISOString().slice(0, 10);
          const from = typeof input['from'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input['from'])
            ? input['from'] : today;
          const to = typeof input['to'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input['to'])
            ? input['to'] : from;

          const [overview, trends] = await withTenant(tenant, async (tx) => {
            const ov = await loadCustomerAnalytics(tx, ctx, from, to);
            const tr = await loadRevenueTrends(tx, ctx, from, to);
            return [ov, tr] as const;
          });

          return {
            dateRange: `${from} ~ ${to}`,
            totalRevenueDollars: (trends.totalRevenueCents / 100).toFixed(2),
            averageTicketDollars: (overview.averageTicketCents / 100).toFixed(2),
            totalVisits: overview.totalVisits,
            newCustomerVisits: overview.newCustomerVisits,
            returningCustomerVisits: overview.returningCustomerVisits,
            retentionRatePercent: (overview.retentionRateBp / 100).toFixed(1) + '%',
            paymentBreakdown: {
              cardDollars: (trends.byPaymentMethod.cardCents / 100).toFixed(2),
              cashDollars: (trends.byPaymentMethod.cashCents / 100).toFixed(2),
              giftCardDollars: (trends.byPaymentMethod.giftCardCents / 100).toFixed(2),
              externalDollars: (trends.byPaymentMethod.externalCents / 100).toFixed(2),
            },
            categories: trends.byCategory.map((c) => ({
              category: c.name,
              revenueDollars: (c.revenueCents / 100).toFixed(2),
              percent: (c.percentBp / 100).toFixed(1) + '%',
            })),
          };
        },
      },

      {
        name: 'list_inactive_customers',
        description:
          '检索超过指定天数（如 60 天）未到店消费的老顾客名单与上次到店时间。用于回答「帮我列出近60天未到店的老顾客」等召回分析。',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'number', description: '未到店天数阈值，默认 60' },
            limit: { type: 'number', description: '返回最多几人，默认 10' },
          },
        },
        run: async (input) => {
          const days = Math.max(1, Math.min(365, Number(input['days']) || 60));
          const limit = Math.max(1, Math.min(50, Number(input['limit']) || 10));

          const rows = await withTenant(tenant, (tx) => tx<{
            id: string; display_name: string; phone_e164: string | null;
            vip_level: number; last_visit_on: string; days_ago: number; visit_count: number;
          }[]>`
            select c.id, c.display_name, c.phone_e164, c.vip_level,
                   max(a.business_date)::text as last_visit_on,
                   (current_date - max(a.business_date)::date)::int as days_ago,
                   count(distinct a.id)::int as visit_count
            from customers c
            join appointments a on a.customer_id = c.id and a.location_id = ${ctx.locationId}
            where c.org_id = ${ctx.orgId}
              and c.merged_into_id is null
              and a.status <> 'cancelled'
            group by c.id, c.display_name, c.phone_e164, c.vip_level
            having max(a.business_date)::date <= current_date - ${days}
            order by max(a.business_date) asc
            limit ${limit}`);

          return {
            thresholdDays: days,
            totalFound: rows.length,
            customers: rows.map((r) => ({
              customerId: r.id,
              name: r.display_name,
              phone: ctx.permissions.has('customer.view_contact')
                ? r.phone_e164
                : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
              vipLevel: r.vip_level,
              lastVisitOn: r.last_visit_on,
              daysInactive: r.days_ago,
              totalVisits: r.visit_count,
            })),
          };
        },
      },

      {
        name: 'get_day_overview',
        description:
          '获取指定日期（默认今日）的全量预约单据统计与列表。当需要查询今天一共有几个预约或总览时调用。',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            businessDate: { type: 'string', description: 'YYYY-MM-DD，默认今日' },
          },
        },
        run: async (input) => {
          const date = String(input['businessDate'] ?? new Date().toISOString().slice(0, 10));
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日期格式为 YYYY-MM-DD' };

          const rows = await withTenant(tenant, (tx) => tx<{
            item_id: string; appointment_id: string; starts_at: string | Date; ends_at: string | Date;
            duration_min: number; customer_name: string | null; walk_in_name: string | null;
            service_name: unknown; staff_name: unknown; status: string; is_request: boolean;
            phone_e164: string | null;
          }[]>`
            select ai.id as item_id, ai.appointment_id, ai.starts_at, ai.ends_at, ai.duration_min,
                   c.display_name as customer_name, a.walk_in_name, c.phone_e164,
                   s.name as service_name, sp.display_name as staff_name,
                   ai.status, ai.is_request
            from appointment_items ai
            join appointments a on a.id = ai.appointment_id
            join services s on s.id = ai.service_id
            left join staff_profiles sp on sp.membership_id = ai.membership_id
            left join customers c on c.id = a.customer_id
            where ai.location_id = ${ctx.locationId}
              and a.business_date = ${date}
              and ai.status <> 'cancelled'
            order by ai.starts_at asc`);

          const countByStatus: Record<string, number> = {};
          for (const r of rows) {
            countByStatus[r.status] = (countByStatus[r.status] ?? 0) + 1;
          }

          return {
            businessDate: date,
            totalAppointments: rows.length,
            statusBreakdown: countByStatus,
            appointments: rows.map((r) => ({
              appointmentId: r.appointment_id,
              itemId: r.item_id,
              customer: r.customer_name ?? r.walk_in_name ?? '客人',
              phone: ctx.permissions.has('customer.view_contact')
                ? r.phone_e164
                : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
              service: pickText(r.service_name, ctx.locale),
              staff: r.staff_name ? pickText(r.staff_name, ctx.locale) : '未指派',
              startsAt: new Date(r.starts_at).toISOString(),
              durationMin: r.duration_min,
              status: r.status,
              isRequest: r.is_request,
            })),
          };
        },
      },

      {
        name: 'get_customer_detail',
        description: '按 customerId 查询客户 360 档案（偏好、过敏禁忌、历史总消费、到店次数、前台备忘）。',
        inputSchema: {
          type: 'object',
          required: ['customerId'],
          additionalProperties: false,
          properties: {
            customerId: { type: 'string', description: '客户 UUID' },
          },
        },
        run: async (input) => {
          const customerId = String(input['customerId'] ?? '').trim();
          if (!customerId) return { error: 'customerId 不能为空' };

          const detail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ctx, customerId));
          if (!detail) return { error: '未找到该客户详情' };

          return {
            name: detail.displayName,
            phone: detail.phone,
            vipLevel: detail.vipLevel,
            tags: detail.tags,
            notes: detail.notes,
            allergies: detail.preferences.allergies,
            preferencesNotes: detail.preferences.freeNotes,
            visitStats: {
              totalVisits: detail.visits.total,
              firstVisit: detail.visits.firstAt,
              lastVisit: detail.visits.lastAt,
              daysSinceLastVisit: detail.visits.daysSinceLastVisit,
              lifetimeSpendDollars: detail.visits.lifetimeSpendCents
                ? (detail.visits.lifetimeSpendCents / 100).toFixed(2) : null,
              avgSpendDollars: detail.visits.avgSpendCents
                ? (detail.visits.avgSpendCents / 100).toFixed(2) : null,
            },
            recentServices: detail.recentTickets.slice(0, 5).map((t) => ({
              date: t.businessDate,
              services: t.serviceNames,
            })),
          };
        },
      },

      {
        name: 'get_queue_status',
        description: '查询当前现场等位排队详情（排队号、客人姓名、等待时间、超时预警、期望项目）。',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        run: async () => {
          const rows = await withTenant(tenant, (tx) => tx<{
            ticket_number: number; customer_name: string | null; walk_in_name: string | null;
            party_size: number; joined_at: string | Date; quoted_wait_min: number | null;
            service_name: unknown;
          }[]>`
            select q.ticket_number, c.display_name as customer_name, q.walk_in_name,
                   q.party_size, q.joined_at, q.quoted_wait_min, s.name as service_name
            from walkin_queue q
            left join customers c on c.id = q.customer_id
            left join services s on s.id = q.requested_service_id
            where q.location_id = ${ctx.locationId}
              and q.business_date = current_date
              and q.status = 'waiting'
            order by q.ticket_number asc`);

          const nowMs = Date.now();
          return {
            waitingCount: rows.length,
            queue: rows.map((r) => {
              const waitedMin = Math.max(0, Math.round((nowMs - new Date(r.joined_at).getTime()) / 60000));
              const isOverdue = r.quoted_wait_min !== null && waitedMin > r.quoted_wait_min + 10;
              return {
                ticketNumber: r.ticket_number,
                customer: r.customer_name ?? r.walk_in_name ?? '散客',
              partySize: r.party_size,
              waitedMinutes: waitedMin,
              quotedWaitMinutes: r.quoted_wait_min,
              isOverdue,
              requestedService: pickText(r.service_name, ctx.locale),
            };
          }),
        };
      },
    },

    {
      name: 'list_staff_skills',
      description:
        '查询全店技师的花名册、技能标签（如美甲、Gel-X延长、美睫、足疗、推拿、手足护理等）、职级等级与在职状态。'
        + '**前台询问谁会做某项目、某技师会什么技能、空闲技师能不能接单时必须先调用此工具**。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeResigned: { type: 'boolean', description: '是否包含已离职员工，默认 false' },
        },
      },
      run: async (input) => {
        const includeResigned = Boolean(input['includeResigned']);
        const { staff } = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
        const filtered = includeResigned ? staff : staff.filter((s) => s.status === 'active');
        return {
          totalStaff: filtered.length,
          staffList: filtered.map((s) => ({
            membershipId: s.membershipId,
            employeeNo: s.employeeNo,
            name: s.name,
            jobTitle: s.jobTitle,
            level: s.level,
            skills: s.skills.length > 0 ? s.skills : ['全科基础服务'],
            status: s.status,
            hireDate: s.hireDate,
          })),
        };
      },
    },

    {
      name: 'get_service_catalog',
      description:
        '查询门店全量服务项目价目表、标准耗时与分类（如美甲、美睫、按摩、足疗项目单价与时长）。'
        + '**前台询问项目多少钱、服务耗时多久、店内有哪些服务项目时必须调用**。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          categoryId: { type: 'string', description: '可选分类 ID 筛选' },
        },
      },
      run: async (input) => {
        const categoryId = typeof input['categoryId'] === 'string' ? input['categoryId'] : null;
        const [categories, services] = await withTenant(tenant, async (tx) => {
          const cats = await tx<{ id: string; name: unknown; sort: number }[]>`
            select id, name, sort from service_categories
            where location_id = ${ctx.locationId}
            order by sort asc, created_at asc`;

          const srvs = await tx<{
            id: string; category_id: string | null; name: unknown;
            duration_min: number; price_cents: number; is_active: boolean;
            description: unknown;
          }[]>`
            select id, category_id, name, duration_min, price_cents, is_active, description
            from services
            where location_id = ${ctx.locationId} and is_active = true
            order by sort asc, created_at asc`;

          return [cats, srvs] as const;
        });

        const catMap = new Map(categories.map((c) => [c.id, pickText(c.name, ctx.locale)]));
        const list = services
          .filter((s) => !categoryId || s.category_id === categoryId)
          .map((s) => ({
            serviceId: s.id,
            category: s.category_id ? (catMap.get(s.category_id) ?? '默认分类') : '未分类',
            name: pickText(s.name, ctx.locale),
            durationMin: s.duration_min,
            priceDollars: (s.price_cents / 100).toFixed(2),
            description: s.description ? pickText(s.description, ctx.locale) : null,
          }));

        return {
          totalServices: list.length,
          categories: categories.map((c) => ({ id: c.id, name: pickText(c.name, ctx.locale) })),
          services: list,
        };
      },
    },

    {
      name: 'get_staff_schedules',
      description:
        '查询员工排班日历与休假情况（某天或未来几天的上班时段、休息日、请假原因）。'
        + '**前台询问某技师明天几点上班、谁今天休息、某天排班时调用**。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fromDate: { type: 'string', description: 'YYYY-MM-DD，默认今日' },
          days: { type: 'number', description: '查询天数，默认 3 天，最多 7 天' },
        },
      },
      run: async (input) => {
        const today = new Date().toISOString().slice(0, 10);
        const fromDate = typeof input['fromDate'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input['fromDate'])
          ? input['fromDate'] : today;
        const days = Math.max(1, Math.min(7, Number(input['days']) || 3));

        const roster = await withTenant(tenant, (tx) => loadRoster(tx, ctx, fromDate, days));
        return {
          fromDate: roster.fromDate,
          toDate: roster.toDate,
          timezone: roster.timezone,
          staffSchedules: roster.shifts.map((sh) => {
            const staffInfo = roster.staff.find((s) => s.membershipId === sh.membershipId);
            const startHour = `${String(Math.floor(sh.startMin / 60)).padStart(2, '0')}:${String(sh.startMin % 60).padStart(2, '0')}`;
            const endHour = `${String(Math.floor(sh.endMin / 60)).padStart(2, '0')}:${String(sh.endMin % 60).padStart(2, '0')}`;
            return {
              date: sh.businessDate,
              staffName: staffInfo?.name ?? '员工',
              membershipId: sh.membershipId,
              status: sh.status,
              shiftHours: sh.status === 'off' ? '休息' : `${startHour} - ${endHour}`,
              offReason: sh.offReason,
              note: sh.note,
            };
          }),
        };
      },
    },

    {
      name: 'get_store_info',
      description:
        '查询门店基础设置与规则（每周营业时间、开店打烊时间、门店地址、前台电话、税率、小费政策）。'
        + '**前台询问几点打烊、营业时间、地址电话、税率时调用**。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const [desk, checkout] = await withTenant(tenant, async (tx) => {
          const d = await loadDeskSettings(tx, ctx);
          const c = await loadCheckoutSettings(tx, ctx);
          return [d, c] as const;
        });

        return {
          storeName: pickText(desk.location.name, ctx.locale),
          businessType: desk.location.businessType,
          timezone: desk.location.timezone,
          phone: desk.location.phone,
          email: desk.location.email,
          address: {
            street: desk.location.addressStreet,
            city: desk.location.addressCity,
            state: desk.location.addressState,
            zip: desk.location.addressZip,
          },
          businessHours: desk.location.businessHours,
          taxRatePercent: checkout.salesTaxRatePercent,
          suggestedTipPercentages: checkout.suggestedTipPercentages,
          receiptFooterMessage: checkout.receiptFooterMessage,
        };
      },
    },

    {
      name: 'get_promotions_and_cards',
      description:
        '查询门店当前次卡套餐（如10次卡）、优惠券活动与礼品卡信息。'
        + '**前台询问次卡套餐、优惠活动、礼品卡规则时调用**。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const pkgData = await withTenant(tenant, (tx) => loadPackages(tx, ctx));
        return {
          activePackages: pkgData.templates.filter((t) => t.active).map((p) => ({
            packageId: p.id,
            name: p.name,
            priceDollars: (p.priceCents / 100).toFixed(2),
            sessions: p.sessions,
            validDays: p.validDays ? `${p.validDays} 天` : '永久有效',
            serviceName: p.serviceName,
          })),
          totalPackagesSold: pkgData.totalSold,
        };
      },
    },

    {
      name: 'get_store_reviews',
      description:
        '查询门店口碑与外部评价（Google/Yelp/店内评分、顾客好评点、差评反馈、技师好评榜）。'
        + '**前台询问顾客评价口碑时调用**。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const rev = await withTenant(tenant, (tx) => loadReviewsSummary(tx, ctx));
        return {
          overallScore: rev.overallScore,
          totalReviewCount: rev.totalReviewCount,
          satisfactionRatePercent: rev.satisfactionRate + '%',
          googleRating: rev.platformBreakdown.google,
          yelpRating: rev.platformBreakdown.yelp,
          topStaff: rev.aiSummary.topStaff,
          recentFeedback: rev.recentReviews.slice(0, 5).map((r) => ({
            customer: r.customerName,
            rating: r.rating,
            platform: r.platform,
            timeAgo: r.timeAgo,
            technician: r.technicianName,
            service: r.serviceName,
            content: r.content,
            highlights: r.highlights,
          })),
        };
      },
    },

    {
      name: 'search_orders',
      description:
        '查询收银订单流水（单据号、实付金额、支付方式、小费、技师业绩分成、状态）。'
        + '**前台询问某单收了多少钱、查小费、查订单流水明细时调用**。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD，默认今日' },
          limit: { type: 'number', description: '返回最多几笔单，默认 10' },
        },
      },
      run: async (input) => {
        const today = new Date().toISOString().slice(0, 10);
        const date = typeof input['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input['date'])
          ? input['date'] : today;
        const limit = Math.max(1, Math.min(30, Number(input['limit']) || 10));

        const rows = await withTenant(tenant, (tx) => tx<{
          id: string; ticket_number: number; status: string; customer_name: string | null;
          subtotal_cents: number; tip_cents: number; total_cents: number;
          payment_method: string | null; closed_at: string | null;
        }[]>`
          select t.id, t.ticket_number, t.status, c.display_name as customer_name,
                 t.subtotal_cents, t.tip_cents, t.total_cents,
                 t.payment_method, t.closed_at::text as closed_at
          from tickets t
          left join customers c on c.id = t.customer_id
          where t.location_id = ${ctx.locationId}
            and t.business_date = ${date}
          order by t.created_at desc
          limit ${limit}`);

        return {
          businessDate: date,
          totalCount: rows.length,
          orders: rows.map((r) => ({
            orderId: r.id,
            ticketNumber: `#${r.ticket_number}`,
            customer: r.customer_name ?? '散客',
            status: r.status,
            totalDollars: (r.total_cents / 100).toFixed(2),
            subtotalDollars: (r.subtotal_cents / 100).toFixed(2),
            tipDollars: (r.tip_cents / 100).toFixed(2),
            paymentMethod: r.payment_method ?? '其他',
            closedAt: r.closed_at,
          })),
        };
      },
    },
  ];

    /** 姓名 → membershipId。**匹配不上返回 null**，绝不挑一个最像的 */
    async function membershipByName(name: string): Promise<string | null> {
      const rows = await withTenant(tenant, (tx) => tx<{
        membership_id: string; display_name: unknown;
      }[]>`
        select sp.membership_id, sp.display_name
        from staff_profiles sp
        join memberships m on m.id = sp.membership_id and m.status = 'active'
        where sp.location_id = ${ctx.locationId} and sp.is_bookable = true`);

      const want = norm(name);
      const exact = rows.filter((r) => norm(pickText(r.display_name, 'en')) === want);
      if (exact.length === 1) return exact[0]!.membership_id;
      // 命中多个 = 有歧义（店里两个 Kim）。留空比挑一个强
      const partial = rows.filter((r) => norm(pickText(r.display_name, 'en')).includes(want));
      return partial.length === 1 ? partial[0]!.membership_id : null;
    }
  }

  /**
   * 记一条 `ai_assist` 用量并扣余额。
   *
   * ⚠️ **失败不能让整个请求失败** —— 前台已经拿到答案了，
   * 因为记账没记上而给她一个错误页，是把计费的问题变成了业务的问题。
   * 记不上的那几分钱由日志兜着，比让她重问一遍便宜得多。
   */
  async function recordUsage(
    ctx: CommandContext,
    usage: { tokens: number; costMillicents: number; rounds: number; hadProposal: boolean },
    log: { warn: (o: unknown, m: string) => void },
  ): Promise<number> {
    try {
      const out = await dispatch<{ chargedCents: number }>(
        'ai.recordAssist',
        {
          feature: 'desk_copilot',
          model: COPILOT_MODEL,
          tokens: usage.tokens,
          costMillicents: usage.costMillicents,
          rounds: usage.rounds,
          hadProposal: usage.hadProposal,
        },
        ctx,
      );
      return out.result.chargedCents;
    } catch (e) {
      log.warn({ err: e, locationId: ctx.locationId }, 'failed to record copilot usage');
      return 0;
    }
  }
}

interface CustomerHit {
  id: string; display_name: string; phone_e164: string | null;
  no_show_count: number; last_visit_on: string | null;
}

const norm = (v: string): string => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** 门店墙上时间的分钟数，用来把「客人说的时间」排到前面 */
function minutesOf(d: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60
    + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}
