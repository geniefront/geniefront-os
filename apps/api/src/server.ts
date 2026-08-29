/**
 * HTTP 层 —— 薄薄一层，只做四件事：
 *   验令牌 → 校验 membership 归属 → 转给命令总线 → 把 AppError 翻成 HTTP
 *
 * 业务逻辑一点都不许写在这里。路由是从 contracts 的注册表**自动生成**的：
 * 加一个命令 = 自动有接口 + AI 自动会用（宪法第 1 条）。
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  AppError, ERROR_CODES, httpStatusFor,
} from '@gf/contracts';
import { dispatch, registeredCommands } from './bus';
import { buildContext } from './actor';
import { verifyAccessToken } from './auth';

// ── 命令处理器注册 ──────────────────────────────────────────────────────────
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
import './handlers/giftcard';
import './handlers/notify';
import './handlers/storefront';
import './handlers/yelp';
import './handlers/kiosk';
import './handlers/billing';
import './handlers/ai';
import './handlers/customer';
import './handlers/sms';
import './handlers/resource';
import './handlers/marketing';
import './handlers/profile';
import './handlers/notification';

// ── 外部与子系统路由注册 ───────────────────────────────────────────────────
import { registerTelnyxRoutes } from './telnyx/routes';
import { registerKioskRoutes } from './kiosk/routes';
import { registerPublicRoutes } from './public/routes';
import { registerFormLinkRoutes } from './public/formRoutes';
import { registerStripeRoutes } from './stripe/routes';
import { registerCopilotRoutes } from './copilot/routes';
import { registerAuthRoutes } from './auth/routes';
import { registerPasswordResetRoutes } from './auth/passwordReset';
import { staffContextFromToken, STAFF_TOKEN_HEADER } from './auth/staffSession';
import { registerRawBodyParser } from './rawBody';
import { flushEmails } from './email/flush';
import { flushSms } from './sms/flush';

// ── 模块化业务路由注册 ─────────────────────────────────────────────────────
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerMoneyRoutes } from './routes/money';
import { registerSettingsRoutes } from './routes/settings';
import { registerNotificationRoutes } from './routes/notifications';
import { registerMarketingRoutes } from './routes/marketing';
import { registerBillingRoutes } from './routes/billing';
import { registerHardwareRoutes } from './routes/hardware';
import { registerReviewsRoutes } from './routes/reviews';
import { registerFormsRoutes } from './routes/forms';
import { registerOrdersRoutes } from './routes/orders';
import { registerMeRoutes } from './routes/me';
import { registerCustomersRoutes } from './routes/customers';
import { registerScheduleRoutes } from './routes/schedule';
import { registerRotationRoutes } from './routes/rotation';
import { registerTicketsRoutes } from './routes/tickets';
import { registerStaffRoutes } from './routes/staff';
import { registerAiRoutes } from './routes/ai';
import { registerMiscRoutes } from './routes/misc';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Cloudflare 在前面，真实 IP 在 CF-Connecting-IP / X-Forwarded-For
    trustProxy: true,
    bodyLimit: 1_000_000,
    // ⚠️ 请求超时：防止慢查询 / 慢客户端无限占用连接。
    requestTimeout: 30_000,
    // 连接建立但迟迟不发送首行，10s 关掉
    connectionTimeout: 10_000,
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  const ORIGINS = [
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    /^https:\/\/([a-z0-9-]+\.)*geniefront\.com$/,
    /^https:\/\/[a-z0-9-]+\.pages\.dev$/,   // Pages 预览部署
  ];
  const CORS_BASE = {
    credentials: false,
    allowedHeaders: [
      'Authorization', 'Content-Type', 'X-Membership-Id', 'Idempotency-Key',
      'X-Device-Token', 'X-Staff-Token', 'X-GF-Public-Key', 'X-GF-Form-Token',
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    maxAge: 86400,
  };

  void app.register(cors, {
    delegator(req: FastifyRequest, cb) {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path.startsWith('/public/')) {
        // ⛔ credentials 必须是 false，永远不要在这里改它
        return cb(null, { ...CORS_BASE, credentials: false, origin: true });
      }
      const origin = req.headers.origin;
      // 无 origin = 同源或非浏览器（curl、健康探针），放行
      const ok = !origin || ORIGINS.some((re) => re.test(origin));
      cb(null, { ...CORS_BASE, origin: ok });
    },
  });

  // ── 原始字节（webhook 验签用）─────────────────────────────────────────────
  registerRawBodyParser(app);

  // ── 健康探针 ───────────────────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

  // ── 错误映射 ───────────────────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const status = httpStatusFor[err.code];
      if (status >= 500) req.log.error({ err }, err.code);
      else req.log.info({ code: err.code, details: err.details }, 'business error');
      return reply.status(status).send(err.toJSON());
    }
    req.log.error({ err }, 'unhandled');
    return reply.status(500).send(new AppError(ERROR_CODES.INTERNAL).toJSON());
  });

  // ── 认证：除白名单外全部要令牌 ─────────────────────────────────────────────
  const PUBLIC = new Set(['/health']);

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (PUBLIC.has(path)) return;
    if (path.startsWith('/v1/telnyx/')) return;
    if (path.startsWith('/v1/kiosk/')) return;
    if (path.startsWith('/public/')) return;
    if (path.startsWith('/v1/public/')) return;
    if (path === '/v1/stripe/webhook') return;
    if (path.startsWith('/v1/auth/')) return;

    const t = req.headers[STAFF_TOKEN_HEADER];
    if (typeof t === 'string' && t.length > 0) return;
    req.user = await verifyAccessToken(req.headers.authorization);
  });

  /** 从请求头解析出命令上下文。客户端自报的 membershipId 必须验归属。 */
  async function ctxFromHeaders(req: { user?: { userId: string }; headers: Record<string, unknown>; ip: string }) {
    const staffToken = req.headers[STAFF_TOKEN_HEADER];
    if (typeof staffToken === 'string' && staffToken) {
      return staffContextFromToken(staffToken, req.ip);
    }

    const userId = req.user!.userId;
    const membershipId = req.headers['x-membership-id'];
    if (typeof membershipId !== 'string' || !membershipId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '缺少 X-Membership-Id：先调 /v1/me/locations 选店' },
      });
    }
    return buildContext({ userId, membershipId, ip: req.ip });
  }

  // ── 命令入口 ───────────────────────────────────────────────────────────────
  const commandNames = new Set(registeredCommands().map((c) => c.name));
  const ENQUEUES_NOTIFICATIONS = new Set(['appointment.create']);

  const handleCommand = async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
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

    if (ENQUEUES_NOTIFICATIONS.has(name)) {
      const t = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
      void flushEmails(t, req.log);
      void flushSms(t, req.log);
    }

    return reply.status(out.replayed ? 200 : 201).send(out);
  };

  app.post<{ Params: { name: string } }>('/v1/commands/:name', handleCommand);
  app.post<{ Params: { name: string } }>('/api/commands/:name', handleCommand);

  // ── 业务模块路由注册 ───────────────────────────────────────────────────────
  registerMeRoutes(app, ctxFromHeaders);
  registerCustomersRoutes(app, ctxFromHeaders);
  registerScheduleRoutes(app, ctxFromHeaders);
  registerRotationRoutes(app, ctxFromHeaders);
  registerTicketsRoutes(app, ctxFromHeaders);
  registerSettingsRoutes(app, ctxFromHeaders);
  registerNotificationRoutes(app, ctxFromHeaders);
  registerMoneyRoutes(app, ctxFromHeaders);
  registerMarketingRoutes(app, ctxFromHeaders);
  registerAnalyticsRoutes(app, ctxFromHeaders);
  registerStaffRoutes(app, ctxFromHeaders);
  registerAiRoutes(app, ctxFromHeaders);
  registerBillingRoutes(app, ctxFromHeaders);
  registerHardwareRoutes(app, ctxFromHeaders);
  registerReviewsRoutes(app, ctxFromHeaders);
  registerFormsRoutes(app, ctxFromHeaders);
  registerOrdersRoutes(app, ctxFromHeaders);
  registerMiscRoutes(app, ctxFromHeaders);

  // ── 外部与特化路由 ─────────────────────────────────────────────────────────
  registerStripeRoutes(app, ctxFromHeaders);
  registerCopilotRoutes(app, ctxFromHeaders);
  registerAuthRoutes(app);
  registerPasswordResetRoutes(app);
  registerKioskRoutes(app);
  registerTelnyxRoutes(app);
  registerPublicRoutes(app);
  registerFormLinkRoutes(app);

  // ── 命令目录 ───────────────────────────────────────────────────────────────
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
