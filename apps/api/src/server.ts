/**
 * HTTP 层 —— 薄薄一层，只做四件事：
 *   验令牌 → 校验 membership 归属 → 转给命令总线 → 把 AppError 翻成 HTTP
 *
 * 业务逻辑一点都不许写在这里。路由是从 contracts 的注册表**自动生成**的：
 * 加一个命令 = 自动有接口 + AI 自动会用（宪法第 1 条）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { AppError, ERROR_CODES, httpStatusFor } from '@gf/contracts';
import { dispatch, registeredCommands } from './bus';
import { buildContext } from './actor';
import { verifyAccessToken } from './auth';
import { listMembershipsForUser, withTenant } from '@gf/db';

interface CustomerRow {
  id: string; display_name: string; phone_e164: string | null;
  no_show_count: number; tags: string[] | null; last_visit_on: string | null;
}
import './handlers/appointment';
import { loadDay } from './queries/day';
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

// 直接 `tsx src/server.ts` 启动
if (process.argv[1]?.endsWith('server.ts')) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: '0.0.0.0' })
    .then(() => app.log.info(`listening on :${port}`))
    .catch((e) => { app.log.error(e); process.exit(1); });
}
