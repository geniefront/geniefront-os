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
import './handlers/customer';
import './handlers/sms';
import './handlers/resource';
import './handlers/marketing';
import './handlers/profile';
import './handlers/notification';
import { loadDay } from './queries/day';

import { loadMonth } from './queries/month';
import { loadBlueprint, listBlueprints } from './queries/blueprint';
import { loadCallDrafts } from './queries/callDrafts';
import { loadCalls } from './queries/calls';
import { loadForms, readSubmission, loadAppointmentForms } from './queries/forms';
import { loadInboundSms } from './queries/smsInbound';
import { loadRooms } from './queries/rooms';
import { loadGiftCards, loadGiftCardVerify } from './queries/giftcard';
import { loadAppointmentDetail } from './queries/appointmentDetail';
import { loadPackages, loadCoupons, loadLoyalty } from './queries/marketing';
import { loadStaffDirectory } from './queries/staffList';
import {
  loadRevenueTrends, loadCustomerAnalytics, loadStaffAnalytics,
  loadHeatmap, loadRfmCustomers, loadTopServices, loadCopilotSummary,
} from './queries/analytics';
import {
  loadEarningsEstimates, loadEarningsEstimate, loadClawbacks,
} from './queries/payouts';
import {
  loadBillingInvoices, loadTaxProfile,
} from './queries/billingInvoices';
import { createPairingSession, getPairingStatus, claimPairingSession } from './queries/pairing';
import { loadReviewsSummary } from './queries/reviews';
import { loadOrders } from './queries/orders';
import { loadFormKey, encryptAnswers } from './kiosk/crypto';
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
import { generateAndSaveBusinessSummary } from './businessSummary';
import { flushSms } from './sms/flush';
import { loadQueue } from './queries/queue';
import {
  loadDeskSettings, loadCheckoutSettings, load10DlcStatus, loadIntakeWaiver, loadWebhooks,
} from './queries/settings';
import {
  loadUserProfile, loadUserSessions, loadUserNotificationPreferences,
} from './queries/profile';
import {
  loadDeskNotifications, loadDeskNotificationStats,
} from './queries/notifications';


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
    if (path.startsWith('/v1/public/')) return;
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
    const t = req.headers[STAFF_TOKEN_HEADER];
    if (typeof t === 'string' && t.length > 0) return;
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

  // ── 个人档案与账号管理 (Profile & Sessions) ──────────────────────────────────
  async function userCtxFromHeaders(req: { user?: { userId: string }; headers: Record<string, unknown>; ip: string }) {
    const staffToken = req.headers[STAFF_TOKEN_HEADER];
    if (typeof staffToken === 'string' && staffToken) {
      return staffContextFromToken(staffToken, req.ip);
    }
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
    const userId = req.user.userId;
    const headerMembershipId = req.headers['x-membership-id'];
    let targetMembershipId: string | null = null;
    let fallbackOrgId = '00000000-0000-0000-0000-000000000000';
    let fallbackLocationId = '00000000-0000-0000-0000-000000000000';

    if (typeof headerMembershipId === 'string' && headerMembershipId) {
      targetMembershipId = headerMembershipId;
    } else {
      const list = await listMembershipsForUser(userId);
      if (list[0]) {
        targetMembershipId = list[0].membershipId;
        fallbackOrgId = list[0].orgId;
        fallbackLocationId = list[0].locationId;
      }
    }

    if (targetMembershipId) {
      return buildContext({ userId, membershipId: targetMembershipId, ip: req.ip });
    }

    const fallbackCtx: CommandContext = {
      orgId: fallbackOrgId,
      locationId: fallbackLocationId,
      userId,
      membershipId: null,
      permissions: new Set<Permission>(),
      actorKind: 'user',
      locale: 'zh-Hans',
      timezone: 'America/New_York',
      ...(req.ip ? { ip: req.ip } : {}),
    };
    return fallbackCtx;
  }


  app.get('/v1/me/profile', async (req) => {
    const ctx = await userCtxFromHeaders(req);
    return withTenant(ctx, (tx) => loadUserProfile(tx, ctx));
  });

  app.get('/v1/me/sessions', async (req) => {
    const ctx = await userCtxFromHeaders(req);
    return withTenant(ctx, async (tx) => {
      const sessions = await loadUserSessions(tx, ctx, req.ip);
      return { sessions };
    });
  });

  app.get('/v1/me/notification-preferences', async (req) => {
    const ctx = await userCtxFromHeaders(req);
    return withTenant(ctx, (tx) => loadUserNotificationPreferences(tx, ctx));
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
  };

  app.post<{ Params: { name: string } }>('/v1/commands/:name', handleCommand);
  app.post<{ Params: { name: string } }>('/api/commands/:name', handleCommand);

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
  const handleRotation = async (req: FastifyRequest<{ Querystring: { businessDate?: string; date?: string } }>) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('rotation.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'rotation.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const { date: todayDate, policy } = await currentBusinessDate(tx, ctx.locationId);
        const queryDate = req.query.date || req.query.businessDate || todayDate;
        const { participants, events } = await loadRotation(tx, ctx, queryDate);
        const st = computeStanding(participants, events, policy);

        const nameByMember = new Map(participants.map((p) => [p.membershipId, p.name]));

        return {
          businessDate: queryDate,
          todayDate,
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
            skills: e.skills || [],
            levelName: e.levelName || null,
            arrivedAt: e.arrivedAt,
            leftAt: e.leftAt,
            why: explain(e, policy),
            trail: e.trail.map((t) => ({
              at: t.at,
              reason: t.reason,
              turns: t.deltaBp / FULL_TURN,
              note: stripRank(t.note),
            })),
          })),
          fullEvents: events.map((ev) => ({
            id: ev.id,
            membershipId: ev.membershipId,
            staffName: nameByMember.get(ev.membershipId) || '技师',
            reason: ev.reason,
            deltaTurns: ev.deltaBp / FULL_TURN,
            at: ev.at,
            note: stripRank(ev.note),
            actorId: ev.actorId,
          })),
        };
      });
  };

  app.get<{ Querystring: { businessDate?: string; date?: string } }>('/v1/desk/rotation', handleRotation);
  app.get<{ Querystring: { businessDate?: string; date?: string } }>('/api/rotation/query', handleRotation);

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

  const handleCustomers = async (req: FastifyRequest<{ Querystring: {
    q?: string; query?: string; filterType?: any; vip?: string; sleeping?: string; limit?: string; offset?: string;
  } }>) => {
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
        ...(req.query.query ? { query: req.query.query } : {}),
        ...(req.query.q ? { q: req.query.q } : {}),
        ...(req.query.filterType ? { filterType: req.query.filterType } : {}),
        vipOnly: req.query.vip === '1',
        ...(int(req.query.sleeping) ? { sleepingDays: int(req.query.sleeping)! } : {}),
        ...(int(req.query.limit) ? { limit: int(req.query.limit)! } : {}),
        ...(int(req.query.offset) ? { offset: int(req.query.offset)! } : {}),
      }));
  };

  app.get('/v1/desk/customers', handleCustomers);
  app.get('/api/customers/list', handleCustomers);

  app.get<{ Querystring: { status?: string } }>('/v1/desk/tickets', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const filterStatus = req.query.status && req.query.status !== 'all'
      ? (req.query.status === 'paid' ? 'closed' : req.query.status)
      : null;

    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const [checkoutSettingsRow] = await tx<{
          sales_tax_rate_percent: string;
          tax_calculation_mode: string;
          suggested_tip_percentages: number[];
        }[]>`
          select sales_tax_rate_percent::text, tax_calculation_mode, suggested_tip_percentages
          from location_checkout_settings
          where location_id = ${ctx.locationId}`;

        const checkoutSettings = {
          salesTaxRatePercent: checkoutSettingsRow?.sales_tax_rate_percent ?? '8.8750',
          taxCalculationMode: (checkoutSettingsRow?.tax_calculation_mode ?? 'exclusive') as 'exclusive' | 'inclusive',
          suggestedTipPercentages: checkoutSettingsRow?.suggested_tip_percentages ?? [15, 18, 20, 25],
        };

        const rows = await tx<{
          ticket_id: string; appointment_id: string | null; status: string;
          customer_name: string | null; walk_in_name: string | null;
          group_id: string | null; group_label: string | null; business_date: string;
          subtotal_cents: number; discount_cents: number; tax_cents: number; total_cents: number;
          item_id: string; item_name: string; item_total: number;
          duration_min: number; started_at: string | null; finished_at: string | null;
          staff_name: unknown; membership_id: string;
        }[]>`
          select t.id as ticket_id, t.appointment_id, t.status,
                  c.display_name as customer_name, t.walk_in_name,
                  t.group_id, g.label as group_label,
                  t.business_date::text as business_date,
                  t.subtotal_cents, t.discount_cents, t.tax_cents, t.total_cents,
                  ti.id as item_id, ti.name_snapshot as item_name,
                  ti.total_cents as item_total, ti.duration_min,
                  ti.started_at::text as started_at, ti.finished_at::text as finished_at,
                  sp.display_name as staff_name, tis.membership_id
          from tickets t
          left join customers c on c.id = t.customer_id
          left join ticket_groups g on g.id = t.group_id
          join ticket_items ti on ti.ticket_id = t.id
          join ticket_item_staff tis on tis.ticket_item_id = ti.id
          left join staff_profiles sp on sp.membership_id = tis.membership_id
          where t.location_id = ${ctx.locationId}
            and (
              case
                when ${filterStatus}::text is not null then t.status = ${filterStatus}
                else t.status in ('open','in_service','ready_to_pay')
              end
            )
          order by t.business_date, t.opened_at, ti.seq`;

        const map = new Map<string, {
          ticketId: string; appointmentId: string | null; status: string; customerName: string;
          subtotalCents: number; discountCents: number; taxCents: number; totalCents: number;
          groupId: string | null; groupLabel: string | null;
          businessDate: string; daysAgo: number;
          items: Array<Record<string, unknown>>;
        }>();

        const today = await resolveDate(tx, ctx.locationId);
        const todayMs = Date.parse(`${today}T00:00:00Z`);
        const daysAgoOf = (d: string) =>
          Math.max(0, Math.round((todayMs - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));

        for (const r of rows) {
          const t = map.get(r.ticket_id) ?? {
            ticketId: r.ticket_id,
            appointmentId: r.appointment_id,
            status: r.status,
            customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
            subtotalCents: r.subtotal_cents,
            discountCents: r.discount_cents,
            taxCents: r.tax_cents,
            totalCents: r.total_cents,
            groupId: r.group_id, groupLabel: r.group_label,
            businessDate: r.business_date,
            daysAgo: daysAgoOf(r.business_date),
            items: [],
          };
          t.items.push({
            ticketItemId: r.item_id, name: r.item_name, totalCents: r.item_total,
            durationMin: r.duration_min, staffName: pickText(r.staff_name, ctx.locale),
            membershipId: r.membership_id, startedAt: r.started_at, finishedAt: r.finished_at,
          });
          map.set(r.ticket_id, t);
        }
        const tickets = [...map.values()];
        return {
          businessDate: today,
          tickets,
          checkoutSettings,
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

  // ── 系统设置与门店配置 (Settings Enhancement) ──────────────────────────────
  const handleDeskSettings = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('staff.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadDeskSettings(tx, ctx));
  };
  app.get('/v1/desk/settings', handleDeskSettings);
  app.get('/api/desk/settings', handleDeskSettings);

  const handleSaveLocation = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.saveProfile', req.body, ctx);
    return res.result;
  };
  app.patch<{ Body: Record<string, unknown> }>('/v1/desk/settings/location', handleSaveLocation);
  app.patch<{ Body: Record<string, unknown> }>('/api/desk/settings/location', handleSaveLocation);

  const handleSaveBusinessHours = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.saveHours', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/business-hours', handleSaveBusinessHours);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/business-hours', handleSaveBusinessHours);

  const handleGetCheckout = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadCheckoutSettings(tx, ctx));
  };
  app.get('/v1/desk/settings/checkout', handleGetCheckout);
  app.get('/api/desk/settings/checkout', handleGetCheckout);

  const handleSaveCheckout = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.saveCheckout', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/checkout', handleSaveCheckout);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/checkout', handleSaveCheckout);

  const handleSaveOnlineBooking = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.saveOnlineBooking', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/online-booking', handleSaveOnlineBooking);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/online-booking', handleSaveOnlineBooking);

  const handleSaveStaffProfile = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('staff.saveProfile', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/staff/profile', handleSaveStaffProfile);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/staff/profile', handleSaveStaffProfile);

  const handleSaveStaffRotation = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('staff.setRotation', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/staff/rotation', handleSaveStaffRotation);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/staff/rotation', handleSaveStaffRotation);

  const handleSavePhoneAssistant = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.savePhoneAssistant', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/phone-assistant', handleSavePhoneAssistant);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/phone-assistant', handleSavePhoneAssistant);

  const handleApply10Dlc = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.apply10dlc', req.body, ctx);
    return res.result;
  };
  app.post<{ Body: Record<string, unknown> }>('/v1/desk/settings/10dlc/apply', handleApply10Dlc);
  app.post<{ Body: Record<string, unknown> }>('/api/desk/settings/10dlc/apply', handleApply10Dlc);

  const handleGet10DlcStatus = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('staff.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => load10DlcStatus(tx, ctx));
  };
  app.get('/v1/desk/settings/10dlc/status', handleGet10DlcStatus);
  app.get('/api/desk/settings/10dlc/status', handleGet10DlcStatus);

  const handleSaveIntakeWaiver = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.saveIntakeWaiver', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/hardware/intake-waiver', handleSaveIntakeWaiver);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/hardware/intake-waiver', handleSaveIntakeWaiver);

  const handleGetIntakeWaiver = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadIntakeWaiver(tx, ctx));
  };
  app.get('/v1/desk/settings/hardware/intake-waiver', handleGetIntakeWaiver);
  app.get('/api/desk/settings/hardware/intake-waiver', handleGetIntakeWaiver);

  const handleSaveWebhooks = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.saveWebhooks', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/webhooks', handleSaveWebhooks);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/webhooks', handleSaveWebhooks);

  const handleGetWebhooks = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadWebhooks(tx, ctx));
  };
  app.get('/v1/desk/settings/webhooks', handleGetWebhooks);
  app.get('/api/desk/settings/webhooks', handleGetWebhooks);

  // ── 应用内通知中心 (Notification Center) ───────────────────────────────────
  const handleGetNotifications = async (req: FastifyRequest<{
    Querystring: { category?: string; unreadOnly?: boolean; searchQuery?: string; page?: number; pageSize?: number };
  }>) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(ctx, (tx) => loadDeskNotifications(tx, ctx, req.query));
  };
  app.get<{ Querystring: { category?: string; unreadOnly?: boolean; searchQuery?: string; page?: number; pageSize?: number } }>(
    '/v1/desk/notifications', handleGetNotifications,
  );
  app.get<{ Querystring: { category?: string; unreadOnly?: boolean; searchQuery?: string; page?: number; pageSize?: number } }>(
    '/api/desk/notifications', handleGetNotifications,
  );

  const handleGetNotificationStats = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(ctx, (tx) => loadDeskNotificationStats(tx, ctx));
  };
  app.get('/v1/desk/notifications/stats', handleGetNotificationStats);
  app.get('/api/desk/notifications/stats', handleGetNotificationStats);


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
  const handleDeskReport = async (
    req: FastifyRequest<{ Querystring: { from?: string; to?: string; format?: string } }>,
    reply: FastifyReply,
  ) => {
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
                  `attachment; filename="sales-report-${from}-to-${to}.csv"`)
          .send(reportToCsv(report));
      });
  };
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/v1/desk/reports', handleDeskReport);
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/v1/desk/report', handleDeskReport);

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

  app.get('/v1/desk/storefront/brief', async (req) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const [loc] = await tx<{ name: unknown; slogan: unknown }[]>`
          select name, settings->'storefront'->>'slogan' as slogan from locations where id = ${ctx.locationId}`;
        const [brief] = await tx<{
          id: string; status: string;
          voice: string | null; brand_primary: string | null; brand_accent: string | null;
          pain_points: string[]; pain_free_text: string | null;
          audience: string[]; top_questions: string[]; sections: string[];
          usp: string | null; tone: string | null; reference_sites: string[];
          current_site_url: string | null;
        }[]>`
          select id, status, voice, brand_primary, brand_accent,
                 pain_points, pain_free_text, audience, top_questions,
                 sections, usp, tone, reference_sites, current_site_url
          from storefront_briefs where location_id = ${ctx.locationId} order by updated_at desc limit 1`;
        return {
          shopName: pickText(loc?.name, ctx.locale, 'Lotus Nails & Spa'),
          slogan: (loc as any)?.slogan ?? '曼哈顿高端日式舒压与经络芳疗中心',
          brief: brief ? {
            id: brief.id,
            status: brief.status,
            voice: brief.voice,
            brandPrimary: brief.brand_primary,
            brandAccent: brief.brand_accent,
            painPoints: brief.pain_points,
            sections: brief.sections,
            usp: brief.usp,
            tone: brief.tone,
            currentSiteUrl: brief.current_site_url,
            referenceSites: brief.reference_sites,
          } : null,
        };
      }
    );
  });

  // ── 微店建站修改意见与批注流水 ──────────────────────────────────────────
  const storefrontRevisionsMap = new Map<string, Array<{ id: string; time: string; text: string; status: string }>>();

  app.get('/v1/desk/storefront/revisions', async (req) => {
    const ctx = await ctxFromHeaders(req);
    const revs = storefrontRevisionsMap.get(ctx.locationId) ?? [
      {
        id: "rev-1",
        time: "2026-08-25 14:30",
        text: "请将首页深层精油按摩的价格从 $85 更新为 $95，并加上『赠送 15min 热石体验』的角标。",
        status: "已修改采纳",
      },
      {
        id: "rev-2",
        time: "2026-08-26 10:15",
        text: "把技师团队展示里的 Lisa 师傅头像更换为 Drive 链接中的第一张高清肖像图。",
        status: "设计处理中",
      },
    ];
    return { revisions: revs };
  });

  app.post<{ Body: { text: string } }>('/v1/desk/storefront/revisions', async (req) => {
    const ctx = await ctxFromHeaders(req);
    const existing = storefrontRevisionsMap.get(ctx.locationId) ?? [
      {
        id: "rev-1",
        time: "2026-08-25 14:30",
        text: "请将首页深层精油按摩的价格从 $85 更新为 $95，并加上『赠送 15min 热石体验』的角标。",
        status: "已修改采纳",
      },
      {
        id: "rev-2",
        time: "2026-08-26 10:15",
        text: "把技师团队展示里的 Lisa 师傅头像更换为 Drive 链接中的第一张高清肖像图。",
        status: "设计处理中",
      },
    ];
    const newRev = {
      id: `rev-${Date.now()}`,
      time: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      text: req.body?.text || '新增页面修改需求',
      status: '已提交待处理',
    };
    const updated = [newRev, ...existing];
    storefrontRevisionsMap.set(ctx.locationId, updated);
    return { success: true, revision: newRev, revisions: updated };
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

  // ── 房间与工位实时看板 ─────────────────────────────────────────────────────
  app.get('/v1/desk/rooms', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(ctx, (tx) => loadRooms(tx, ctx));
  });

  // ── 预约详情（带客户健康表与单据明细）────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/appointments/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(ctx, (tx) => loadAppointmentDetail(tx, ctx, req.params.id));
  });

  // ── 营销中心：礼品卡 / 次卡套餐 / 优惠券 / 积分 ────────────────────────────
  const handleGiftCards = async (
    req: FastifyRequest<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>,
  ) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    return withTenant(ctx, (tx) => loadGiftCards(tx, ctx, {
      status: req.query.status,
      q: req.query.q,
      limit,
      offset,
    }));
  };
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>('/v1/desk/giftcards', handleGiftCards);
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>('/v1/desk/marketing/giftcards', handleGiftCards);
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>('/v1/desk/marketing/gift-cards', handleGiftCards);

  // 礼品卡即时余额预检接口（收银台使用）
  const handleGiftCardVerify = async (
    req: FastifyRequest<{ Querystring: { code?: string } }>,
  ) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view') && !ctx.permissions.has('ticket.write')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const code = req.query.code?.trim();
    if (!code) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_gift_card_code' } });
    }
    return withTenant(ctx, (tx) => loadGiftCardVerify(tx, ctx, code));
  };
  app.get<{ Querystring: { code?: string } }>('/v1/desk/giftcards/verify', handleGiftCardVerify);
  app.get<{ Querystring: { code?: string } }>('/v1/desk/gift-cards/verify', handleGiftCardVerify);

  const handlePackages = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
    }
    return withTenant(ctx, (tx) => loadPackages(tx, ctx));
  };
  app.get('/v1/desk/packages', handlePackages);
  app.get('/v1/desk/marketing/packages', handlePackages);
  app.get('/api/marketing/packages', handlePackages);

  const handleCoupons = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadCoupons(tx, ctx));
  };
  app.get('/v1/desk/coupons', handleCoupons);
  app.get('/v1/desk/marketing/coupons', handleCoupons);

  const handleLoyalty = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadLoyalty(tx, ctx));
  };
  app.get('/v1/desk/loyalty', handleLoyalty);
  app.get('/v1/desk/marketing/loyalty', handleLoyalty);

  const handleStaffList = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('staff.manage') && !ctx.permissions.has('rotation.read') && !ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'staff.manage' } });
    }
    return withTenant(ctx, (tx) => loadStaffDirectory(tx, ctx));
  };
  app.get('/v1/desk/staff/list', handleStaffList);
  app.get('/api/staff/list', handleStaffList);

  // ── 多维经营数据分析报表 ───────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/revenue-trends', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadRevenueTrends(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/customers', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadCustomerAnalytics(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/staff', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('payroll.view_all') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadStaffAnalytics(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/heatmap', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadHeatmap(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/rfm-customers', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -90);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadRfmCustomers(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/top-services', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadTopServices(tx, ctx, from, to));
    }
  );

  app.get(
    '/v1/desk/analytics/copilot-summary', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      return withTenant(ctx, (tx) => loadCopilotSummary(tx, ctx));
    }
  );

  app.post(
    '/v1/desk/analytics/copilot-summary/generate', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
      }
      return generateAndSaveBusinessSummary(ctx, apiKey);
    }
  );

  // ── 收入估算与记账（不代收、不打款、不执行工资支付）────────────────────────
  app.get(
    '/v1/desk/earnings/estimates', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('payroll.view_all') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.view_all' } });
      }
      return withTenant(ctx, (tx) => loadEarningsEstimates(tx, ctx));
    }
  );

  app.get<{ Params: { membershipId: string } }>(
    '/v1/desk/earnings/estimates/:membershipId', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('payroll.view_all') && ctx.membershipId !== req.params.membershipId) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.view_all' } });
      }
      return withTenant(ctx, (tx) => loadEarningsEstimate(tx, ctx, req.params.membershipId));
    }
  );

  app.get(
    '/v1/desk/payouts/clawbacks', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view') && !ctx.permissions.has('payroll.view_all')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      return withTenant(ctx, (tx) => loadClawbacks(tx, ctx));
    }
  );

  // ── SaaS 订阅与算力资源中心 ────────────────────────────────────────────────
  app.post<{ Body: { targetPlan: 'starter' | 'growth' | 'enterprise' | 'essential'; billingCycle?: 'monthly' | 'annual' } }>(
    '/v1/desk/billing/change-plan', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const res = await dispatch('billing.changePlan', req.body, ctx);
      return res.result;
    }
  );

  app.post<{ Body: { addonType: 'voice_minutes_100' | 'copilot_credits_500' | 'marketing_sms_1000'; priceCents: number } }>(
    '/v1/desk/billing/buy-addon', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const res = await dispatch('billing.buyAddon', req.body, ctx);
      return res.result;
    }
  );

  app.get(
    '/v1/desk/billing/invoices', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('billing.manage') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
      }
      return withTenant(ctx, (tx) => loadBillingInvoices(tx, ctx));
    }
  );

  app.put<{ Body: { legalEntityName: string; taxId: string; billingEmail: string } }>(
    '/v1/desk/billing/tax-profile', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const res = await dispatch('billing.saveTaxProfile', req.body, ctx);
      return res.result;
    }
  );

  app.get(
    '/v1/desk/billing/tax-profile', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('billing.manage') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
      }
      return withTenant(ctx, (tx) => loadTaxProfile(tx, ctx));
    }
  );

  // ── 硬件终端配对 ───────────────────────────────────────────────────────────
  app.post<{ Body?: { terminalType?: 'customer-facing' | 'kiosk' } }>(
    '/v1/desk/pairing/session', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('settings.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
      }
      return withTenant(ctx, (tx) => createPairingSession(tx, ctx, req.body?.terminalType));
    }
  );

  app.get<{ Params: { code: string } }>(
    '/v1/desk/pairing/session/:code/status', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('settings.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
      }
      return withTenant(ctx, (tx) => getPairingStatus(tx, ctx, req.params.code));
    }
  );

  app.post<{ Body?: { code?: string; label?: string } }>(
    '/v1/public/pairing/claim', async (req) => {
      const code = req.body?.code?.trim();
      if (!code) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'missing_pairing_code' },
        });
      }
      return claimPairingSession(code, req.body?.label);
    }
  );

  // ── 口碑聚合与 AI Review 总结 ─────────────────────────────────────────────
  const handleReviewsSummary = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('report.view') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
    }
    return withTenant(ctx, (tx) => loadReviewsSummary(tx, ctx));
  };
  app.get('/v1/desk/reviews/summary', handleReviewsSummary);
  app.get('/v1/desk/analytics/reviews-summary', handleReviewsSummary);

  // ── 预约健康表多版本历史 ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/appointments/:id/forms', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(ctx, (tx) => loadAppointmentForms(tx, ctx, req.params.id));
  });

  // ── 健康免责声明重填与版本追加 ─────────────────────────────────────────────
  app.post<{
    Body: {
      templateId: string;
      customerId?: string;
      appointmentId?: string;
      answers: Record<string, unknown>;
      signerName?: string;
      signerRelation?: string;
      signatureUrl?: string;
    };
  }>('/v1/desk/forms/re-submit', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.write') && !ctx.permissions.has('customer.write')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.write' } });
    }
    const { templateId, customerId, appointmentId, answers, signerName, signerRelation, signatureUrl } = req.body;
    if (!templateId || !answers) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_template_or_answers' } });
    }

    return withTenant(ctx, async (tx) => {
      const key = loadFormKey(process.env['FORM_ENCRYPTION_KEY']);
      const encrypted = encryptAnswers(answers, key);

      const [prev] = await tx<{ id: string; version: number }[]>`
        select id, version from form_submissions
        where location_id = ${ctx.locationId}
          and template_id = ${templateId}
          and (${customerId ?? null}::uuid is null or customer_id = ${customerId ?? null})
          and (${appointmentId ?? null}::uuid is null or appointment_id = ${appointmentId ?? null})
          and is_latest = true
        order by version desc limit 1`;

      const nextVersion = (prev?.version ?? 0) + 1;

      const [ins] = await tx<{ id: string }[]>`
        insert into form_submissions (
          org_id, location_id, customer_id, appointment_id, template_id, template_version,
          version, is_latest, answers_encrypted, enc_alg, signature_url, signed_at,
          signer_name, signer_relation, source, on_behalf_by
        ) values (
          ${ctx.orgId}, ${ctx.locationId}, ${customerId ?? null}, ${appointmentId ?? null},
          ${templateId}, 1, ${nextVersion}, true, ${encrypted}, 'aes-256-gcm.v1',
          ${signatureUrl ?? null}, now(), ${signerName ?? null}, ${signerRelation ?? 'self'},
          'desk', ${ctx.membershipId}
        ) returning id`;

      if (prev) {
        await tx`
          update form_submissions
          set is_latest = false, superseded_by = ${ins!.id}
          where id = ${prev.id}`;
      }

      return {
        submissionId: ins!.id,
        version: nextVersion,
        isLatest: true,
      };
    });
  });

  // ── 全量订单多维筛选与分页 ─────────────────────────────────────────────────
  app.get<{
    Querystring: {
      status?: string;
      from?: string;
      to?: string;
      staffId?: string;
      paymentMethod?: string;
      minAmount?: string;
      maxAmount?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
  }>('/v1/desk/orders', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const minAmount = req.query.minAmount ? Number(req.query.minAmount) : undefined;
    const maxAmount = req.query.maxAmount ? Number(req.query.maxAmount) : undefined;

    return withTenant(ctx, (tx) => loadOrders(tx, ctx, {
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      staffId: req.query.staffId,
      paymentMethod: req.query.paymentMethod,
      minAmount,
      maxAmount,
      q: req.query.q,
      limit,
      offset,
    }));
  });

  // ── 电子小票快捷补发 ───────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body?: { channel?: 'sms' | 'email'; destination?: string };
  }>('/v1/desk/tickets/:id/send-receipt', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.write')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.write' } });
    }
    return dispatch(
      'ticket.sendReceipt',
      {
        ticketId: req.params.id,
        channel: req.body?.channel ?? 'sms',
        destination: req.body?.destination,
      },
      ctx,
    );
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



/** 今天（UTC 日期）。跨店汇总的默认区间用它兜底，各店的营业日在查询里各算各的 */
function todayIso(): string { return new Date().toISOString().slice(0, 10); }

/** `YYYY-MM-DD` ± n 天。纯日期算术，不碰时区 */
function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
