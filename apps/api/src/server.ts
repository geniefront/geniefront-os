/**
 * HTTP 层 —— 薄薄一层，只做四件事：
 *   验令牌 → 校验 membership 归属 → 转给命令总线 → 把 AppError 翻成 HTTP
 *
 * 业务逻辑一点都不许写在这里。路由是从 contracts 的注册表**自动生成**的：
 * 加一个命令 = 自动有接口 + AI 自动会用（宪法第 1 条）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { AppError, ERROR_CODES, httpStatusFor, pickText, actingMembership } from '@gf/contracts';
import { dispatch, registeredCommands } from './bus';
import { buildContext } from './actor';
import { verifyAccessToken } from './auth';
import { listMembershipsForUser, withTenant } from '@gf/db';

interface CustomerRow {
  id: string; display_name: string; phone_e164: string | null;
  no_show_count: number; tags: string[] | null; last_visit_on: string | null;
}
import './handlers/appointment';
import './handlers/rotation';
import './handlers/ticket';
import './handlers/setup';
import './handlers/payroll';
import './handlers/dayclose';
import './handlers/shift';
import './handlers/staff';
import './handlers/blueprint';
import './handlers/phone';
import './handlers/yelp';
import './handlers/kiosk';
import './handlers/billing';
import './handlers/ai';
import { loadDay } from './queries/day';
import { loadBlueprint, listBlueprints } from './queries/blueprint';
import { loadCallDrafts } from './queries/callDrafts';
import { registerTelnyxRoutes } from './telnyx/routes';
import { registerKioskRoutes } from './kiosk/routes';
import { registerStripeRoutes } from './stripe/routes';
import { registerCopilotRoutes } from './copilot/routes';
import { registerRawBodyParser } from './rawBody';
import { loadBilling } from './queries/billing';
import { maybeAutoTopup } from './billing/autoTopup';
import { loadQueue } from './queries/queue';
import { searchBusinesses, getBusiness } from '@gf/yelp';
import { extractPriceList, costMillicents, billableTokens, MAX_IMAGE_EDGE_PX,
         itemsNeedingTranslation, translateNames, TRANSLATE_MODEL, TRANSLATE_RATES,
         type PriceListImage, type ImageMediaType } from '@gf/ai';
import { resolveDate } from './handlers/dayclose';
import {
  loadEarningsBoard, loadDayClose, loadReport, reportToCsv,
} from './queries/money';
import { loadRoster } from './queries/roster';
import { loadStaffToday } from './queries/staff';
import { currentBusinessDate, loadRotation, stripRank } from './handlers/rotation';
import { computeStanding, explain, FULL_TURN } from '@gf/rotation';
import { businessDateOf } from '@gf/scheduling';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Cloudflare 在前面，真实 IP 在 CF-Connecting-IP / X-Forwarded-For
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  // 前端在 Cloudflare Pages / 本地 dev，和 API 不同源。
  // 白名单而不是 '*'：带 Authorization 的请求不该对任意站点开放。
  const ORIGINS = [
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    /^https:\/\/([a-z0-9-]+\.)*geniefront\.com$/,
    /^https:\/\/[a-z0-9-]+\.pages\.dev$/,   // Pages 预览部署
  ];
  void app.register(cors, {
    origin(origin, cb) {
      // 无 origin = 同源或非浏览器（curl、健康探针），放行
      if (!origin) return cb(null, true);
      cb(null, ORIGINS.some((re) => re.test(origin)));
    },
    credentials: false,
    // ⚠️ 漏掉任何一个自定义头，浏览器会在预检之后**静默**掐掉真正的请求 ——
    // 服务端日志里只看得到一个 204 的 OPTIONS，没有任何报错，
    // 而前端拿到的是一句语焉不详的 TypeError。X-Device-Token 就这么漏过一次。
    allowedHeaders: [
      'Authorization', 'Content-Type', 'X-Membership-Id', 'Idempotency-Key',
      'X-Device-Token',
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    maxAge: 86400,
  });

  // ── 原始字节（webhook 验签用）─────────────────────────────────────────────
  //
  // ⚠️ 必须在任何路由注册之前，而且**只能注册一次** ——
  // Fastify 一个 content-type 只允许一个解析器。加新的 webhook 供应商
  // 是往 RAW_BODY_PREFIXES 里加一条，不是再调一次这个函数。
  registerRawBodyParser(app);

  // ── 健康探针 ───────────────────────────────────────────────────────────────
  // Cloudflare 负载均衡每 5 秒打一次。故意不查数据库：
  // DB 抖一下就把两台机器同时摘掉，比 DB 慢一点更糟。
  app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

  // ── 错误映射 ───────────────────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      // 4xx 是预期内的业务分支（超卖、权限、冲突），不该刷 error 日志
      const status = httpStatusFor[err.code];
      if (status >= 500) req.log.error({ err }, err.code);
      else req.log.info({ code: err.code, details: err.details }, 'business error');
      return reply.status(status).send(err.toJSON());
    }
    req.log.error({ err }, 'unhandled');
    // 绝不把原始报错抛给前台 —— 她们看不懂，而且可能泄露表结构
    return reply.status(500).send(new AppError(ERROR_CODES.INTERNAL).toJSON());
  });

  // ── 认证：除白名单外全部要令牌 ─────────────────────────────────────────────
  const PUBLIC = new Set(['/health']);

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (PUBLIC.has(path)) return;
    // Telnyx 的 webhook 不可能带我们的 Bearer token —— 它的身份证明是
    // Ed25519 签名，在路由自己那一层验（telnyx/routes.ts）。
    // 放进这里不等于放行：验签失败一样 401，而且验签比 JWT 更严
    //（JWT 只证明「是某个登录用户」，签名证明「是 Telnyx 本人且 body 没被改过」）。
    if (path.startsWith('/v1/telnyx/')) return;
    // Kiosk 门口那台 iPad 没有登录用户 —— 它的身份是一个设备令牌，
    // 在路由自己那一层验（kiosk/routes.ts）。权限窄到只有取号和交表两条。
    if (path.startsWith('/v1/kiosk/')) return;
    // Stripe 的 webhook 同理：身份是一个 HMAC 签名，在 stripe/routes.ts 里验。
    // ⚠️ 只有 /v1/stripe/webhook 这一条是公开的 —— 老板端那几条
    // （/v1/billing/*）走正常的 Bearer 校验，别把它们放进这个前缀
    if (path === '/v1/stripe/webhook') return;
    req.user = await verifyAccessToken(req.headers.authorization);
  });

  /** 从请求头解析出命令上下文。客户端自报的 membershipId 必须验归属。 */
  async function ctxFromHeaders(req: { user?: { userId: string }; headers: Record<string, unknown>; ip: string }) {
    const userId = req.user!.userId;
    const membershipId = req.headers['x-membership-id'];
    if (typeof membershipId !== 'string' || !membershipId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '缺少 X-Membership-Id：先调 /v1/me/locations 选店' },
      });
    }
    // 不再单独调 assertMembershipBelongsTo：buildContext 里的
    // loadMembershipBase 走用户维度 RLS，别人的 membership 直接查不到，
    // 同样抛 PERMISSION_DENIED。省掉热路径上的一次往返。
    return buildContext({ userId, membershipId, ip: req.ip });
  }

  // ── 店铺选择器 ─────────────────────────────────────────────────────────────
  // 登录后第一个调用。只有一条就直接进，多条出选择器（02 §2）。
  app.get('/v1/me/locations', async (req) => {
    const list = await listMembershipsForUser(req.user!.userId);
    return { locations: list };
  });

  // ── 命令入口 ───────────────────────────────────────────────────────────────
  const commandNames = new Set(registeredCommands().map((c) => c.name));

  app.post<{ Params: { name: string } }>('/v1/commands/:name', async (req, reply) => {
    const name = req.params.name;
    if (!commandNames.has(name)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { command: name } });
    }
    const ctx = await ctxFromHeaders(req);

    const body = req.body as { input?: unknown; idempotencyKey?: string } | undefined;
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ?? body?.idempotencyKey;

    const out = await dispatch(name, body?.input ?? {}, ctx, {
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    // 重放的请求返回 200，新执行的返回 201 —— 客户端能分辨自己是不是重试成功了
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  // ── 查询：找客人 ───────────────────────────────────────────────────────────
  //
  // 决策 21：手机号不是唯一键。这个接口【可以】返回同号多人，
  // 前端负责让前台选 —— 后端绝不擅自"帮"前台挑一个。
  app.get<{ Querystring: { q?: string } }>('/v1/customers/search', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }

    const raw = (req.query.q ?? '').trim();
    if (raw.length < 2) return { customers: [] };

    // 数字多的当手机号搜（前台习惯只输后四位），否则当姓名
    const digits = raw.replace(/\D/g, '');
    const byPhone = digits.length >= 3;
    const canSeeContact = ctx.permissions.has('customer.view_contact');

    const rows = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => byPhone
        ? tx<CustomerRow[]>`
            select c.id, c.display_name, c.phone_e164, c.no_show_count, c.tags,
                   (select max(a.business_date)::text from appointments a
                     where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
            from customers c
            where c.merged_into_id is null
              and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
            order by c.display_name limit 20`
        : tx<CustomerRow[]>`
            select c.id, c.display_name, c.phone_e164, c.no_show_count, c.tags,
                   (select max(a.business_date)::text from appointments a
                     where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
            from customers c
            where c.merged_into_id is null and c.display_name ilike ${'%' + raw + '%'}
            order by c.display_name limit 20`,
    );

    return {
      customers: rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        // 决策 16：没有 customer.view_contact 的人（技师）只看得到尾号
        phoneE164: canSeeContact
          ? r.phone_e164
          : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
        lastVisitOn: r.last_visit_on,
        lastStaffName: null,
        noShowCount: r.no_show_count,
        tags: r.tags ?? [],
      })),
    };
  });

  // ── 查询：当日现场 ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { date?: string } }>('/v1/desk/day', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    // 不传日期就用门店此刻的营业日 —— 凌晨 1 点打开还应该看到「昨天」那一天
    const [loc] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ tz: string; cutoff: string }[]>`
        select timezone as tz, business_day_cutoff::text as cutoff
        from locations where id = ${ctx.locationId}`);
    const date = req.query.date ?? businessDateOf(new Date(), loc!.tz, loc!.cutoff);

    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadDay(tx, ctx, date));
  });

  // ── 查询：轮牌板 ───────────────────────────────────────────────────────────
  //
  // 顺序是**算出来的**不是存出来的：每个人都带 explain 和事件流水，
  // 技师质疑时前台能一条条给他看（决策 12）。
  app.get('/v1/desk/rotation', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('rotation.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'rotation.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const { date, policy } = await currentBusinessDate(tx, ctx.locationId);
        const { participants, events } = await loadRotation(tx, ctx, date);
        const st = computeStanding(participants, events, policy);
        return {
          businessDate: date,
          policy,
          nextUpMembershipId: st.nextUp?.membershipId ?? null,
          entries: st.entries.map((e) => ({
            membershipId: e.membershipId,
            name: e.name,
            turns: e.turnsBp / FULL_TURN,
            owed: e.owed,
            state: e.state,
            position: e.position,
            manualRank: e.manualRank,
            why: explain(e, policy),
            trail: e.trail.slice(0, 8).map((t) => ({
              at: t.at, reason: t.reason,
              turns: t.deltaBp / FULL_TURN,
              note: stripRank(t.note),
            })),
          })),
        };
      });
  });

  // ── 查询：今天开着的单 ─────────────────────────────────────────────────────
  app.get('/v1/desk/tickets', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const rows = await tx<{
          ticket_id: string; customer_name: string | null; walk_in_name: string | null;
          group_id: string | null; group_label: string | null;
          subtotal_cents: number; item_id: string; item_name: string; item_total: number;
          duration_min: number; staff_name: unknown; membership_id: string;
        }[]>`
          select t.id as ticket_id, c.display_name as customer_name, t.walk_in_name,
                 t.group_id, g.label as group_label,
                 t.subtotal_cents, ti.id as item_id, ti.name_snapshot as item_name,
                 ti.total_cents as item_total, ti.duration_min,
                 sp.display_name as staff_name, tis.membership_id
          from tickets t
          left join customers c on c.id = t.customer_id
          left join ticket_groups g on g.id = t.group_id
          join ticket_items ti on ti.ticket_id = t.id
          join ticket_item_staff tis on tis.ticket_item_id = ti.id
          left join staff_profiles sp on sp.membership_id = tis.membership_id
          where t.location_id = ${ctx.locationId}
            and t.status in ('open','in_service','ready_to_pay')
          order by t.opened_at, ti.seq`;

        const map = new Map<string, {
          ticketId: string; customerName: string; subtotalCents: number;
          groupId: string | null; groupLabel: string | null;
          items: Array<Record<string, unknown>>;
        }>();
        for (const r of rows) {
          const t = map.get(r.ticket_id) ?? {
            ticketId: r.ticket_id,
            customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
            subtotalCents: r.subtotal_cents,
            groupId: r.group_id, groupLabel: r.group_label,
            items: [],
          };
          t.items.push({
            ticketItemId: r.item_id, name: r.item_name, totalCents: r.item_total,
            durationMin: r.duration_min, staffName: pickText(r.staff_name, ctx.locale),
            membershipId: r.membership_id,
          });
          map.set(r.ticket_id, t);
        }
        return { tickets: [...map.values()] };
      });
  });

  // ── 查询：开店配置 ─────────────────────────────────────────────────────────
  app.get('/v1/desk/settings', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('staff.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const [loc] = await tx<{
          name: unknown; timezone: string; business_hours: unknown;
          business_type: string; cutoff: string;
        }[]>`
          select name, timezone, business_hours, business_type,
                 business_day_cutoff::text as cutoff
          from locations where id = ${ctx.locationId}`;

        const services = await tx<{
          id: string; name: unknown; duration_min: number; base_price_cents: number;
          taxable: boolean; online_bookable: boolean; active: boolean;
        }[]>`
          select id, name, duration_min, base_price_cents, taxable, online_bookable, active
          from services where location_id = ${ctx.locationId}
          order by active desc, sort, name->>'en'`;

        const date = businessDateOf(new Date(), loc!.timezone, loc!.cutoff);
        const staff = await tx<{
          membership_id: string; name: unknown; is_bookable: boolean;
          max_concurrent: number; level_key: string | null; in_rotation: boolean | null;
        }[]>`
          select sp.membership_id, sp.display_name as name, sp.is_bookable,
                 sp.max_concurrent_appointments as max_concurrent,
                 sl.key as level_key, rp.in_rotation
          from staff_profiles sp
          join memberships m on m.id = sp.membership_id and m.status = 'active'
          left join staff_levels sl on sl.id = sp.level_id
          left join rotation_participants rp
            on rp.membership_id = sp.membership_id and rp.business_date = ${date}
          where sp.location_id = ${ctx.locationId}
          order by sp.is_bookable desc, sp.display_name->>'en'`;

        const levels = await tx<{ id: string; key: string; name: unknown }[]>`
          select id, key, name from staff_levels
          where location_id = ${ctx.locationId} order by sort`;

        // AI 电话那三个号。开通是**人工**做的（`09` §2），所以这里没有任何
        // 状态列 —— 「开通了没有」就是「有没有 ai_voice 那一条」。
        const lines = await tx<{
          purpose: string; e164: string; forwarding_mode: string | null;
        }[]>`
          select purpose, e164, forwarding_mode from phone_lines
          where location_id = ${ctx.locationId} and active
            and purpose in ('ai_voice','main','transfer_target')`;
        const lineOf = (p: string) => lines.find((l) => l.purpose === p)?.e164 ?? null;

        return {
          location: {
            name: pickText(loc!.name, ctx.locale),
            timezone: loc!.timezone,
            businessType: loc!.business_type,
            businessHours: loc!.business_hours ?? {},
          },
          services: services.map((s) => ({
            id: s.id, name: s.name as Record<string, string>,
            displayName: pickText(s.name, ctx.locale),
            durationMin: s.duration_min, basePriceCents: s.base_price_cents,
            taxable: s.taxable, onlineBookable: s.online_bookable, active: s.active,
          })),
          staff: staff.map((s) => ({
            membershipId: s.membership_id,
            name: pickText(s.name, ctx.locale),
            isBookable: s.is_bookable,
            maxConcurrent: s.max_concurrent,
            levelKey: s.level_key,
            inRotation: s.in_rotation ?? s.is_bookable,
          })),
          levels: levels.map((l) => ({
            id: l.id, key: l.key, name: pickText(l.name, ctx.locale),
          })),
          phone: {
            /** 店家对外公布的号。我们不碰它，只用来生成转移教程 */
            storefrontE164: lineOf('main'),
            /** 人工客服号 —— AI 答不了时转给它 */
            transferTargetE164: lineOf('transfer_target'),
            /** 我们买的落地号。null = 还没开通 */
            aiVoiceE164: lineOf('ai_voice'),
            /** 店家说他在运营商那儿设的转接方式（我们改不了，只记录） */
            forwardingMode:
              lines.find((l) => l.purpose === 'main')?.forwarding_mode ?? null,
          },
        };
      });
  });

  // ── 查询：技师当日收入看板 ─────────────────────────────────────────────────
  //
  // 没有 payroll.view_all 的人只看得到自己那一行 —— 技师互相看收入
  // 是门店里最直接的矛盾来源（00 §3.0）。
  app.get<{ Querystring: { date?: string } }>('/v1/desk/earnings', async (req) => {
    const ctx = await ctxFromHeaders(req);
    const all = ctx.permissions.has('payroll.view_all');
    if (!all && !ctx.permissions.has('payroll.view_own')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.view_own' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadEarningsBoard(tx, ctx, date, all ? undefined : actingMembership(ctx));
      });
  });

  // ── 查询：打烊日结 ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { date?: string } }>('/v1/desk/dayclose', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('dayclose.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'dayclose.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadDayClose(tx, ctx, date);
      });
  });

  // ── 查询：营业报表（含 CSV 导出）───────────────────────────────────────────
  //
  // CSV 在服务端生成而不是前端拼：BOM、公式注入转义、列顺序这三件事
  // 只该有一份实现，而且导出的文件老板是要发给会计的。
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>(
    '/v1/desk/reports', async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
    }
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const today = await resolveDate(tx, ctx.locationId);
        const from = DATE.test(req.query.from ?? '') ? req.query.from! : today;
        const to = DATE.test(req.query.to ?? '') ? req.query.to! : today;
        if (from > to) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: '起始日期不能晚于结束日期' },
          });
        }
        const report = await loadReport(tx, ctx, from, to);
        if (req.query.format !== 'csv') return report;
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition',
                  `attachment; filename="geniefront-${from}_${to}.csv"`)
          .send(reportToCsv(report));
      });
  });

  // ── 查询：排班表 ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; days?: string } }>('/v1/desk/roster', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('schedule.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'schedule.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? '')
          ? req.query.from! : await resolveDate(tx, ctx.locationId);
        const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 31);
        return loadRoster(tx, ctx, from, days);
      });
  });

  // ── 查询：技师端今日快照（Phase 1c）─────────────────────────────────────────
  //
  // 一次给全：今日单 + 下一位 + 收入 + 打卡状态 + 轮牌位次。
  // 技师那台手机的网通常比前台还差，一次往返比五次可靠得多。
  //
  // ⚠️ `membershipId` 只接受**自己**，除非有 payroll.view_all ——
  // 技师互相看对方的客人和收入是门店里最直接的矛盾来源。
  app.get<{ Querystring: { date?: string; membershipId?: string } }>(
    '/v1/staff/me/today', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    const wanted = req.query.membershipId ?? actingMembership(ctx);
    if (wanted !== ctx.membershipId && !ctx.permissions.has('payroll.view_all')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
        details: { need: 'payroll.view_all', reason: '只能看自己的今日单' },
      });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadStaffToday(tx, ctx, date, wanted);
      });
  });

  // ── AI 拍照开店：提取（Phase 2，05 §5）────────────────────────────────────
  //
  // ⭐ 这条路由是**唯一**一个不走 /v1/commands 的写入入口，理由要写清楚：
  //
  //   提取本身是一次不写库的计算（图片 → 模型 → 候选行），
  //   而总线里的每个命令都跑在一个数据库事务内。把一次三十秒的模型调用
  //   塞进事务，等于让一个连接和一个快照被占住三十秒 ——
  //   几家店同时开店就能把连接池吃干净。
  //
  //   所以：这里只做编排（校验 → 调模型 → 把结果交给命令），
  //   真正的写库仍然是 blueprint.saveExtraction 这条命令，
  //   有审计、有 RLS、有租户上下文。宪法第 1 条守住的是「写操作必须是命令」，
  //   守住了。
  //
  // 图片走请求体而不是让 API 去 Storage 取：API 拿不到 service_role
  //（宪法第 5 条，CI 会失败），而让它去 fetch 一个客户端给的 URL 就是 SSRF。
  const MAX_IMAGES_PER_EXTRACT = 6;
  const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

  app.post<{ Params: { id: string } }>(
    '/v1/blueprint/:id/extract',
    // 2576px 长边的 JPEG 大约 1–2MB，base64 之后 ~2.7MB，六张 ~16MB。
    // 全局 1MB 的限制是给命令用的，那些都是小 JSON。
    { bodyLimit: 32_000_000 },
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('catalog.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
      }
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        req.log.error('ANTHROPIC_API_KEY 未配置，拍照开店不可用');
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
      }

      const body = req.body as {
        images?: Array<{
          seq?: number; base64?: string; mediaType?: string;
          widthPx?: number; heightPx?: number;
        }>;
        locale?: string;
      } | undefined;

      const raw = body?.images ?? [];
      if (raw.length === 0 || raw.length > MAX_IMAGES_PER_EXTRACT) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: `一次最多 ${MAX_IMAGES_PER_EXTRACT} 张照片`, got: raw.length },
        });
      }

      const images: PriceListImage[] = raw.map((im, i) => {
        if (typeof im.base64 !== 'string' || im.base64.length === 0
            || typeof im.mediaType !== 'string' || !MEDIA_TYPES.has(im.mediaType)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: '照片格式不对，只支持 JPEG / PNG / WebP', index: i },
          });
        }
        // 超过 2576px 的图 API 会自己缩，缩完 bbox 就不再是原图坐标，
        // 「点一下跳回原图那一行」这个功能会静默地指错位置。
        // 所以在这里挡下来，让前端先缩 —— 缩了再传也省流量。
        if ((im.widthPx ?? 0) > MAX_IMAGE_EDGE_PX || (im.heightPx ?? 0) > MAX_IMAGE_EDGE_PX) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: `照片长边不能超过 ${MAX_IMAGE_EDGE_PX}px`, index: i },
          });
        }
        return {
          seq: typeof im.seq === 'number' ? im.seq : i,
          base64: im.base64,
          mediaType: im.mediaType as ImageMediaType,
          ...(im.widthPx ? { widthPx: im.widthPx } : {}),
          ...(im.heightPx ? { heightPx: im.heightPx } : {}),
        };
      });

      // 提取草案必须已经存在（且还是 draft）。先确认一次再花那几毛钱 ——
      // 对着一份已经落地的草案跑模型，钱花了结果还写不进去。
      const view = await withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => loadBlueprint(tx, ctx, req.params.id));
      if (!view) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
      if (view.status !== 'draft') {
        throw new AppError(ERROR_CODES.BLUEPRINT_FROZEN, { details: { status: view.status } });
      }

      const result = await extractPriceList(images, {
        apiKey,
        ...(body?.locale ? { locale: body.locale } : {}),
        log: req.log,
      });

      const ok = result.perImage.filter((p) => !p.error).length;
      // 每一张都没认出来 = 别给老板一份空草案让他以为「我的价目表上什么都没有」。
      // 502 而不是 500：挂的是上游模型，这两个数字要分得开才看得出趋势。
      if (ok === 0) {
        throw new AppError(ERROR_CODES.EXTRACTION_FAILED, {
          details: { reasons: result.perImage.map((p) => ({ seq: p.seq, error: p.error })) },
        });
      }

      const out = await dispatch<{ blueprintId: string; itemCount: number }>(
        'blueprint.saveExtraction',
        {
          blueprintId: req.params.id,
          items: result.items,
          unresolved: result.unresolved,
          usage: {
            tokens: billableTokens(result.usage),
            costMillicents: costMillicents(result.usage),
            imagesOk: ok,
            imagesFailed: result.perImage.length - ok,
          },
        },
        ctx,
      );

      // ⭐ 扣完费顺手看一眼要不要自动续充。**在事务外**（`dispatch` 已经
      // 提交了）—— Stripe 调用不能进数据库事务，而且事务回滚不了扣款。
      // 失败只记日志：老板不该因为一张过期的卡而看不到刚提取出来的价目表
      void maybeAutoTopup(ctx, 'credit', req.log);

      return {
        ...out.result,
        merged: result.merge.merged,
        conflicts: result.merge.conflicts,
        dropped: result.dropped,
        failedImages: result.perImage
          .filter((p) => p.error)
          .map((p) => ({ seq: p.seq, error: p.error })),
      };
    });

  // ── 多语言补齐 ────────────────────────────────────────────────────────────
  //
  // 和 /extract 分开是必须的，不是为了整齐：
  // 提取的系统提示第一条纪律是「照抄、不翻译」（老板要能在照片上找到那一行），
  // 让同一次调用既照抄又翻译等于让模型同时守两条相反的规矩。
  //
  // 时机也不同：提取是**每张照片一次**，补齐是**整份草案一次**。
  // 挂在 /extract 里的话，传三张照片就会把先补好的又重译一遍。
  app.post<{ Params: { id: string } }>(
    '/v1/blueprint/:id/translate',
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('catalog.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
      }
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
      }

      const view = await withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => loadBlueprint(tx, ctx, req.params.id));
      if (!view) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
      if (view.status !== 'draft') {
        throw new AppError(ERROR_CODES.BLUEPRINT_FROZEN, { details: { status: view.status } });
      }

      const candidates = itemsNeedingTranslation(view.items.map((it) => ({
        seq: it.seq,
        name: (it.name ?? {}) as Record<string, string>,
        nameAuto: it.nameAuto ?? [],
        kind: it.kind,
      })));

      // 已经齐了就别调模型。**这一条省的是真金白银** ——
      // 老板在确认页多点两次「补齐」是很自然的行为。
      if (candidates.length === 0) {
        return { blueprintId: req.params.id, filledItems: 0, filledCells: 0, rejected: null, credits: 0 };
      }

      const t = await translateNames(candidates, { apiKey });
      if (t.error) {
        throw new AppError(ERROR_CODES.EXTRACTION_FAILED, { details: { stage: 'translate', reason: t.error } });
      }

      const out = await dispatch<{ filledCells: number }>(
        'blueprint.saveTranslations',
        {
          blueprintId: req.params.id,
          translations: t.translations,
          // ⚠️ **必须传 Sonnet 的价**。costMillicents 的默认值是 Opus 费率，
          // 而补齐走的是 Sonnet —— 用默认值会按三倍多扣客户的积分，
          // 而账单上只是一个「看起来偏大但不离谱」的数字，没人会发现。
          usage: {
            tokens: billableTokens(t.usage),
            costMillicents: costMillicents(t.usage, TRANSLATE_RATES),
          },
        },
        ctx,
      );

      void maybeAutoTopup(ctx, 'credit', req.log);
      return out.result;
    });

  // ── 查询：开店草案 ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/blueprint/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
    }
    const view = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadBlueprint(tx, ctx, req.params.id));
    if (!view) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
    return view;
  });

  app.get('/v1/desk/blueprints', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => ({ blueprints: await listBlueprints(tx, ctx) }));
  });

  // ── 查询：来电待复核队列（决策 6 的「1 秒复核队列」）────────────────────
  app.get<{ Querystring: { status?: string } }>('/v1/desk/call-drafts', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCallDrafts(tx, ctx, req.query.status ?? 'pending'));
  });

  // ── 查询：Yelp 搜店（05 §4.1，纯代码不过模型）──────────────────────────
  //
  // 老板输店名 + 邮编，我们直接映射 Yelp 的结构化返回。
  // 命中多家【全部返回让他点一家】—— 同一条街上两家「Lucky Nails」
  // 在美国太常见，替他挑第一个就等于把别人家的信息填进他的店。
  app.get<{ Querystring: { term?: string; location?: string; id?: string } }>(
    '/v1/desk/yelp/search', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    const apiKey = process.env['YELP_API_KEY'];
    if (!apiKey) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'yelp' } });
    }

    // 点选之后要再拉一次详情：**营业时间只有详情接口有**，
    // 搜索结果里没有 —— 而那正是「一键填充」里最省事的一项
    if (req.query.id) {
      return { business: await getBusiness(req.query.id, { apiKey }) };
    }

    const term = (req.query.term ?? '').trim();
    const location = (req.query.location ?? '').trim();
    if (term.length < 2 || location.length < 3) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '要店名和邮编（或城市）才能搜' },
      });
    }
    return { businesses: await searchBusinesses({ term, location }, { apiKey }) };
  });

  // ── 查询：走单队列（前台叫号那一屏）──────────────────────────────────────
  app.get<{ Querystring: { date?: string } }>('/v1/desk/queue', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('queue.manage') && !ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'queue.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadQueue(tx, ctx, date);
      });
  });

  // ── 查询：订阅与余额（决策 8）────────────────────────────────────────────
  //
  // ⭐ 顺手触发一次自动续充检查。这是「余额低了自动充」的四个触发点之一
  //（其余三个都挂在用量后面，见 billing/autoTopup.ts 顶部）——
  // 不做跨租户的定时扫描，因为那需要一个能看到所有店的连接，
  // 而 apps/ 拿不到那种凭据（宪法第 5 条）。
  //
  // 它**永远不该让这个查询失败**：老板打开账单页看到一个错误页，
  // 只会以为系统坏了，而真正的问题只是他那张卡过期了。
  app.get('/v1/desk/billing', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('billing.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
    }

    // 两种额度各看一眼。**分开充** —— 积分和分钟不能互换（决策 8），
    // 所以「余额低了」这件事也得分开判断
    const topup = await Promise.all([
      maybeAutoTopup(ctx, 'credit', req.log),
      maybeAutoTopup(ctx, 'voice_minute', req.log),
    ]);

    const view = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadBilling(tx, ctx));

    return { billing: view, autoTopup: topup };
  });

  // ── Stripe：订阅 Checkout / 绑卡 / 充值 / webhook ────────────────────────
  //
  // ⚠️ 只有 `/v1/stripe/webhook` 没有登录用户（身份是 HMAC 签名）。
  // `/v1/billing/*` 那几条走正常的 Bearer + billing.manage。
  registerStripeRoutes(app, ctxFromHeaders);

  // ── 前台 AI 副驾（05 §6）────────────────────────────────────────────────
  //
  // ⭐ 和拍照开店那条一样不走 /v1/commands：模型调用要几秒，
  // 塞进事务会占住连接。这条路由只做编排，**提案不执行** ——
  // 前台在卡片上点确认时才走 /v1/commands/:name，用她自己的身份。
  registerCopilotRoutes(app, ctxFromHeaders);

  // ── Kiosk 门口端（设备令牌鉴权）──────────────────────────────────────────
  registerKioskRoutes(app);

  // ── Telnyx：AI 工具 + 通话 webhook（09 §4.2）──────────────────────────────
  //
  // ⚠️ 这几条路由**没有登录用户**，身份全靠 Ed25519 签名。
  // 所以它们要在 PUBLIC 白名单里（跳过 Bearer 校验），
  // 而每一条的第一件事都是验签 —— 见 telnyx/routes.ts。
  registerTelnyxRoutes(app);

  // ── 命令目录 ───────────────────────────────────────────────────────────────
  // 前端 SDK 和 AI 工具定义都从这里取，不用各自维护一份
  app.get('/v1/commands', async () => ({
    commands: registeredCommands().map((c) => ({
      name: c.name,
      permission: c.permission,
      reversible: c.reversible,
      idempotency: c.idempotency,
      ai: c.ai,
    })),
  }));

  return app;
}

