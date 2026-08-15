/**
 * HTTP 层 —— 薄薄一层，只做四件事：
 *   验令牌 → 校验 membership 归属 → 转给命令总线 → 把 AppError 翻成 HTTP
 *
 * 业务逻辑一点都不许写在这里。路由是从 contracts 的注册表**自动生成**的：
 * 加一个命令 = 自动有接口 + AI 自动会用（宪法第 1 条）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, httpStatusFor } from '@gf/contracts';
import { dispatch, registeredCommands } from './bus';
import { buildContext } from './actor';
import { verifyAccessToken, assertMembershipBelongsTo } from './auth';
import { listMembershipsForUser } from '@gf/db';
import './handlers/appointment';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Cloudflare 在前面，真实 IP 在 CF-Connecting-IP / X-Forwarded-For
    trustProxy: true,
    bodyLimit: 1_000_000,
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

  // ── 店铺选择器 ─────────────────────────────────────────────────────────────
  // 登录后第一个调用。只有一条就直接进，多条出选择器（02 §2）。
  app.get('/v1/me/locations', async (req) => {
    const list = await listMembershipsForUser(req.user!.userId);
    return { locations: list };
  });

  // ── 命令入口 ───────────────────────────────────────────────────────────────
  const commandNames = new Set(registeredCommands().map((c) => c.name));

  app.post<{ Params: { name: string } }>('/v1/commands/:name', async (req, reply) => {
    const userId = req.user!.userId;
    const name = req.params.name;
    if (!commandNames.has(name)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { command: name } });
    }

    const membershipId = req.headers['x-membership-id'];
    if (typeof membershipId !== 'string' || !membershipId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '缺少 X-Membership-Id：先调 /v1/me/locations 选店' },
      });
    }
    // 客户端自报的身份必须验归属，见 auth.ts
    await assertMembershipBelongsTo(userId, membershipId);

    const ctx = await buildContext({ userId, membershipId, ip: req.ip });

    const body = req.body as { input?: unknown; idempotencyKey?: string } | undefined;
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ?? body?.idempotencyKey;

    const out = await dispatch(name, body?.input ?? {}, ctx, {
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    // 重放的请求返回 200，新执行的返回 201 —— 客户端能分辨自己是不是重试成功了
    return reply.status(out.replayed ? 200 : 201).send(out);
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
