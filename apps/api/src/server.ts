/**
 * HTTP 层 —— 薄薄一层，只做四件事：
 *   验令牌 → 校验 membership 归属 → 转给命令总线 → 把 AppError 翻成 HTTP
 *
 * 业务逻辑一点都不许写在这里。路由是从 contracts 的注册表**自动生成**的：
 * 加一个命令 = 自动有接口 + AI 自动会用（宪法第 1 条）。
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import {
  AppError, ERROR_CODES, httpStatusFor, pickText, actingMembership,
  type CommandContext, type Permission,
} from '@gf/contracts';
import { dispatch, registeredCommands } from './bus';
import { buildContext } from './actor';
import { loadOrgSummary } from './queries/orgSummary';
import { loadCustomerDetail, loadCustomerList } from './queries/customer';
import { verifyAccessToken } from './auth';
import {
  listMembershipsForUser, withTenant, claimableIntentFor, readOnlineBooking, jsonb,
} from '@gf/db';

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
import './handlers/giftcard';
import './handlers/notify';
import './handlers/storefront';
import './handlers/yelp';
import './handlers/kiosk';
import './handlers/billing';
import './handlers/ai';
import { loadDay } from './queries/day';
import { loadMonth } from './queries/month';
import { loadBlueprint, listBlueprints } from './queries/blueprint';
import { loadCallDrafts } from './queries/callDrafts';
import { loadCalls } from './queries/calls';
import { loadForms, readSubmission } from './queries/forms';
import { loadInboundSms } from './queries/smsInbound';
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
import { loadBilling } from './queries/billing';
import { maybeAutoTopup } from './billing/autoTopup';
import { flushEmails } from './email/flush';
import { flushSms } from './sms/flush';
import { loadQueue } from './queries/queue';
import { searchBusinesses, getBusiness } from '@gf/yelp';
import { extractPriceList, costMillicents, billableTokens, MAX_IMAGE_EDGE_PX,
         itemsNeedingTranslation, translateNames, TRANSLATE_MODEL, TRANSLATE_RATES,
         planRegions, padRegion, shouldChunk, capRegions, REGION_MODEL, REGION_RATES,
         generateStorefrontDrafts,
         type PriceListImage, type ImageMediaType } from '@gf/ai';
import { resolveDate } from './handlers/dayclose';
import {
  loadEarningsBoard, loadDayClose, loadReport, reportToCsv, eachDate,
} from './queries/money';
import { loadRoster } from './queries/roster';
import { loadStaffToday } from './queries/staff';
import { currentBusinessDate, loadRotation, stripRank } from './handlers/rotation';
import { computeStanding, explain, FULL_TURN } from '@gf/rotation';
import { businessDateOf } from '@gf/scheduling';

/**
 * 为什么要看健康表 —— 白名单，前台在下拉框里选一个（`docs/15` §5）。
 *
 * ⚠️ 不接受自由文本：那样每条日志都会变成「查看」两个字，
 * 而这张表存在的意义就在于事后能回答「凭什么翻她的表」。
 */
const FORM_ACCESS_REASONS = new Set([
  'service_prep',      // 马上要给他做，先看一眼禁忌 —— 九成是这条
  'incident_review',   // 出事了，回头查
  'customer_request',  // 客人自己要一份
  'export',            // 打印 / 导出 PDF
]);

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
  const CORS_BASE = {
    credentials: false,
    // ⚠️ 漏掉任何一个自定义头，浏览器会在预检之后**静默**掐掉真正的请求 ——
    // 服务端日志里只看得到一个 204 的 OPTIONS，没有任何报错，
    // 而前端拿到的是一句语焉不详的 TypeError。X-Device-Token 就这么漏过一次。
    allowedHeaders: [
      'Authorization', 'Content-Type', 'X-Membership-Id', 'Idempotency-Key',
      'X-Device-Token', 'X-Staff-Token', 'X-GF-Public-Key', 'X-GF-Form-Token',
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    maxAge: 86400,
  };

  /**
   * ⭐ 公开预约（`/public/*`）走的是**每店白名单**，不是这里这份全局正则 ——
   * 门店官网的域名一家一个（docs/13 §3）。
   *
   * 所以这一段对 `/public/*` **反射任意 Origin**，把真正的判断交给
   * `publicAuth.assertOriginAllowed`。两个理由：
   *
   *   1. 白名单在库里，而 CORS 这一层不能 await 一次查询就为了决定回哪个头
   *   2. **CORS 失败是个哑巴错误** —— 浏览器控制台一句红字，前端拿到的是
   *      语焉不详的 TypeError。让请求进到路由里、回一个带 CORS 头的
   *      `403 origin_not_allowed`，做官网的那个人才知道自己该去填白名单
   *
   * ⚠️ 反射 Origin 在这里是安全的，因为 `credentials: false` ——
   * 浏览器不会带上任何 cookie，而这些接口的身份是请求头里那个公开 key。
   */
  void app.register(cors, {
    delegator(req: FastifyRequest, cb) {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path.startsWith('/public/')) {
        return cb(null, { ...CORS_BASE, origin: true });
      }
      const origin = req.headers.origin;
      // 无 origin = 同源或非浏览器（curl、健康探针），放行
      const ok = !origin || ORIGINS.some((re) => re.test(origin));
      cb(null, { ...CORS_BASE, origin: ok });
    },
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
    /**
     * ⭐ 门店官网的公开预约（docs/13）。身份是一个 `public_key`，
     * 在 public/routes.ts 自己那一层解 —— 和门口 iPad 同一个套路。
     *
     * ⚠️ 放进这里**不等于放行**：那一层的上下文权限只有两条
     * （appointment.write / appointment.cancel），而且每次 dispatch 的
     * 入参都是路由自己拼的，官网说了不算（publicAuth.ts 文件头）。
     */
    if (path.startsWith('/public/')) return;
    // Stripe 的 webhook 同理：身份是一个 HMAC 签名，在 stripe/routes.ts 里验。
    // ⚠️ 只有 /v1/stripe/webhook 这一条是公开的 —— 老板端那几条
    // （/v1/billing/*）走正常的 Bearer 校验，别把它们放进这个前缀
    if (path === '/v1/stripe/webhook') return;
    /**
     * 技师上机那几条也在认证之前 —— 打进来的人这一刻还什么都不是
     * （sql/0031）。它们各自的门在路由里：上机码是「一次性 + 限频 +
     * 15 分钟」，手机验证码是 Telnyx Verify + 限频。
     *
     * ⚠️ `/v1/auth/staff/me` 是唯一一条要令牌的，它自己验 X-Staff-Token。
     */
    if (path.startsWith('/v1/auth/')) return;
    /**
     * ⭐ 技师手机上带的是会话令牌，不是 Supabase 的 Bearer。
     * 有它就跳过 JWT 那一关 —— 归属与权限由 staffContextFromToken 解，
     * 它走的是令牌摘要维度的 RLS（和门口 iPad 同一个套路）。
     */
    if (req.headers[STAFF_TOKEN_HEADER]) return;
    req.user = await verifyAccessToken(req.headers.authorization);
  });

  /** 从请求头解析出命令上下文。客户端自报的 membershipId 必须验归属。 */
  async function ctxFromHeaders(req: { user?: { userId: string }; headers: Record<string, unknown>; ip: string }) {
    /**
     * ⭐ 技师手机上机的那条路：身份是一条会话，不是一个平台账号。
     *
     * 放在最前面是因为这两种身份**互斥** —— 带了会话令牌就不该再去
     * 读 X-Membership-Id（那是客户端自报的，而会话令牌里的 membership
     * 是数据库给的）。允许两者混用等于给了一条「用技师令牌冒充别人」的路。
     */
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
    // 不再单独调 assertMembershipBelongsTo：buildContext 里的
    // loadMembershipBase 走用户维度 RLS，别人的 membership 直接查不到，
    // 同样抛 PERMISSION_DENIED。省掉热路径上的一次往返。
    return buildContext({ userId, membershipId, ip: req.ip });
  }

  /**
   * ── 店铺选择器 ───────────────────────────────────────────────────────────
   *
   * 登录后第一个调用。只有一条就直接进，多条出选择器（02 §2）。
   *
   * ⭐ **`claimable`（0047）**：这条路同时回答「登录之后该去哪一页」。
   *
   * 之前前端只能拿到 `locations`。一个刚用 Google 登录进来的老板
   * `locations` 是空的，而前端分不出他是「刚付完钱等着开通」还是
   * 「谁也不是」—— 只能盲发一次 `POST /v1/setup/claim` 再看是不是 404，
   * 也就是**用一次写操作去探测状态**。多这一个字段就不用那么干了。
   *
   * ⚠️ `claimable` 和 `locations` **可以同时非空**：一个老板已经有一家店，
   * 又刚买了第二家。所以不能写成「locations 空了才去查」。
   */
  app.get('/v1/me/locations', async (req) => {
    // ⚠️ 这条路要的是**平台账号**。技师用手机上机时没有账号，
    // 他的店是会话自己带的（/v1/auth/staff/me）—— 不挡的话
    // `req.user!` 会在这里炸成一个 500，而真正的原因是「这条路不适用于他」
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'requires_platform_account' } });

    const [list, intent] = await Promise.all([
      listMembershipsForUser(req.user.userId),
      claimableIntentFor(req.user.userId),
    ]);

    return {
      locations: list,
      /*
       * ⚠️ **不回 `intentId`。** 认领那条路自己去数据库要 intent
       * （`gf_signup_intent_for_user` 比对的是 auth.users 里的邮箱），
       * 前端把 id 传回来一点用都没有 —— 而一旦回了，下一个人就会想
       * 「那我传一个别的 id 试试」。这里回的全是给人看的字。
       */
      claimable: intent
        ? { locationId: intent.locationId, shopName: intent.shopName, plan: intent.plan }
        : null,
    };
  });

  /**
   * ── ⭐ 我在这家店能干什么 ────────────────────────────────────────────────
   *
   * 选完店之后前端问的第二句话。和技师端的 `/v1/auth/staff/me` 是同一件事
   * ——那一条从第一天就回 `permissions[]`，而平台账号这一侧一直只有
   * `/v1/me/locations` 的 `roleKeys`，没有等价物。
   *
   * ## 为什么 `roleKeys` 不够
   *
   * 前端拿角色 key 去点亮按钮，等于把权限判定抄了第二份，而那一份**是错的**：
   *
   *   实际权限 = 角色预设 ∪ 个别授予 − 个别撤销   （`permission_overrides`）
   *
   * 老板完全可以只撤掉某一个前台的 `ticket.discount`（她上个月打折打出事了），
   * 或者只给某一个店长开 `report.view`。这些都不改角色。
   * 抄一份角色表的结果是：按钮亮着，点下去 403 —— 而用的人只会觉得系统坏了。
   *
   * ⚠️ 这条路由**不是**权限边界。真正的判定在命令总线里（每一条命令执行前
   * 查 `role_permissions`）。这里回的东西只用来决定**画不画那个按钮**，
   * 前端改了它一个字节也拿不到任何多余的能力。
   */
  app.get('/v1/me/context', async (req) => {
    const ctx = await ctxFromHeaders(req);
    return {
      membershipId: ctx.membershipId,
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      locale: ctx.locale,
      timezone: ctx.timezone,
      // 排序是为了让前端能直接比对/缓存，不是给人读的
      permissions: [...ctx.permissions].sort(),
    };
  });

  /**
   * ── 跨店汇总（批 4）────────────────────────────────────────────────────
   *
   * 多店老板现在要一家家切进去看。这条给他一屏。
   *
   * ⚠️ **门店范围由 `listMembershipsForUser` 决定，不接受入参。**
   * 接受 locationIds 入参的话，「拿到别人的 location id 就能查他的营收」——
   * 而 location id 会出现在 URL 里。`scope=<id>` 只是个**过滤器**，
   * 它只能在「我有权限的那些店」里再挑一个，挑不出集合以外的东西。
   *
   * 权限：`report.view`（店长也有）。⚠️ 但看得见的**只有他自己有
   * membership 的那些店** —— A 店的店长看不到 B 店，哪怕两家是同一个 org。
   */
  app.get<{ Querystring: { from?: string; to?: string; scope?: string } }>(
    '/v1/me/summary', async (req) => {
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'requires_platform_account' } });

    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const to = DATE.test(req.query.to ?? '') ? req.query.to! : todayIso();
    const from = DATE.test(req.query.from ?? '') ? req.query.from! : addDaysIso(to, -6);
    if (from > to) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_range' } });
    }

    const all = await listMembershipsForUser(req.user.userId);
    const scoped = req.query.scope && req.query.scope !== 'all'
      ? all.filter((m) => m.locationId === req.query.scope)
      : all;

    /*
     * ⚠️ 只汇总他**有报表权限**的店。
     *
     * 一个人可能在 A 店是老板、在 B 店只是技师（这行真实存在：
     * 老板去朋友店里兼职接客）。把 B 店的营收也加进他的合计里，
     * 等于让技师看到了店里的钱。
     */
    const allowed: Array<{ orgId: string; locationId: string; membershipId: string }> = [];
    for (const m of scoped) {
      const ctx = await buildContext({ userId: req.user.userId, membershipId: m.membershipId });
      if (ctx.permissions.has('report.view')) {
        allowed.push({ orgId: m.orgId, locationId: m.locationId, membershipId: m.membershipId });
      }
    }

    return loadOrgSummary(allowed, from, to);
  });

  /**
   * ── 认领门店（自助开户的最后一步，docs/12 §3 B）────────────────────────
   *
   * 老板刚点开激活邮件里的链接，这一刻他在系统里除了一个 Supabase 账号
   * 什么都没有 —— 所以这条路**不要 X-Membership-Id**，也没法用
   * ctxFromHeaders：那个函数的第一句就是「先调 /v1/me/locations 选店」。
   *
   * ⭐ 身份边界在数据库里：`claimableIntentFor` 调的是
   * `gf_signup_intent_for_user()`，它比对的是 **auth.users 里那一行的邮箱**。
   * 应用这一侧只能传一个 user id，而那个 id 是从已验签的 JWT 解出来的 ——
   * 于是「谁能成为这家店的老板」是一条数据库事实，不是一句能被忘记的 if。
   *
   * 一个邮箱买了两家店就调两次：每次认领最早的那一家。
   */
  app.post('/v1/setup/claim', async (req) => {
    // 认领门店要的是付款那个邮箱背后的**平台账号**，技师会话在这里没有意义
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'requires_platform_account' } });
    const userId = req.user.userId;
    const intent = await claimableIntentFor(userId);
    if (!intent) {
      // 不区分「没有这条 intent」和「不是你的」—— 否则可以拿它探测
      // 别人的开户状态（和 assertMembershipBelongsTo 同一条纪律）
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'no_claimable_signup' } });
    }

    /**
     * 现组一个上下文。`membershipId: null` —— 他还没有 membership，
     * 这条命令本身就是去造那一条。
     *
     * 权限只给 `settings.manage` 一条：伪造不了（intent 是数据库给的），
     * 而且这个上下文只活到下面那一次 dispatch 为止。
     */
    const ctx: CommandContext = {
      orgId: intent.orgId,
      locationId: intent.locationId,
      userId,
      membershipId: null,
      permissions: new Set<Permission>(['settings.manage']),
      actorKind: 'user',
      locale: 'en',
      timezone: 'UTC',
      ip: req.ip,
    };

    const out = await dispatch<{ membershipId: string; locationId: string; orgId: string }>(
      'setup.claimLocation', { intentId: intent.intentId }, ctx,
      { idempotencyKey: `claim-${intent.intentId}` },
    );
    return out.result;
  });

  // ── 命令入口 ───────────────────────────────────────────────────────────────
  const commandNames = new Set(registeredCommands().map((c) => c.name));

  /**
   * 哪些命令可能往发件箱里放东西。
   *
   * 用白名单而不是每条命令都扫一遍：`/v1/commands` 是最热的一条路，
   * 给它无条件加一次带索引的查询是没必要的开销。
   * 加新的邮件触发点时**记得往这里加一条** —— 漏了的表现是
   * 「信躺在 outbox 里没人发」，直到这家店做了别的会触发的操作。
   */
  const ENQUEUES_NOTIFICATIONS = new Set(['appointment.create']);

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

    /**
     * ⭐ **邮件在事务提交之后才发**（`email/flush.ts` 的长注释）。
     * `dispatch` 已经返回 = 事务已经提交，这时候发才不会出现
     * 「事务回滚了但客人已经收到确认信」。
     *
     * 只在**可能入过队**的命令后面触发，不是每条命令都扫一遍表。
     * 邮件和短信各一条 outbox，各扫各的。
     * 不 await：一封信发不出去永远不该拖慢或拖垮一次成功的建单
     *（宪法第 14 条，增强项永不成为阻断点）。
     */
    if (ENQUEUES_NOTIFICATIONS.has(name)) {
      const t = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
      void flushEmails(t, req.log);
      // 短信同理：入队在事务里，发在事务外，失败不影响这次已经成功的建单
      void flushSms(t, req.log);
    }

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

  /**
   * ── 查询：区间概览（月视图）────────────────────────────────────────────
   *
   * 日历那张网格吃的是这一条，**不是循环调 31 次 `/v1/desk/day`**。
   * 那样是 124 次查询，而且每天都把全店的员工、项目、房间原样带一遍 ——
   * 日历格子上一个字都用不到它们。
   *
   * 这里每天只回密度：开不开门、几点到几点、几条单、几个人上班、日结了没有。
   * 点进某一天再调 `/v1/desk/day` 拿细节。
   */
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/desk/days', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }

    const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
    const DATE = /^\d{4}-\d{2}-\d{2}$/;

    // 不传就给「本月」—— 按门店的营业日算，不是按服务器的今天
    const today = await withTenant(tenant, (tx) => resolveDate(tx, ctx.locationId));
    const from = DATE.test(req.query.from ?? '') ? req.query.from! : `${today.slice(0, 7)}-01`;
    const to = DATE.test(req.query.to ?? '') ? req.query.to! : addDaysIso(`${today.slice(0, 7)}-01`, 41);

    if (from > to) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_range' } });
    }
    /*
     * ⚠️ 区间要封顶。
     *
     * 月视图最多要六周（42 天，日历网格把上下月的边角也画出来）。
     * 给到 92 天让季度视图也够用，再多就是有人拿 `from=2020-01-01`
     * 扫全库 —— 那三条聚合查询会全表扫，而门店的库和别人共用一个实例。
     */
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(span) || span > 92) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'range_too_wide', maxDays: 92 },
      });
    }

    return withTenant(tenant, (tx) => loadMonth(tx, ctx.locationId, from, to));
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
  /**
   * ── 客户档案（批 6）───────────────────────────────────────────────────
   *
   * ⭐ **一个请求返回一整页**，不让前端拼七个。客户详情要的东西散在
   * 七张表上，并发七个请求在弱网下会有几个失败 —— 页面上一半有数据
   * 一半转圈，前台看到的是「系统坏了」。
   *
   * ⚠️ **脱敏在服务端按角色做**，不是返回全量让前端隐藏。没有
   * `customer.view_contact` 的人拿到的 payload 里就没有完整号码；
   * 没有 `report.view` 的人拿不到任何金额。
   */
  app.get<{ Params: { id: string } }>('/v1/desk/customers/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }
    const detail = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCustomerDetail(tx, ctx, req.params.id));
    if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'customer' } });
    return detail;
  });

  app.get<{ Querystring: {
    q?: string; vip?: string; sleeping?: string; limit?: string; offset?: string;
  } }>('/v1/desk/customers', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }
    const int = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    };
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCustomerList(tx, ctx, {
        ...(req.query.q ? { q: req.query.q } : {}),
        vipOnly: req.query.vip === '1',
        ...(int(req.query.sleeping) ? { sleepingDays: int(req.query.sleeping)! } : {}),
        ...(int(req.query.limit) ? { limit: int(req.query.limit)! } : {}),
        ...(int(req.query.offset) ? { offset: int(req.query.offset)! } : {}),
      }));
  });

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
          group_id: string | null; group_label: string | null; business_date: string;
          subtotal_cents: number; item_id: string; item_name: string; item_total: number;
          duration_min: number; staff_name: unknown; membership_id: string;
        }[]>`
          select t.id as ticket_id, c.display_name as customer_name, t.walk_in_name,
                 t.group_id, g.label as group_label,
                 t.business_date::text as business_date,
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
          order by t.business_date, t.opened_at, ti.seq`;

        const map = new Map<string, {
          ticketId: string; customerName: string; subtotalCents: number;
          groupId: string | null; groupLabel: string | null;
          businessDate: string; daysAgo: number;
          items: Array<Record<string, unknown>>;
        }>();
        // ⭐ 隔夜单（0032）。这条查询按 status 过滤而**不按营业日** ——
        // 那是对的：昨天开的单今天照样要能结掉。错的是把它跟今天的单
        // 混在一个列表里不作区分：前台看不出哪张是哪天的，而封账会以
        // 「还有单没结」为由被拦下，老板不知道拦他的是三天前的一张幽灵单。
        // 服务端直接算好 daysAgo，别让每个客户端各写一遍日期减法。
        const today = await resolveDate(tx, ctx.locationId);
        const todayMs = Date.parse(`${today}T00:00:00Z`);
        const daysAgoOf = (d: string) =>
          Math.max(0, Math.round((todayMs - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));

        for (const r of rows) {
          const t = map.get(r.ticket_id) ?? {
            ticketId: r.ticket_id,
            customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
            subtotalCents: r.subtotal_cents,
            groupId: r.group_id, groupLabel: r.group_label,
            businessDate: r.business_date,
            daysAgo: daysAgoOf(r.business_date),
            items: [],
          };
          t.items.push({
            ticketItemId: r.item_id, name: r.item_name, totalCents: r.item_total,
            durationMin: r.duration_min, staffName: pickText(r.staff_name, ctx.locale),
            membershipId: r.membership_id,
          });
          map.set(r.ticket_id, t);
        }
        const tickets = [...map.values()];
        return {
          businessDate: today,
          tickets,
          /** 前台一眼要知道「这堆里有几张不是今天的」，不用自己数 */
          staleCount: tickets.filter((t) => t.daysAgo > 0).length,
        };
      });
  });

  // ── 查询：没记完的日子（0032）─────────────────────────────────────────────
  //
  // 开工时那条横幅要的数据。**它不拦任何东西** —— 前台可以一天不理它，
  // 照样开单结账封账。挡路的提醒，前台学会的是无视所有提醒。
  app.get<{ Querystring: { days?: string } }>('/v1/desk/gaps', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('dayclose.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'dayclose.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const today = await resolveDate(tx, ctx.locationId);
        // 往回看多远：默认两周。看太远会把一家店刚上线之前的日子全算成断档
        const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 60);
        const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
          .toISOString().slice(0, 10);
        // 今天还没过完，不算断档 —— 拿昨天当上界
        const to = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
          .toISOString().slice(0, 10);

        // ⚠️ 门店上线之前的日子不是断档。用最早的一条工单当起点，
        //    否则一家昨天刚开通的店，一进来就看到「有 14 天没记完」
        const [first] = await tx<{ d: string | null }[]>`
          select min(business_date)::text as d from tickets
          where location_id = ${ctx.locationId}`;
        const start = first?.d && first.d > from ? first.d : from;
        if (start > to) return { businessDate: today, days: [], unhandled: 0 };

        const report = await loadReport(tx, ctx, start, to);
        const gaps = report.byDay
          .filter((d) => d.status !== 'ok' && d.status !== 'no_business')
          .map((d) => ({
            businessDate: d.key,
            status: d.status,
            ticketCount: d.ticketCount,
            grossCents: d.grossCents,
            hasEarnings: d.hasEarnings,
            note: d.note,
          }));
        return {
          businessDate: today,
          days: gaps,
          /** 还没人处理过的天数 —— 横幅上那个数字 */
          unhandled: gaps.filter((d) => d.status === 'no_record').length,
        };
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
          business_type: string; cutoff: string; status: string;
          has_address: boolean; profile_confirmed_at: string | null;
          settings: unknown;
        }[]>`
          select name, timezone, business_hours, business_type,
                 business_day_cutoff::text as cutoff, status,
                 (address is not null or yelp_business_id is not null) as has_address,
                 settings->>'profile_confirmed_at' as profile_confirmed_at,
                 settings
          from locations where id = ${ctx.locationId}`;

        const services = await tx<{
          id: string; name: unknown; duration_min: number; base_price_cents: number;
          taxable: boolean; online_bookable: boolean; is_addon: boolean; active: boolean;
        }[]>`
          select id, name, duration_min, base_price_cents, taxable, online_bookable,
                 is_addon, active
          from services where location_id = ${ctx.locationId}
          order by active desc, sort, name->>'en'`;

        const date = businessDateOf(new Date(), loc!.timezone, loc!.cutoff);
        const staff = await tx<{
          membership_id: string; name: unknown; is_bookable: boolean;
          max_concurrent: number; level_key: string | null; in_rotation: boolean | null;
          phone_e164: string | null; has_account: boolean; live_sessions: number;
          role_keys: string[] | null;
        }[]>`
          select sp.membership_id, sp.display_name as name, sp.is_bookable,
                 sp.max_concurrent_appointments as max_concurrent,
                 sl.key as level_key, rp.in_rotation, sp.phone_e164,
                 -- ⭐ 「他上过机没有」是推导出来的，没有状态列：
                 -- user_id 有值 = 用邮箱登录过；有活着的会话 = 手机上机过。
                 -- 存一个 has_logged_in 布尔的话，踢下线之后它就说谎了
                 (m.user_id is not null) as has_account,
                 (select count(*) from staff_sessions ss
                   where ss.membership_id = sp.membership_id
                     and ss.revoked_at is null and ss.expires_at > now())::int as live_sessions,
                 (select array_remove(array_agg(r.key), null)
                    from membership_roles mr join roles r on r.id = mr.role_id
                   where mr.membership_id = sp.membership_id) as role_keys
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

        // 官网对接那一页（docs/13）：公开 key + 域名白名单 + 在线预约配置
        const [web] = await tx<{ public_key: string; slug: string }[]>`
          select public_key, slug from locations where id = ${ctx.locationId}`;
        const origins = await tx<{ id: string; origin: string; label: string | null }[]>`
          select id, origin, label from location_allowed_origins
          where location_id = ${ctx.locationId} order by origin`;

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
            businessDayCutoff: loc!.cutoff.slice(0, 5),
            /** setup = 开店向导还没走完（sql/0030） */
            status: loc!.status,
            /**
             * ⭐ 开店向导的进度**全部是从真实数据推出来的**，
             * 没有一个「走到第几步」的计数器（docs/12 §3 C 规矩 2）：
             * 存步数的话，老板换台设备登录会被拉回一个假的进度。
             *
             * 于是「已完成」和「真的能用了」永远是同一件事 ——
             * 他从别的入口把项目建好了，向导那一项自己就会变成 ✓。
             */
            hasAddress: loc!.has_address,
            profileConfirmedAt: loc!.profile_confirmed_at,
          },
          services: services.map((s) => ({
            id: s.id, name: s.name as Record<string, string>,
            displayName: pickText(s.name, ctx.locale),
            durationMin: s.duration_min, basePriceCents: s.base_price_cents,
            taxable: s.taxable, onlineBookable: s.online_bookable,
            isAddon: s.is_addon, active: s.active,
          })),
          staff: staff.map((s) => ({
            membershipId: s.membership_id,
            name: pickText(s.name, ctx.locale),
            isBookable: s.is_bookable,
            maxConcurrent: s.max_concurrent,
            levelKey: s.level_key,
            inRotation: s.in_rotation ?? s.is_bookable,
            roleKeys: s.role_keys ?? [],
            /** 老板要照着这个打电话给技师，所以不脱敏 —— 他本来就有这个号 */
            phoneE164: s.phone_e164,
            /** 这三个一起回答「他能不能在自己手机上看到派单」 */
            hasAccount: s.has_account,
            liveSessions: s.live_sessions,
          })),
          levels: levels.map((l) => ({
            id: l.id, key: l.key, name: pickText(l.name, ctx.locale),
          })),
          guest: {
            /**
             * ⚠️ 这串**不是密钥**，它本来就要出现在老板官网的 JS 里
             * （docs/13 §3）。放在这里是为了让他能一键复制给做官网的人。
             */
            publicKey: web!.public_key,
            slug: web!.slug,
            allowedOrigins: origins,
            onlineBooking: readOnlineBooking(
              (loc!.settings ?? {}) as Record<string, unknown>),
            /** 一个都没勾就打不开在线预约（handlers/setup.ts 里拦着） */
            onlineBookableCount: services.filter((x) => x.active && x.online_bookable).length,
          },
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
        // ⭐ 0032 之后 byDay 是**按区间铺满**的（没记的那天也要回一行），
        // 所以行数不再由数据量决定，而是由区间长度决定。
        // 不封顶的话 `?from=2000-01-01` 就能让服务端生成上万行 —— 一年够用了。
        const span = eachDate(from, to).length;
        if (span > 366) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: '一次最多查一年', days: span },
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
  /**
   * ── 建站工单：AI 出三版（批 8 收尾，docs/17 §6）─────────────────────────
   *
   * ⚠️ **这是第二条不走命令总线的路由**（第一条是 blueprint/extract）。
   * 理由一样：模型调用要几十秒，塞进数据库事务会占住一个连接和一个快照
   * 那么久。这里只做编排 —— 校验 → 调模型 → 把结果交给一条写库语句。
   *
   * ⭐ 出**三版**不是一版：给一版的话老板只能说「不喜欢」而说不出
   * 哪里不喜欢，然后我们只能猜。三版风格拉开，他一定选得出一个，
   * 而他的选择本身就是最精确的反馈。
   */
  app.post<{ Params: { id: string } }>('/v1/storefront/:id/generate', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      req.log.error('ANTHROPIC_API_KEY 未配置，建站工单生成不可用');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    }

    const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };

    /*
     * 先确认工单已提交再花那几毛钱。
     *
     * ⚠️ 只有 submitted 能生成 —— draft 还在改，chosen / live 已经定了。
     * 对着一份还在改的工单跑模型，钱花了而老板下一分钟又改了需求。
     */
    const brief = await withTenant(tenant, (tx) => tx<{
      id: string; status: string; shop_name: unknown; business_type: string;
      voice: string | null; brand_primary: string | null; brand_accent: string | null;
      pain_points: string[]; pain_free_text: string | null;
      audience: string[]; top_questions: string[]; sections: string[];
      usp: string | null; tone: string | null; reference_sites: string[];
    }[]>`
      select b.id, b.status, l.name as shop_name, l.business_type,
             b.voice, b.brand_primary, b.brand_accent,
             b.pain_points, b.pain_free_text, b.audience, b.top_questions,
             b.sections, b.usp, b.tone, b.reference_sites
      from storefront_briefs b
      join locations l on l.id = b.location_id
      where b.id = ${req.params.id} and b.location_id = ${ctx.locationId}`);

    const row = brief[0];
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_brief' } });
    if (row.status !== 'submitted') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'brief_not_submitted', status: row.status },
      });
    }

    // ⚠️ 项目名和价格要给模型真的 —— system prompt 里明令「不许编」，
    // 但不给它真数据的话它只能编
    const services = await withTenant(tenant, (tx) => tx<{
      name: unknown; price: number; minutes: number;
    }[]>`
      select name, base_price_cents as price, duration_min as minutes
      from services
      where location_id = ${ctx.locationId} and active = true and is_addon = false
      order by sort, base_price_cents limit 40`);

    const result = await generateStorefrontDrafts({
      shopName: pickText(row.shop_name, ctx.locale, ''),
      businessType: row.business_type,
      voice: row.voice,
      brandPrimary: row.brand_primary,
      brandAccent: row.brand_accent,
      painPoints: row.pain_points ?? [],
      painFreeText: row.pain_free_text,
      audience: row.audience ?? [],
      topQuestions: row.top_questions ?? [],
      sections: row.sections ?? [],
      usp: row.usp,
      tone: row.tone,
      referenceSites: row.reference_sites ?? [],
      services: services.map((s) => ({
        name: pickText(s.name, ctx.locale, ''),
        priceCents: s.price, durationMin: s.minutes,
      })),
    }, { apiKey });

    /*
     * 一版都没出来 = 别把工单推到 drafted 让老板看一个空列表。
     * 502 而不是 500：挂的是上游模型，两个数字要分得开才看得出趋势。
     */
    if (result.drafts.length === 0) {
      throw new AppError(ERROR_CODES.EXTRACTION_FAILED, {
        details: { reason: 'no_drafts_generated', model: result.model },
      });
    }

    const cost = costMillicents(result.usage);
    await withTenant(tenant, async (tx) => {
      // 重跑就换一批 —— 老板点「重新生成」时不该看到六版
      await tx`delete from storefront_drafts where brief_id = ${row.id}`;
      for (const d of result.drafts) {
        await tx`
          insert into storefront_drafts
            (org_id, location_id, brief_id, variant, content,
             model, input_tokens, output_tokens, cost_millicents)
          values (${ctx.orgId}, ${ctx.locationId}, ${row.id}, ${d.variant},
                  ${jsonb(d.content)}::jsonb, ${result.model},
                  ${result.usage.inputTokens}, ${result.usage.outputTokens}, ${cost})`;
      }
      await tx`
        update storefront_briefs set status = 'drafted', drafted_at = now(), updated_at = now()
        where id = ${row.id}`;
    });

    return {
      briefId: row.id,
      status: 'drafted',
      drafts: result.drafts,
      model: result.model,
      costMillicents: cost,
    };
  });

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

  // ── 大牌子分块：第一遍只看结构 ─────────────────────────────────────────────
  //
  // 一张 A3 的价目表可能有 80 行，一次性提取容易**漏行**。撑爆 max_tokens
  // 会报 too_many_rows（老板知道出事了），漏三行则不报任何错 ——
  // 老板要到三个月后有客人点了一个不存在的项目才发现。
  //
  // ⭐ **裁图在前端做**（canvas）。服务端裁要引图像库，而浏览器本来就在缩图；
  // 裁出来的小块图像 token 更少、模型注意力更集中，比「发整张图但告诉它
  // 只看某块」既便宜又准。裁好的块当成普通照片走现有的 /extract，
  // mergeDrafts 会把重叠处的重复行合掉 —— 那条链路一行都不用改。
  //
  // 不带 blueprint id：这一步在建草案**之前**，什么都不写库。
  app.post('/v1/blueprint/plan-regions', { bodyLimit: 8_000_000 }, async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage') || !ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage+ai.use' } });
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    }

    const im = (req.body ?? {}) as {
      base64?: string; mediaType?: string; widthPx?: number; heightPx?: number;
    };
    if (typeof im.base64 !== 'string' || !im.base64
        || typeof im.mediaType !== 'string' || !MEDIA_TYPES.has(im.mediaType)
        || !im.widthPx || !im.heightPx) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '要一张带尺寸的照片' },
      });
    }

    const r = await planRegions({
      seq: 0, base64: im.base64, mediaType: im.mediaType as ImageMediaType,
      widthPx: im.widthPx, heightPx: im.heightPx,
    }, { apiKey });

    // 钱已经花了，先记账再判断能不能用（和补齐那条路同一个道理）
    await dispatch('ai.recordAssist', {
      feature: 'price_list_regions',
      model: REGION_MODEL,
      tokens: billableTokens(r.usage),
      costMillicents: costMillicents(r.usage, REGION_RATES),
    }, ctx);
    void maybeAutoTopup(ctx, 'credit', req.log);

    // ⭐ 覆盖不全就**退回整张图提取**，不要自己补一块 ——
    // 补出来的边界是猜的，裁歪了会把一行字劈成两半，两边都读不全。
    const usable = !r.error && shouldChunk(r.regions) && r.coverage.ok;
    // 超过 6 块就把相邻的并起来。只裁前 6 块会把后面几块整个丢掉 ——
    // 那和漏分区是同一种灾难，而合并只是让某块大一点，一行都不会少。
    const capped = usable ? capRegions(r.regions, MAX_IMAGES_PER_EXTRACT) : [];

    return {
      chunk: usable,
      reason: r.error ?? (!shouldChunk(r.regions) ? 'single_region'
        : !r.coverage.ok ? 'coverage_gap' : null),
      coveredRatio: Math.round(r.coverage.covered * 100),
      regions: capped.map((g) => ({
        label: g.label,
        crop: padRegion(g, im.widthPx!, im.heightPx!),
      })),
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

  // ── 查询：薪酬方案 ────────────────────────────────────────────────────────
  //
  // 提成引擎从 Phase 1b 就在算，但方案一直只能改数据库 —— 老板要调一个人的
  // 提成率得找我们。这条查询是配套界面的前提。
  //
  // ⚠️ 只取**每个人当前生效的那一版**。方案是版本化的（改规则不影响
  // 已经算过的单），历史版本对「现在给他多少」这个问题没有意义，
  // 摆出来只会让老板以为可以改历史。
  app.get('/v1/desk/payroll/plans', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('payroll.configure')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.configure' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const rows = await tx<{
          membership_id: string | null; version: number; config: unknown;
        }[]>`
          select distinct on (membership_id) membership_id, version, config
          from compensation_plans
          where location_id = ${ctx.locationId}
          order by membership_id, version desc`;

        const staff = await tx<{ membership_id: string; name: unknown }[]>`
          select sp.membership_id, sp.display_name as name
          from staff_profiles sp
          join memberships m on m.id = sp.membership_id and m.status = 'active'
          where sp.location_id = ${ctx.locationId}
          order by sp.is_bookable desc, sp.display_name->>'en'`;

        const cats = await tx<{ id: string; name: unknown }[]>`
          select id, name from service_categories
          where location_id = ${ctx.locationId} order by sort`;

        const byMember = new Map(rows.map((r) => [r.membership_id, r]));
        const shape = (r: { version: number; config: unknown } | undefined) =>
          r ? { version: r.version, ...(r.config as Record<string, unknown>) } : null;

        return {
          /** 门店默认方案（membership_id 为 null）。新人进来自动套用 */
          defaultPlan: shape(byMember.get(null)),
          staff: staff.map((sp) => ({
            membershipId: sp.membership_id,
            name: pickText(sp.name, ctx.locale),
            /** null = 跟门店默认走，没有自己的方案 */
            plan: shape(byMember.get(sp.membership_id)),
          })),
          categories: cats.map((c) => ({ id: c.id, name: pickText(c.name, ctx.locale) })),
        };
      });
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

  // ── 查询：来电记录（转录 / 录音 / 计量，sql/0037）────────────────────────
  //
  // ⭐ 决策 6 改成「AI 直接建单」之后，前台不再逐单复核 —— 客人挂电话时
  // 单子已经落地了。客人到店说「你们电话里明明说五点」的时候，
  // **转录是唯一的证据**。
  app.get<{ Querystring: { days?: string; limit?: string } }>('/v1/desk/calls', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCalls(tx, ctx, {
        days: Number(req.query.days ?? '7') || 7,
        limit: Number(req.query.limit ?? '50') || 50,
      }));
  });

  // ── 查询：健康表（模板 / 已签 / 发出去的链接，docs/15 §5）───────────────
  //
  // 列表用 `customer.read`：前台要知道「这位客人还得签一份」，
  // 而知道这件事不需要看内容。**内容是另一条路**（下面那条），
  // 要 `customer.view_health_form`，而且看一眼就往 form_access_log 写一行。
  app.get<{ Querystring: { days?: string; limit?: string; customerId?: string } }>(
    '/v1/desk/forms', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('customer.read')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
      }
      return withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => loadForms(tx, ctx, {
          days: Number(req.query.days ?? '30') || 30,
          limit: Number(req.query.limit ?? '100') || 100,
          ...(req.query.customerId ? { customerId: req.query.customerId } : {}),
        }));
    });

  /**
   * ⭐ 打开一份已签的健康表。**这条路每走一次就留一条痕。**
   *
   * `reason` 必填且是枚举 —— 一条只写「某某周二下午看过」的日志在纠纷里
   * 几乎没有用，而带理由的那一条能回答「你们凭什么翻她的健康表」。
   *
   * ⚠️ 它是 GET 却有副作用（写 form_access_log）。这是**有意的**：
   * 把它改成 POST 会让「读」看起来像「写」，而真正的问题不在动词 ——
   * 在于**读这件事必须留痕**。浏览器不会自己预取一条要带 membership
   * 头的接口，所以不存在「预取导致假日志」。
   */
  app.get<{ Params: { id: string }; Querystring: { reason?: string } }>(
    '/v1/desk/forms/submissions/:id', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const reason = req.query.reason ?? 'service_prep';
      if (!FORM_ACCESS_REASONS.has(reason)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'bad_access_reason', allowed: [...FORM_ACCESS_REASONS] },
        });
      }
      return withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => readSubmission(tx, ctx, req.params.id, reason));
    });

  // ── 查询：客人发进来的短信（docs/09 §5.3）────────────────────────────────
  //
  // ⭐ 这一页的全部意义：运营商强制 CANCEL 是**退订**关键词，而客人打它
  // 多半是想**取消预约**。他收到「已退订」以为办完了，店里那一格还占着 ——
  // 而退订之后我们再也发不了短信给他。这张列表是前台唯一的线索。
  app.get<{ Querystring: { days?: string } }>('/v1/desk/sms-inbound', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? '14') || 14));
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadInboundSms(tx, ctx, days));
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

  // ── 技师上机：上机码 / 手机验证码（sql/0031、docs/09 §5）────────────────
  //
  // ⚠️ 这三条在认证之前 —— 打进来的人还什么都不是。
  // 每一条自己回答「伪造这一次请求的人能拿到什么」，答案是
  //「必须先说出一个 15 分钟内有效的一次性码，或者收得到那条短信」。
  registerAuthRoutes(app);

  /**
   * ── 忘记密码 ────────────────────────────────────────────────────────────
   *
   * 同样在认证之前（`/v1/auth/` 前缀已经跳过 Bearer 校验），
   * 同样自己回答那个问题：伪造这一次请求的人能拿到什么？
   * **什么都拿不到** —— 响应永远是 `{ ok: true }`，信只会发到
   * 那个邮箱本人手里，而落地页的域名是服务端拼的。
   */
  registerPasswordResetRoutes(app);

  // ── Kiosk 门口端（设备令牌鉴权）──────────────────────────────────────────
  registerKioskRoutes(app);

  // ── Telnyx：AI 工具 + 通话 webhook（09 §4.2）──────────────────────────────
  //
  // ⚠️ 这几条路由**没有登录用户**，身份全靠 Ed25519 签名。
  // 所以它们要在 PUBLIC 白名单里（跳过 Bearer 校验），
  // 而每一条的第一件事都是验签 —— 见 telnyx/routes.ts。
  registerTelnyxRoutes(app);

  // ── 门店官网的公开预约（docs/13）─────────────────────────────────────────
  //
  // ⚠️ 这是整个系统里**唯一一个不需要任何身份就能写库的入口**。
  // 身份是一个公开 key，权限收窄发生在路由那一层 —— 见 public/publicAuth.ts。
  registerPublicRoutes(app);
  // 客人自己填健康表的那条公开路（docs/15）。身份是一次性令牌，
  // 和门店官网那条互不相干 —— 它不认 pk_，也不受域名白名单约束
  registerFormLinkRoutes(app);

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



/** 今天（UTC 日期）。跨店汇总的默认区间用它兜底，各店的营业日在查询里各算各的 */
function todayIso(): string { return new Date().toISOString().slice(0, 10); }

/** `YYYY-MM-DD` ± n 天。纯日期算术，不碰时区 */
function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
