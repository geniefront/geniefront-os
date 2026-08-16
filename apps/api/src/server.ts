/**
 * HTTP 层 —— 薄薄一层，只做四件事：
 *   验令牌 → 校验 membership 归属 → 转给命令总线 → 把 AppError 翻成 HTTP
 *
 * 业务逻辑一点都不许写在这里。路由是从 contracts 的注册表**自动生成**的：
 * 加一个命令 = 自动有接口 + AI 自动会用（宪法第 1 条）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { AppError, ERROR_CODES, httpStatusFor , pickText} from '@gf/contracts';
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
import { loadDay } from './queries/day';
import { resolveDate } from './handlers/dayclose';
import {
  loadEarningsBoard, loadDayClose, loadReport, reportToCsv,
} from './queries/money';
import { loadRoster } from './queries/roster';
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
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Membership-Id', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    maxAge: 86400,
  });

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
    if (PUBLIC.has(req.url.split('?')[0] ?? '')) return;
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
        return loadEarningsBoard(tx, ctx, date, all ? undefined : ctx.membershipId);
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

