/**
 * Stripe 的入口：一条 webhook + 四条老板端编排路由
 *
 * ## 这个文件为什么存在（而不是全做成命令）
 *
 * 命令跑在数据库事务里（bus.ts）。调 Stripe 是几百毫秒到几秒的外部 IO，
 * 塞进事务等于让一个连接和一个快照被占住那么久 —— 和
 * `POST /v1/blueprint/:id/extract` 躲开的是同一个坑。
 *
 * 所以：**这里只做编排（校验 → 调 Stripe → 把结果交给命令）**，
 * 每一次余额变动、每一次订阅状态变化仍然是一条有审计、有幂等、有 RLS
 * 的命令。宪法第 1 条守的是「写操作必须是命令」，守住了。
 *
 * ## webhook 那条和别的路由的根本区别
 *
 * 它**没有登录用户** —— 没有 Bearer token、没有 X-Membership-Id。
 * 身份证明只有一个 HMAC 签名，所以第一件事永远是验签（verify.ts）。
 * 定位门店靠 Stripe metadata 里的 `gf_location_id`，那是我们自己在
 * 创建对象时写进去的，不是客户端能塞的东西。
 *
 * ## 绝不碰卡号
 *
 * 绑卡走 **Stripe 托管的 Checkout（setup 模式）**：卡号只在 Stripe 的
 * 页面上输入，我们这边从头到尾只见得到一个 `pm_…` 和一句
 * 「Visa ···· 4242」。碰一下 PCI 范围，合规成本就是另一个量级。
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES,
  type CommandContext, type Permission,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import {
  unitsPerTopup, TOPUP_PRICE_CENTS, isQuotaUnit, TRIAL_DAYS, type QuotaUnit,
} from '@gf/payroll';
import { dispatch } from '../bus';
import { rawBodyOf } from '../rawBody';
import { verifyStripeSignature, STRIPE_SIGNATURE_HEADER } from './verify';
import {
  stripeClient, priceIdFor, planForPriceId, mapSubscriptionStatus,
  paymentMethodLabel, declineReason, isPlan, type Stripe,
} from './client';
import { maybeAutoTopup } from '../billing/autoTopup';
import { renderTrialEnding, formatWhen } from '../email/render';
import {
  isSignupSession, provisionFromSession, backfillStripeMetadata, sendActivationOnce,
  type SignupOutcome,
} from '../signup/webhook';
import '../handlers/billing';

/**
 * webhook 这个 actor 的全部权限 —— **只有一条**。
 *
 * 和 AI 电话那条（telnyx/routes.ts）同一个判断标准：
 * 「伪造了签名的人能干什么？」这里的答案是「只能改这家店的计费状态」，
 * 改不了预约、看不到客人、开不了单。
 */
const STRIPE_WEBHOOK_PERMISSIONS: readonly Permission[] = ['billing.manage'];

interface Tenant { orgId: string; locationId: string }

/**
 * 组一个系统上下文。
 *
 * `membershipId: null` —— webhook 背后**没有人**。硬塞一个真实 membership
 * 会让审计流水指向某位前台，而她什么都没做过。
 */
function systemContext(t: Tenant): CommandContext {
  return {
    orgId: t.orgId,
    locationId: t.locationId,
    userId: '00000000-0000-4000-8000-000000000000',
    membershipId: null,
    permissions: new Set(STRIPE_WEBHOOK_PERMISSIONS),
    actorKind: 'api',
    locale: 'en',
    timezone: 'UTC',
  };
}

/**
 * 从请求头解析租户上下文。由 server.ts 传进来 —— 那一份是唯一实现，
 * 复制一遍到这里的话，「membershipId 要验归属」这条迟早会有一处漏掉。
 */
export type CtxFromHeaders = (req: {
  user?: { userId: string }; headers: Record<string, unknown>; ip: string;
}) => Promise<CommandContext>;

export function registerStripeRoutes(
  app: FastifyInstance,
  ctxFromHeaders: CtxFromHeaders,
): void {

  /** 老板端三条路由共用的守门：要 `billing.manage`，而且只有老板有 */
  async function ownerCtx(req: Parameters<CtxFromHeaders>[0]): Promise<CommandContext> {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('billing.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
    }
    return ctx;
  }

  /**
   * 这家店订阅过没有 —— 决定这次 Checkout 给不给七天试用。
   *
   * 两列都为空才算「从来没有过」。只看 `stripe_subscription_id` 不够：
   * 退订之后那一列会被清空，而 `trial_ends_at` 留着历史值 ——
   * 那正是「这家伙已经用过一次试用」的证据。
   */
  async function everSubscribed(ctx: CommandContext): Promise<boolean> {
    const [acct] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ sub: string | null; trial: Date | null }[]>`
        select stripe_subscription_id as sub, trial_ends_at as trial
        from billing_accounts where location_id = ${ctx.locationId}`);
    return Boolean(acct?.sub) || Boolean(acct?.trial);
  }

  /**
   * 拿这家店的 Stripe 客户 id，没有就建一个。
   *
   * metadata 里写死 `gf_location_id` / `gf_org_id` —— **webhook 全靠它定位门店**。
   * 不写的话，一条 `customer.subscription.updated` 回来我们不知道该改哪家店的账，
   * 而这种事只会在上线之后、有第二家店的时候才暴露出来。
   */
  async function ensureCustomer(ctx: CommandContext): Promise<string> {
    const [acct] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ stripe_customer_id: string | null }[]>`
        select stripe_customer_id from billing_accounts
        where location_id = ${ctx.locationId}`);
    if (acct?.stripe_customer_id) return acct.stripe_customer_id;

    const [loc] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ name: unknown }[]>`
        select name from locations where id = ${ctx.locationId}`);
    const nameObj = (loc?.name ?? {}) as Record<string, string>;

    const customer = await stripeClient().customers.create({
      name: nameObj['en'] ?? nameObj['zh-Hans'] ?? Object.values(nameObj)[0] ?? 'GenieFront 门店',
      metadata: { gf_location_id: ctx.locationId, gf_org_id: ctx.orgId },
    });

    // 立刻落库：建完客户就崩掉的话，下次会再建一个 ——
    // 而 Stripe 上两个同名客户各挂一半数据，是最难收拾的一种脏
    await dispatch('billing.syncSubscription', { stripeCustomerId: customer.id }, ctx);
    return customer.id;
  }

  // ── 订阅：托管 Checkout ───────────────────────────────────────────────────
  //
  // 用托管页而不是自己收卡：卡号从头到尾不经过我们的服务器。
  // 老板在 Stripe 的页面上付完，回到 successUrl，剩下的靠 webhook 落库 ——
  // **不靠 successUrl 落库**，因为那个回跳客户端可以自己伪造。
  app.post<{ Body: { plan?: string; successUrl?: string; cancelUrl?: string } }>(
    '/v1/billing/checkout', async (req) => {
    const ctx = await ownerCtx(req);
    const plan = req.body?.plan;
    if (!isPlan(plan)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '套餐只能是 essential 或 growth', got: plan },
      });
    }
    const { successUrl, cancelUrl } = safeReturnUrls(req.body);

    /**
     * ⭐ 试用只给**第一次订阅**的店。
     *
     * 判据是「这家店的账户上有没有过 subscription id」，不是
     * 「现在是不是 active」—— 退订过又回来的老客户 `stripe_subscription_id`
     * 会被清空，但 `trial_ends_at` 还留着历史值，那才是真正的判据。
     * 两个都为空才算真的没订阅过。
     */
    const hadSubscription = await everSubscribed(ctx);

    const customerId = await ensureCustomer(ctx);
    const session = await stripeClient().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceIdFor(plan), quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // ⭐ 两处都写：session 上的给 checkout.session.completed 用，
      // subscription_data 上的给后续每一条 customer.subscription.* 用。
      // 只写一处的话，续订那些事件回来时是「查无此店」
      metadata: { gf_location_id: ctx.locationId, gf_org_id: ctx.orgId, gf_plan: plan },
      subscription_data: {
        /**
         * ⭐ 七天免费试用（批 1）。**卡照绑，只是七天内不扣。**
         *
         * 自己做「无付款租户」那条路要改建租户的幂等键、要做转正、
         * 要做到期降级 —— 而 Stripe 这一个参数把三件事全做了，
         * 我们只负责把状态镜像回来。
         *
         * ⚠️ 只在**这家店从来没订阅过**的时候给。改套餐（Switch Plan）
         * 也走这条路，不挡住的话老板每次换档都白拿七天。
         * Stripe 不替我们判这个 —— `trial_period_days` 给了就生效。
         */
        ...(hadSubscription ? {} : { trial_period_days: TRIAL_DAYS }),
        metadata: { gf_location_id: ctx.locationId, gf_org_id: ctx.orgId },
      },
    });

    return { url: session.url, sessionId: session.id };
  });

  /**
   * ── 第二家店：往同一张订阅上加一个 item（批 4）────────────────────────
   *
   * ⭐ **不是新建一个 subscription。** 一个老板一张卡、一张账单、
   * 一个计费周期 —— 三家店三个订阅的话，他会收到三封账单、换卡要换三次，
   * 而 Stripe 后台上看不出这三家是一个人的。多店折扣就是这个 item
   * 用一个不同的 price id。
   *
   * ⚠️ **顺序是「先建店，后计费」。** 反过来的话，Stripe 加完 item
   * 而建店失败 = 扣了钱没有店，那是投诉；现在这个顺序失败的结果是
   * 「一家能用但还没计费的店」，补一次就行。
   *
   * ⚠️ 加 item 会产生**按比例计费的中期账单**。金额在返回里给出来，
   * 前端必须在确认页上显示 —— 不能让老板事后在信用卡账单上发现。
   */
  app.post<{ Body: {
    name?: string; timezone?: string; businessType?: string;
    locale?: string; plan?: string;
  } }>('/v1/billing/add-store', async (req) => {
    const ctx = await ownerCtx(req);
    const plan = req.body?.plan ?? 'essential';
    if (!isPlan(plan)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '套餐只能是 essential 或 growth', got: plan },
      });
    }

    // ① 建店（命令：有审计、有幂等、有 RLS）
    const created = await dispatch<{
      locationId: string; orgId: string; membershipId: string; slug: string;
    }>('location.create', {
      name: req.body?.name,
      timezone: req.body?.timezone,
      businessType: req.body?.businessType ?? 'nail',
      ...(req.body?.locale ? { locale: req.body.locale } : {}),
    }, ctx, { idempotencyKey: `add-store-${req.body?.name}-${req.body?.timezone}` });

    const newLoc = created.result.locationId;

    // ② 找到这个 org 现有的订阅。没有就说清楚 —— 第一家店都还没订阅，
    //    第二家店的计费无处可加
    const [existing] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ sub: string | null; cust: string | null }[]>`
        select stripe_subscription_id as sub, stripe_customer_id as cust
        from billing_accounts
        where org_id = ${ctx.orgId} and stripe_subscription_id is not null
        limit 1`);

    if (!existing?.sub) {
      return {
        ...created.result,
        billing: 'not_linked',
        note: '门店已建好，但这个组织还没有生效的订阅 —— 先给第一家店订阅，再回来加计费。',
      };
    }

    // ③ 往那条订阅上加一个 item
    // ⚠️ idempotencyKey 用新门店 id：同一个 location 重试不会建出第二个 item
    const item = await stripeClient().subscriptionItems.create({
      subscription: existing.sub,
      price: priceIdFor(plan),
      quantity: 1,
      // ⚠️ metadata 必须带 —— 后续每一条 subscription.updated 靠它定位门店
      metadata: { gf_location_id: newLoc, gf_org_id: ctx.orgId },
      proration_behavior: 'create_prorations',
    }, { idempotencyKey: `add-store-item-${newLoc}` });


    // ④ 把订阅信息落到新店的账户上。**同一个 subscription id** ——
    //    续期、欠费、取消这些事件对两家店同时生效，本来就该是同一条
    const newCtx: CommandContext = { ...ctx, locationId: newLoc, membershipId: null };
    await dispatch('billing.syncSubscription', {
      stripeCustomerId: existing.cust,
      stripeSubscriptionId: existing.sub,
      plan,
      subscriptionStatus: 'active',
    }, newCtx);

    await withTenant(
      { orgId: ctx.orgId, locationId: newLoc, membershipId: null },
      (tx) => tx`
        insert into location_subscriptions
          (org_id, location_id, plan, status, stripe_subscription_item_id)
        values (${ctx.orgId}, ${newLoc}, ${plan}, 'active', ${item.id})
        on conflict do nothing`);

    /*
     * ⑤ 这次会当场扣多少。
     *
     * 拿 upcoming invoice 而不是自己按天算 —— 自己算一定会和 Stripe
     * 差几分钱（他们按秒摊、还要算税），而老板对不上那几分钱时
     * 会怀疑的是我们整套账。
     */
    let prorationCents: number | null = null;
    try {
      const upcoming = await stripeClient().invoices.createPreview({
        subscription: existing.sub,
      });
      prorationCents = upcoming.amount_due;
    } catch (e) {
      req.log.warn({ err: e }, 'add-store: 预览账单失败，前端就别显示金额了');
    }

    return {
      ...created.result,
      billing: 'linked',
      subscriptionItemId: item.id,
      plan,
      /** ⚠️ null = 没取到，前端要显示「以账单为准」而不是显示 $0 */
      prorationCents,
    };
  });

  // ── 绑卡：Checkout 的 setup 模式（底下就是一个 SetupIntent）─────────────
  //
  // 自己做 SetupIntent + Elements 也可以，但那要在前端引 Stripe.js、
  // 处理 3DS 弹窗、自己做卡片输入框的可访问性 —— 而托管页把这三件事
  // 全免了，代价只是跳出去一趟。对一个「四十岁以上、戴着手套」的
  // 用户群（宪法第 11 条），托管页那张大表单反而更好用。
  app.post<{ Body: { successUrl?: string; cancelUrl?: string } }>(
    '/v1/billing/payment-method', async (req) => {
    const ctx = await ownerCtx(req);
    const { successUrl, cancelUrl } = safeReturnUrls(req.body);
    const customerId = await ensureCustomer(ctx);

    const session = await stripeClient().checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      // ⚠️ setup 模式**必须**给 currency，否则 Stripe 直接 400
      // （`parameter_missing: currency`）。订阅模式不用，因为币种从 price 上带过来 ——
      // 就是这个不对称让它很容易被漏掉，而漏掉了只有真调一次才发现
      currency: 'usd',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { gf_location_id: ctx.locationId, gf_org_id: ctx.orgId },
    });

    return { url: session.url, sessionId: session.id };
  });

  // ── 创建 Customer Portal Session（Stripe 托管门户）─────────────────────────
  app.post<{ Body: { returnUrl?: string } }>('/v1/billing/portal-session', async (req) => {
    const ctx = await ownerCtx(req);
    const [acct] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ stripe_customer_id: string | null }[]>`
        select stripe_customer_id from billing_accounts
        where location_id = ${ctx.locationId}`);

    if (!acct?.stripe_customer_id) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { reason: 'stripe_customer_not_found' },
      });
    }

    const returnUrl = req.body?.returnUrl || 'https://desk.geniefront.app/subscription';
    try {
      const session = await stripeClient().billingPortal.sessions.create({
        customer: acct.stripe_customer_id,
        return_url: returnUrl,
      });
      return { url: session.url };
    } catch (e) {
      req.log.warn({ err: e }, 'portal-session: 创建 Stripe 门户会话失败');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'stripe', reason: declineReason(e) },
      });
    }
  });

  // ── 手动充值 ─────────────────────────────────────────────────────────────
  //
  // 老板自己点的那一次，固定 $50，买**一种**额度（积分 或 语音分钟）。
  //
  // ⚠️ **两种额度不能互换**（决策 8）。所以这里收的是 `unit` 而不是金额 ——
  // 界面上是两个按钮，不是一个金额输入框。
  //
  // 用已绑的卡 off-session 扣：他人就在浏览器前面，但走 off_session 是有意的 ——
  // 这条路和自动续充**用同一段扣款逻辑**，两条路差异越小，
  //「手动能充自动充不上」这种问题就越少。
  app.post<{ Body: { unit?: string } }>('/v1/billing/topup', async (req) => {
    const ctx = await ownerCtx(req);
    const unit = req.body?.unit;
    if (!isQuotaUnit(unit)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '要说明充哪一种额度', allowed: ['credit', 'voice_minute'], got: unit },
      });
    }
    const units = unitsPerTopup(unit);

    const [acct] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ stripe_customer_id: string | null; default_payment_method_id: string | null }[]>`
        select stripe_customer_id, default_payment_method_id from billing_accounts
        where location_id = ${ctx.locationId}`);

    if (!acct?.stripe_customer_id || !acct.default_payment_method_id) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'no_payment_method' },
      });
    }

    let paymentIntentId: string;
    // 手动充值的幂等键：location + unit + 当前时间戳毫秒。
    // 每次充值是独立操作（区别于 add-store 用固定 locationId），
    // 所以用时间戳保证不同次充值不会互相命中 Stripe 的幂等缓存。
    // Stripe 的 idempotency_key 在 24h 后自动失效，不会永久占位。
    const topupIdempotencyKey = `topup-${ctx.locationId}-${unit}-${Date.now()}`;
    try {
      const pi = await stripeClient().paymentIntents.create({
        amount: TOPUP_PRICE_CENTS,
        currency: 'usd',
        customer: acct.stripe_customer_id,
        payment_method: acct.default_payment_method_id,
        off_session: true,
        confirm: true,
        description: unit === 'credit'
          ? `GenieFront ${units} AI 积分` : `GenieFront ${units} AI 语音分钟`,
        metadata: {
          gf_location_id: ctx.locationId, gf_org_id: ctx.orgId, gf_kind: 'topup',
          // ⚠️ 单位和数量必须写进 metadata：webhook 那条路只拿得到这个对象
          gf_unit: unit, gf_units: String(units),
        },
      }, { idempotencyKey: topupIdempotencyKey });
      paymentIntentId = pi.id;
      if (pi.status !== 'succeeded') {
        // 还要 3DS 之类的后续动作。**不当成功** —— 记了账额度可能白送。
        // 等 payment_intent.succeeded webhook 来入账
        return { ok: false, pending: true, status: pi.status };
      }
    } catch (e) {
      req.log.warn({ err: e, locationId: ctx.locationId, unit }, 'manual topup declined');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'stripe', reason: declineReason(e) },
      });
    }

    const out = await dispatch<{ balanceAfter: number; alreadyRecorded: boolean }>(
      'billing.recordTopup',
      {
        unit, units, paidCents: TOPUP_PRICE_CENTS,
        stripePaymentIntentId: paymentIntentId, trigger: 'manual',
      },
      ctx,
      { idempotencyKey: `topup-${paymentIntentId}` },
    );

    return { ok: true, unit, units, balanceAfter: out.result.balanceAfter };
  });

  // ── webhook ──────────────────────────────────────────────────────────────
  //
  // ⚠️ 顺序不能反：**先验签，再解析 body**。验的是原始字节
  // （registerRawBodyParser 把 /v1/stripe/ 前缀的请求体留成了原文）。
  app.post('/v1/stripe/webhook', async (req) => {
    const secret = process.env['STRIPE_WEBHOOK_SECRET'];
    if (!secret) {
      // 没配密钥就等于这道门没关。宁可整条路不可用，也不能放行 ——
      // 伪造一条充值 webhook 就能给任意账户凭空加钱
      req.log.error('STRIPE_WEBHOOK_SECRET 未配置，计费 webhook 不可用');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { reason: 'STRIPE_WEBHOOK_SECRET 未配置' },
      });
    }

    const raw = rawBodyOf(req);
    verifyStripeSignature({
      rawBody: raw,
      signatureHeader: req.headers[STRIPE_SIGNATURE_HEADER] as string | undefined,
      webhookSecret: secret,
    });

    let event: Stripe.Event;
    try {
      event = JSON.parse(raw) as Stripe.Event;
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'body 不是合法 JSON' },
      });
    }

    /**
     * ⭐ 开户（docs/12 §3 A）：**这是唯一一条「事件到达时门店还不存在」的路。**
     *
     * 别的事件都靠 `gf_location_id` 定位门店 —— 那是我们自己写进 Stripe
     * 对象里的。而新客还没有门店，官网也不可能知道一个还不存在的 id，
     * 所以这里的顺序是反的：**先建店，再把 id 回写到 Stripe 上**，
     * 让后续每一条事件（续费、退订、扣款失败）都认得出这家店。
     *
     * 建完之后就汇入主流程 —— 去重、syncSubscription 一步不少。
     */
    let signup: SignupOutcome | null = null;
    if (event.type === 'checkout.session.completed' && isSignupSession(event.data.object)) {
      const session = event.data.object;
      signup = await provisionFromSession(session, req.log);
      if (!signup) {
        // 邮箱不一致 → 拒绝，一行都不写。照常 200：重投一百次答案也一样
        return { ok: true, rejected: 'owner_email_mismatch' };
      }
      await backfillStripeMetadata(session, signup, req.log);
    }

    const t = signup
      ? { orgId: signup.orgId, locationId: signup.locationId }
      : tenantFromEvent(event);
    if (!t) {
      // 认不出门店就照常 200。返回 4xx 的话 Stripe 会一直重投 ——
      // 而一条我们本来就处理不了的事件，重投一百次还是处理不了
      req.log.info({ type: event.type, id: event.id }, 'stripe event without gf metadata');
      return { ok: true, ignored: 'no_tenant_metadata' };
    }
    const ctx = systemContext(t);

    /**
     * ⭐ 幂等靠 `stripe_events`：event id 是主键，插入冲突就说明处理过了。
     *
     * Stripe 明确说了 webhook 是「至少一次」投递。不去重的话，
     * 一次 `payment_intent.succeeded` 会给客户充值两次 ——
     * 这次是我们亏钱，反过来（扣费重复）就是多收客户的钱。
     * 两个方向都不能接受。
     *
     * ⚠️ `status='failed'` 的行允许被重试（ON CONFLICT DO UPDATE WHERE status='failed'）：
     * 处理失败的事件不删行，而是标记 failed；Stripe 重投时这里重新「认领」，
     * 让它再走一次 handleEvent。
     */
    const claimed = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        insert into stripe_events (id, type, location_id, status)
        values (${event.id}, ${event.type}, ${t.locationId}, 'processing')
        on conflict (id) do update
          set status = 'processing', error = null, processed_at = null
          where stripe_events.status = 'failed'
        returning id`);

    if (claimed.length === 0) {
      return { ok: true, duplicate: true };
    }

    try {
      const handled = await handleEvent(event, ctx);

      /**
       * ⚠️ 激活信在**这里**发，不在建店那一步：
       * 事务已经提交、订阅状态也落库了，这一刻门店确实是可用的。
       * 反过来先发信的话，老板可能点进来看到一家还没接上订阅的店。
       */
      if (signup) {
        const email = (event.data.object as Stripe.Checkout.Session)
          .metadata?.['gf_owner_email'] ?? '';
        if (email) await sendActivationOnce(signup, email, req.log);
      }

      // 成功：标记为 processed，供监控 / 后台审计查阅
      await withTenant(
        { orgId: t.orgId, locationId: t.locationId, membershipId: null },
        (tx) => tx`
          update stripe_events
          set status = 'processed', processed_at = now()
          where id = ${event.id}`).catch(() => {});

      return { ok: true, handled };
    } catch (e) {
      /**
       * 处理失败：把错误写回行、标记 status='failed'，**不删行**。
       *
       * ⚠️ 原来的做法是 update error → delete → 抛出让 Stripe 重投。
       * delete 会把刚写的 error 字段一并抹掉，失去了唯一的排查线索。
       *
       * 现在：写 failed + error → 抛出让 Stripe 重投。
       * Stripe 重投时上面的 ON CONFLICT DO UPDATE WHERE status='failed' 会重新认领这条事件。
       */
      await withTenant(
        { orgId: t.orgId, locationId: t.locationId, membershipId: null },
        (tx) => tx`
          update stripe_events
          set status = 'failed',
              error = ${e instanceof Error ? e.message.slice(0, 500) : 'unknown'}
          where id = ${event.id}`).catch(() => {});
      throw e;
    }
  });


  /**
   * 一条事件怎么落库。
   *
   * 只认我们真的要用的那几类，其余照常 200 —— 不然 Stripe 会认为
   * 投递失败并一直重试（和 Telnyx 那条 webhook 同一个道理）。
   */
  async function handleEvent(event: Stripe.Event, ctx: CommandContext): Promise<string> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'setup') {
          await savePaymentMethodFromSetup(session, ctx);
          return 'payment_method_saved';
        }
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripeClient().subscriptions.retrieve(
            typeof session.subscription === 'string'
              ? session.subscription : session.subscription.id);
          await syncSubscription(sub, ctx, event.id);
          return 'subscription_synced';
        }
        return 'ignored_mode';
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(event.data.object, ctx, event.id);
        return 'subscription_synced';
      }

      /**
       * ⭐ 试用还有 3 天到期（批 1）。Stripe 自己在到期前 3 天发这一条。
       *
       * **不自己数日子**：我们只要收到它就发信。自己起一个定时任务去扫
       * `trial_ends_at` 的话，那个任务和 Stripe 的账单周期迟早漂开，
       * 而漂开的后果是「信发了但没扣款」或者「扣了款但信没发」。
       */
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        // 先把最新状态同步下来，免得信里写的到期时间是旧的
        await syncSubscription(sub, ctx, event.id);
        const sent = await sendTrialEndingOnce(ctx, sub);
        return sent ? 'trial_ending_notified' : 'trial_ending_already_notified';
      }

      /**
       * 扣款失败。**不在这里停服** —— 订阅状态会由 Stripe 随后的
       * `customer.subscription.updated` 带成 `past_due`，冻结由那条统一处理。
       *
       * 这里只做一件事：留一条能查的记录。老板打电话来问
       * 「我的卡怎么被拒了」，客服要答得出是哪一天、哪张卡、什么原因。
       */
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        app.log.warn({
          locationId: ctx.locationId,
          invoiceId: inv.id,
          attempt: inv.attempt_count,
          amountDue: inv.amount_due,
          nextAttempt: inv.next_payment_attempt,
        }, 'subscription invoice payment failed');
        return 'invoice_failure_logged';
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const kind = pi.metadata?.['gf_kind'];
        // 订阅的发票扣款也会发这个事件 —— 那笔钱不该进额度账本，
        // 它是月费不是充值。只认我们自己打了标记的那两种
        if (kind !== 'topup' && kind !== 'auto_topup') return 'ignored_kind';

        const unit = pi.metadata?.['gf_unit'];
        const units = Number(pi.metadata?.['gf_units'] ?? 0);
        // ⚠️ 认不出单位就**不入账**。猜一个的话会给错额度 ——
        // 客户买了分钟却拿到积分，而两者不能互换，只能人工冲账
        if (!isQuotaUnit(unit) || !Number.isInteger(units) || units <= 0) {
          app.log.warn({ pi: pi.id, unit, units }, 'topup without gf_unit metadata');
          return 'ignored_missing_unit';
        }

        await dispatch('billing.recordTopup', {
          unit, units,
          paidCents: pi.amount_received || pi.amount,
          stripePaymentIntentId: pi.id,
          trigger: kind === 'auto_topup' ? 'auto' : 'manual',
        }, ctx, { idempotencyKey: `topup-${pi.id}` });
        return 'topup_recorded';
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        if (pi.metadata?.['gf_kind'] !== 'auto_topup') return 'ignored_kind';
        const unit = pi.metadata?.['gf_unit'];
        if (!isQuotaUnit(unit)) return 'ignored_missing_unit';
        await dispatch('billing.recordTopupFailure', {
          unit,
          reason: pi.last_payment_error?.decline_code
            ?? pi.last_payment_error?.code ?? 'payment_failed',
        }, ctx);
        return 'topup_failure_recorded';
      }

      default:
        return 'ignored_type';
    }
  }

  /** 绑卡完成：把 SetupIntent 上那张卡记成默认支付方式 */
  async function savePaymentMethodFromSetup(
    session: Stripe.Checkout.Session, ctx: CommandContext,
  ): Promise<void> {
    const stripe = stripeClient();
    const setupIntentId = typeof session.setup_intent === 'string'
      ? session.setup_intent : session.setup_intent?.id;
    if (!setupIntentId) return;

    const si = await stripe.setupIntents.retrieve(setupIntentId);
    const pmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
    if (!pmId) return;

    const pm = await stripe.paymentMethods.retrieve(pmId);

    // ⭐ 同时设成 Stripe 客户的默认付款方式：不设的话，月费发票到期时
    // Stripe 不知道该刷哪张卡，订阅会因为「没有支付方式」而 past_due ——
    // 而老板明明刚绑过卡，界面上也显示绑好了
    if (typeof session.customer === 'string') {
      await stripe.customers.update(session.customer, {
        invoice_settings: { default_payment_method: pmId },
      });
    }

    await dispatch('billing.savePaymentMethod', {
      paymentMethodId: pmId,
      label: paymentMethodLabel(pm),
    }, ctx);
  }

  /** 订阅对象 → 本地账户状态 */
  /**
   * 试用到期提醒信 —— **一次订阅只发一封**。
   *
   * 和激活信同一个纪律（signup/webhook.ts §sendActivationOnce）：
   * **先原子占位，再入队。** 反过来的话，Stripe 重投两次
   * `trial_will_end` 会同时看到「还没发过」，然后老板收到两封一样的催款信。
   *
   * 返回 true = 这次真的发了；false = 已经发过。
   */
  async function sendTrialEndingOnce(
    ctx: CommandContext, sub: Stripe.Subscription,
  ): Promise<boolean> {
    const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null };

    return withTenant(tenant, async (tx) => {
      // ① 抢占。只有抢到那一行的人往下走
      const [claimed] = await tx<{ id: string; plan: string }[]>`
        update billing_accounts set trial_will_end_notified_at = now()
        where location_id = ${ctx.locationId} and trial_will_end_notified_at is null
        returning id, plan`;
      if (!claimed) return false;

      // ② 收件人 = 这家店的 owner。找不到就不发 —— 宁可不发，
      //    也不要发给一个「我们猜的」邮箱（那可能是某位前台）
      const [owner] = await tx<{ email: string | null }[]>`
        select u.email
        from memberships m
        join users u on u.id = m.user_id
        join membership_roles mr on mr.membership_id = m.id
        join roles r on r.id = mr.role_id
        where m.location_id = ${ctx.locationId}
          and r.key = 'owner' and m.user_id is not null and u.email is not null
        order by m.created_at asc
        limit 1`;
      if (!owner?.email) {
        app.log.warn({ locationId: ctx.locationId }, 'trial ending: 找不到 owner 邮箱，不发信');
        return false;
      }

      const [loc] = await tx<{ name: unknown; timezone: string }[]>`
        select name, timezone from locations where id = ${ctx.locationId}`;
      const nameObj = (loc?.name ?? {}) as Record<string, string>;
      const shopName = nameObj['zh-Hans'] ?? nameObj['en'] ?? Object.values(nameObj)[0] ?? '你的门店';

      const plan = claimed.plan;
      const msg = renderTrialEnding({
        shopName,
        chargeDateText: sub.trial_end
          ? formatWhen(new Date(sub.trial_end * 1000).toISOString(), loc?.timezone ?? 'UTC')
          : '试用结束当天',
        planLabel: plan === 'growth' ? 'Growth' : 'Essential',
        monthlyText: plan === 'growth' ? '每月 $199' : '每月 $99',
        billingUrl: `${(process.env['APP_BASE_URL'] ?? 'http://localhost:5173')
          .replace(/\/+$/, '')}/?tab=billing`,
      });

      // ③ 入队。唯一索引 (entity_type, entity_id, kind) 是第二道保险 ——
      //    ① 已经挡住并发了，这一条挡的是「有人手工清了 notified_at」
      await tx`
        insert into email_outbox
          (org_id, location_id, kind, to_email, subject, body_html, body_text,
           entity_type, entity_id)
        values (${ctx.orgId}, ${ctx.locationId}, 'trial_ending', ${owner.email},
                ${msg.subject}, ${msg.html}, ${msg.text},
                'billing_account', ${claimed.id})
        on conflict (entity_type, entity_id, kind) do nothing`;

      return true;
    });
  }

  async function syncSubscription(
    sub: Stripe.Subscription, ctx: CommandContext, eventId: string,
  ): Promise<void> {
    const item = sub.items?.data?.[0];
    const plan = planForPriceId(item?.price?.id);
    // 当期结束时刻在 item 上（Stripe 2025 之后的 API 把它从 subscription 挪下来了）
    const periodEndSec = item?.current_period_end;

    await dispatch('billing.syncSubscription', {
      stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      stripeSubscriptionId: sub.id,
      // ⚠️ 认不出的 price **不写** —— 把未知套餐写成 starter 会让付 Pro 钱的
      // 客户被静默降档，而账单上看不出来
      plan,
      subscriptionStatus: mapSubscriptionStatus(sub.status),
      currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
      // 试用转正之后 Stripe 就不再给 trial_end 了 —— 这时候要真的写回 null，
      // 不能 `?? undefined` 留着旧值（那会让客服看到一个早就过期的日期）
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
      sourceEventId: eventId,
    }, ctx);
  }
}

/**
 * 从事件里挖出门店。
 *
 * 顺序是「对象自己的 metadata → 关联对象的 metadata」——
 * 我们在创建每一个 Stripe 对象时都写了 `gf_location_id`，
 * 但订阅的发票事件是 Stripe 自己生成的，只带得上订阅的那一份。
 */
function tenantFromEvent(event: Stripe.Event): Tenant | null {
  const obj = event.data.object as { metadata?: Record<string, string> | null };
  return tenantFromMetadata(obj?.metadata);
}

function tenantFromMetadata(meta: Record<string, string> | null | undefined): Tenant | null {
  const locationId = meta?.['gf_location_id'];
  const orgId = meta?.['gf_org_id'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!locationId || !orgId || !UUID.test(locationId) || !UUID.test(orgId)) return null;
  return { orgId, locationId };
}

/**
 * 回跳地址。
 *
 * ⚠️ **不接受客户端给的任意 URL**：那是一个开放重定向 ——
 * 攻击者把老板从「付款成功」直接送到一个仿冒的登录页，
 * 而地址栏上一跳确实是 stripe.com，看起来无可挑剔。
 *
 * 所以只保留 path，域名一律用我们自己配的 `APP_BASE_URL`。
 */
function safeReturnUrls(body: { successUrl?: string; cancelUrl?: string } | undefined): {
  successUrl: string; cancelUrl: string;
} {
  const base = (process.env['APP_BASE_URL'] ?? 'http://localhost:5173').replace(/\/+$/, '');
  const pathOf = (v: string | undefined, dflt: string): string => {
    if (!v) return dflt;
    // 只认相对路径。带协议或以 // 开头的一律丢掉
    if (!v.startsWith('/') || v.startsWith('//')) return dflt;
    return v;
  };
  return {
    successUrl: `${base}${pathOf(body?.successUrl, '/?billing=done')}`,
    cancelUrl: `${base}${pathOf(body?.cancelUrl, '/?billing=cancelled')}`,
  };
}

export { maybeAutoTopup };
export type { QuotaUnit };
