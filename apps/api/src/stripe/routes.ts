import { monthlyPrice, trialLastDay } from '../email/billingLocalized';
import { canSwitchPlan } from '@gf/contracts';
import { voicePortalConfiguration } from './voicePortal';
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
 * 定位门店先靠 Stripe metadata 里的 `gf_location_id`（我们自己写进去的）。
 * 发票事件经常没有这份 metadata，再按我们存过的 subscription/customer
 * 映射回门店。浏览器输不进这条路。
 *
 * ## 绝不碰卡号
 *
 * 绑卡走 **Stripe 托管的 Checkout（setup 模式）**：卡号只在 Stripe 的
 * 页面上输入，我们这边从头到尾只见得到一个 `pm_…` 和一句
 * 「Visa ···· 4242」。碰一下 PCI 范围，合规成本就是另一个量级。
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES,
  type CommandContext, type Permission,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import {
  unitsPerTopup, TOPUP_PRICE_CENTS, isQuotaUnit, TRIAL_DAYS,
  type QuotaUnit,
} from '@gf/payroll';
import { dispatch } from '../bus';
import { rawBodyOf } from '../rawBody';
import { verifyStripeSignature, STRIPE_SIGNATURE_HEADER } from './verify';
import {
  stripeClient, priceIdFor, planForPriceId, mapSubscriptionStatus,
  paymentMethodLabel, stripeDefaultPaymentMethod, declineReason, isPlan, type Stripe,
} from './client';
import { maybeAutoTopup } from '../billing/autoTopup';
import { billingPortalUrl, safePortalReturnUrl, safeReturnUrls } from '../links';
import { isZhLocale, ownerLocaleOf, type OwnerLocale } from '../email/locale';
import { ownerShopOf, type OwnerShop } from '../email/ownerShop';
import { invoiceStripeRefs, resolveWebhookTenant } from './tenant';
import {
  renderTrialEnding, renderPaymentFailed, renderSubscriptionCanceled, formatWhen,
} from '../email/render';
import {
  isSignupSession, provisionFromSession, backfillStripeMetadata, sendActivationOnce,
  cancelDanglingSignupSubscription,
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

/**
 * 把任意一个 Stripe id 稳定地映射成一个 uuid。
 *
 * `email_outbox.entity_id` 是 uuid 列（sql/0029），而我们要去重的东西
 * （发票、一次退订）在 Stripe 那边是字符串 id。md5 的 32 个十六进制位
 * 正好排成 uuid 的形状 —— 这里要的只是「同一个输入永远得到同一个键」，
 * 不需要密码学强度，也不参与任何安全判断。
 */
export function stableUuid(seed: string): string {
  const hex = createHash('md5').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Tenant { orgId: string; locationId: string }

/**
 * Atomically claim a Stripe event for processing.
 *
 * A fresh or retryable event returns true. Processed events, active leases and
 * concurrent losers return false. Keeping this outside the route makes the
 * crash-recovery contract directly testable against PostgreSQL.
 */
export async function claimStripeEvent(
  event: Pick<Stripe.Event, 'id' | 'type'>,
  t: Tenant,
): Promise<boolean> {
  const claimed = await withTenant(
    { orgId: t.orgId, locationId: t.locationId, membershipId: null },
    (tx) => tx<{ id: string }[]>`
      insert into stripe_events (id, type, location_id, status, attempt_started_at)
      values (${event.id}, ${event.type}, ${t.locationId}, 'processing', now())
      on conflict (id) do update
        set status = 'processing', error = null, processed_at = null,
            attempt_started_at = now()
        where stripe_events.status = 'failed'
           or (stripe_events.status = 'processing'
               and stripe_events.attempt_started_at < now() - interval '10 minutes')
      returning id`);
  return claimed.length > 0;
}

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

/**
 * 核对一个 Stripe customer 到底属不属于**这个组织**（AUD-02）。
 *
 * ## 为什么本地那一列不够
 *
 * `billing_accounts.stripe_customer_id` 是**我们写的**。门户会话一旦按它开出去，
 * 拿到的是那个 customer 名下的全部东西：历史发票、卡的品牌与后四位、
 * 账单地址，以及**退订按钮**。也就是说这一列的可信度直接等于
 * 「谁能写它」——而在 AUD-01 修好之前，答案是「任何一个老板」。
 *
 * 所以判据换成 Stripe 自己的 metadata：`gf_org_id` / `gf_location_id`
 * 是建 customer 时我们写进去的（`ensureCustomer`），只可能由服务端产生。
 *
 * ## ⭐ 判据是 org，不是 location
 *
 * 多店经营**故意共用同一个 Stripe 客户**（一个老板一张卡一张账单，
 * 见 `/v1/billing/add-store`）。而 customer 上的 `gf_location_id` 永远是
 * **建它的那一家店**。按 location 比的话，第二家店的老板点「管理订阅」
 * 和「充值」必然被判成越权 —— 而他要管的正是自己那张卡。
 *
 * 真正要拦的攻击是「把**别家 org** 的 cus_ 写进自己这一行」，
 * 那条边界是 org（sql/0080 的触发器守的也是这一条）。
 *
 * ⚠️ **老 customer 可能只写了 `gf_location_id`**（计费上线早于回填那一版）。
 * 判定因此分四档：
 *   · 有 gf_org_id 且指向别的 org → 拒。这是唯一真正危险的情况
 *   · 有 gf_org_id 且指向本 org   → 放行
 *   · 只有 gf_location_id         → 查那家店在不在本 org（RLS 天然只看得到本 org）
 *   · 两个都缺                    → 放行，但记一条 warn 供回填
 *
 * 换句话说：我们拦的是「指到别人家了」，不是「没标过」。
 */
export async function assertStripeCustomerBelongsTo(
  customerId: string,
  tenant: { orgId: string; locationId: string },
  log?: { warn: (o: unknown, m: string) => void },
): Promise<void> {
  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripeClient().customers.retrieve(customerId);
  } catch (e) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'stripe', reason: declineReason(e) },
    });
  }
  if (customer.deleted) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'stripe_customer_deleted' } });
  }
  const meta = customer.metadata ?? {};
  const ownerOrg = meta['gf_org_id'];
  const ownerLocation = meta['gf_location_id'];

  if (ownerOrg) {
    if (ownerOrg === tenant.orgId) return;
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'stripe_customer_org_mismatch' },
    });
  }

  if (ownerLocation) {
    if (ownerLocation === tenant.locationId) return;
    /*
     * 只标了 location 的老 customer。那家店在不在本 org，问数据库 ——
     * RLS 只让我们看得见本 org 的门店，所以「查得到」本身就是答案。
     */
    const [sibling] = await withTenant(
      { orgId: tenant.orgId, locationId: tenant.locationId, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        select id from locations
        where id = ${ownerLocation} and org_id = ${tenant.orgId}`);
    if (sibling) return;
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'stripe_customer_location_mismatch' },
    });
  }

  log?.warn({ customerId, orgId: tenant.orgId }, 'stripe customer without gf_org_id metadata');
}

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
   * 这家店当前的计费账户。订阅入口的三个判断都要用它。
   */
  async function billingAccountOf(ctx: CommandContext): Promise<{
    sub: string | null; cust: string | null; status: string;
    trial: Date | string | null; cancelAtPeriodEnd: boolean;
  } | null> {
    const [acct] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{
        sub: string | null; cust: string | null; status: string;
        trial: Date | string | null; cancelAtPeriodEnd: boolean;
      }[]>`
        select stripe_subscription_id as sub, stripe_customer_id as cust,
               subscription_status as status, trial_ends_at as trial,
               cancel_at_period_end as "cancelAtPeriodEnd"
        from billing_accounts where location_id = ${ctx.locationId}`);
    return acct ?? null;
  }

  /**
   * 这个**组织**订阅过没有 —— 决定这次 Checkout 给不给七天试用。
   *
   * ⚠️ 判据是 org 而不是单店：一个老板开第二家店时，他早就用过试用了。
   * 按店判的话，「开一家新店」就是一张无限续杯的试用券。
   *
   * 三个证据任意一条成立就算用过：
   *   · 组织里任何一家店有过 subscription id
   *   · 任何一家店有过 `trial_ends_at`（退订会清 id，但历史试用时刻留着 ——
   *     那正是「这家伙已经用过一次试用」的证据）
   *   · 任何一家店的状态不是 `none`
   */
  async function everSubscribed(ctx: CommandContext): Promise<boolean> {
    const [row] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ used: boolean }[]>`
        select exists (
          select 1 from billing_accounts
          where org_id = ${ctx.orgId}
            and (stripe_subscription_id is not null
              or trial_ends_at is not null
              or subscription_status <> 'none')
        ) as used`);
    return Boolean(row?.used);
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
    await dispatch('billing.syncSubscription', { stripeCustomerId: customer.id }, ctx, { systemOrigin: 'stripe_webhook' });
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
     * ⭐⭐ **已经有生效订阅的店不能再走这条路。**
     *
     * Stripe 的 Checkout（subscription 模式）**不会去改已有的订阅，它新建
     * 一条**。于是「换个套餐再点一次订阅」的结果是：
     *   · 这家店名下有两条订阅，两条都在每月扣款
     *   · 而本地 `stripe_subscription_id` 被新那条覆盖，
     *     旧那条从此**在我们的账面上不存在**，直到客户看信用卡账单
     *
     * 改档、退订、换卡一律走客户门户（`/v1/billing/portal-session`）——
     * 那是 Stripe 托管的、能正确处理按比例计费与生效时间的那一条路。
     */
    const [currentPlan] = await withTenant(ctx, tx => tx<{ plan: string }[]>`select plan from billing_accounts where location_id=${ctx.locationId}`);
    if (currentPlan && !canSwitchPlan(currentPlan.plan, plan)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'voice_booking_can_only_switch_to_growth' } });
    const existing = await billingAccountOf(ctx);
    if (existing?.sub && ['active', 'trialing', 'past_due'].includes(existing.status)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: {
          reason: 'already_subscribed',
          subscriptionStatus: existing.status,
          hint: '改套餐或退订请走客户门户 /v1/billing/portal-session',
        },
      });
    }

    /**
     * ⭐ 试用只给**第一次订阅**的组织。
     *
     * 判据不是「现在是不是 active」—— 退订过又回来的老客户
     * `stripe_subscription_id` 可能已经被清空，但 `trial_ends_at`
     * 还留着历史值，那才是真正的证据。见 `everSubscribed`。
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
    }, {
      /**
       * ⚠️ 幂等键按「门店 + 套餐 + 十分钟窗口」分桶。
       *
       * 老板在网络慢的时候会连点两次「订阅」，而两个 Checkout session
       * 都完成的话就是**两条订阅**。Stripe 的幂等缓存 24 小时后失效，
       * 分桶保证他十分钟后真想重来时不会被旧的缓存挡住。
       */
      idempotencyKey: `gf-checkout-${ctx.locationId}-${plan}-${
        Math.floor(Date.now() / 600_000)}`,
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

    /*
     * ② 找到这个 org 现有的**生效**订阅。没有就说清楚 —— 第一家店都还没订阅，
     *    第二家店的计费无处可加。
     *
     * ⚠️ 必须过滤状态。退订之后 `stripe_subscription_id` 是**留着的**
     * （webhook 靠它定位租户），不过滤的话这里会挑中一条已经取消的订阅，
     * 然后 `subscriptionItems.create` 当场报错 —— 而门店已经建好了，
     * 老板看到的是「建店失败」而其实店已经在那儿了。
     *
     * `past_due` 也不接：往一条正在催款的订阅上加 item，只会让那张
     * 本来就扣不动的卡再多欠一笔。
     */
    const [existing] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ sub: string | null; cust: string | null }[]>`
        select stripe_subscription_id as sub, stripe_customer_id as cust
        from billing_accounts
        where org_id = ${ctx.orgId}
          and stripe_subscription_id is not null
          and subscription_status in ('active', 'trialing')
          and cancel_at_period_end = false
        order by created_at asc
        limit 1`);

    if (!existing?.sub) {
      return {
        ...created.result,
        billing: 'not_linked',
        /**
         * ⚠️ 这家店此刻是 `subscription_status = 'none'`（sql/0085）——
         * 能开单、能排班，但**套餐内 AI 额度是 0**。老板接上订阅之后
         * webhook 会把状态和额度一起带过来。
         */
        note: '门店已建好，但这个组织还没有生效的订阅 —— 先给第一家店订阅，再回来加计费。'
          + '在那之前这家店的 AI 额度为 0。',
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
      /**
       * ⭐ 新店那个 item 的 id 必须当场落库（sql/0085）。
       *
       * 后续每一条 `customer.subscription.updated` 都要按 item 把套餐和
       * 账期拆回每一家店 —— 没有这一列的话，只能取 `items.data[0]`，
       * 而 Stripe 不保证列表顺序：主店的套餐会被这家新店的档位改掉。
       */
      items: [{ locationId: newLoc, subscriptionItemId: item.id, plan }],
    }, newCtx, { systemOrigin: 'stripe_webhook' });

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
      (tx) => tx<{ stripe_customer_id: string | null; plan: string }[]>`
        select stripe_customer_id, plan from billing_accounts
        where location_id = ${ctx.locationId}`);

    if (!acct?.stripe_customer_id) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { reason: 'stripe_customer_not_found' },
      });
    }

    // ⭐ 归属必须问 Stripe，不能只信本地那一列（AUD-02）。
    await assertStripeCustomerBelongsTo(
      acct.stripe_customer_id, { orgId: ctx.orgId, locationId: ctx.locationId }, req.log);

    const returnUrl = safePortalReturnUrl(req.body?.returnUrl);
    try {
      const session = await stripeClient().billingPortal.sessions.create({
        customer: acct.stripe_customer_id,
        return_url: returnUrl,
        ...(acct.plan === 'voice_booking' ? { configuration: await voicePortalConfiguration() } : {}),
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
  // 手动购买必须在 Stripe 托管页确认，只有支付成功 webhook 才能增加额度。
  app.post<{ Body: { unit?: string; successUrl?: string; cancelUrl?: string } }>(
    '/v1/billing/topup', async (req) => {
    const ctx = await ownerCtx(req);
    const unit = req.body?.unit;
    if (!isQuotaUnit(unit)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '要说明充哪一种额度', allowed: ['credit', 'voice_minute'], got: unit },
      });
    }
    const units = unitsPerTopup(unit);
    const { successUrl, cancelUrl } = safeReturnUrls(req.body);
    const customerId = await ensureCustomer(ctx);
    await assertStripeCustomerBelongsTo(
      customerId, { orgId: ctx.orgId, locationId: ctx.locationId }, req.log);

    const metadata = {
      gf_location_id: ctx.locationId, gf_org_id: ctx.orgId, gf_kind: 'topup',
      gf_unit: unit, gf_units: String(units),
    };
    try {
      const session = await stripeClient().checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: TOPUP_PRICE_CENTS,
            product_data: {
              name: unit === 'credit'
                ? `GenieFront ${units} AI 积分` : `GenieFront ${units} AI 语音分钟`,
            },
          },
          quantity: 1,
        }],
        metadata,
        // Checkout metadata 不会自动复制到 PaymentIntent；入账回调需要这份标记。
        payment_intent_data: { metadata },
      });
      return { url: session.url, sessionId: session.id };
    } catch (e) {
      req.log.warn({ err: e, locationId: ctx.locationId, unit }, 'manual topup checkout failed');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'stripe', reason: declineReason(e) },
      });
    }
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

    // Customer direct charges belong only to the commerce endpoint. Even an
    // accidentally subscribed SaaS webhook must not bill merchants or grant AI credits.
    if(event.account || (event.data.object as {metadata?:Record<string,string>}).metadata?.gf_domain==='customer_commerce') {
      return {received:true,result:'ignored_customer_commerce'};
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
        /**
         * 邮箱不一致 → 拒绝，一行都不写。照常 200：重投一百次答案也一样。
         *
         * ⭐ 但**必须把那条订阅取消掉**。原来这里只是返回 —— 于是
         * Stripe 那边留着一条活的订阅（还带着试用），到期照扣，
         * 而我们这边一家店都没有：钱收了，服务不存在。
         * 取消失败只记日志：这一条已经是补救，不该让它把整条 webhook 拖成失败。
         */
        await cancelDanglingSignupSubscription(session, req.log);
        return { ok: true, rejected: 'owner_email_mismatch' };
      }
      await backfillStripeMetadata(session, signup, req.log);
    }

    const t = signup
      ? { orgId: signup.orgId, locationId: signup.locationId }
      : await resolveWebhookTenant(event);
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
     * ⚠️ failed 或已处理超过 10 分钟的 processing 行允许被重试：
     * 后者覆盖进程在 insert 后、完成前崩溃的情况。没有租约的话，那条事件会
     * 永久停在 processing，此后每次 Stripe 重投都被误判成 duplicate。
     */
    const claimed = await claimStripeEvent(event, t);

    if (!claimed) {
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
        const sub = event.data.object;
        await syncSubscription(sub, ctx, event.id);

        /**
         * ⭐ 退订要发信，而且**期末取消那一档最不能省**。
         *
         * 老板在客户门户点完取消，Stripe 给的是 `cancel_at_period_end = true`
         * 而 status 仍然是 active —— 界面上这家店还能正常用。他很容易
         * 以为没点成功而再点一次，或者打电话来问。这封信是唯一说清
         * 「什么时候真的停」的地方。
         *
         * 去重键带上取消时刻：同一次取消重投一百遍只有一封，
         * 而「退订 → 恢复 → 再退订」还发得出第二封。
         */
        const canceledNow = event.type === 'customer.subscription.deleted'
          || sub.cancel_at_period_end === true;
        if (canceledNow) {
          const endsAtSec = sub.cancel_at
            ?? sub.canceled_at
            ?? sub.items?.data?.[0]?.current_period_end
            ?? null;
          const sent = await sendSubscriptionCanceled(ctx, {
            subscriptionId: sub.id,
            atPeriodEnd: event.type !== 'customer.subscription.deleted',
            endsAtIso: endsAtSec ? new Date(endsAtSec * 1000).toISOString() : null,
          });
          return sent ? 'subscription_canceled_notified' : 'subscription_synced';
        }
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
      /**
       * 卡被摘掉（AUD-07）。
       *
       * 不等下一条 `customer.subscription.updated` 才对齐：那可能是一个月后
       * 的续费事件，中间这一个月界面一直显示一张不存在的卡，
       * 而自动续充也会一直拿它去扣。
       */
      case 'payment_method.detached': {
        const pm = event.data.object;
        // 只清**这一张**。摘的是另一张卡的话什么都不做 ——
        // 无条件清空会在「换卡」这个最常见的动作里把新卡也抹掉
        // （Stripe 的顺序是先 attach 新卡、再 detach 旧卡）。
        const [acct] = await withTenant(
          { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
          (tx) => tx<{ pm: string | null }[]>`
            select default_payment_method_id as pm from billing_accounts
            where location_id = ${ctx.locationId}`);
        if (acct?.pm !== pm.id) return 'payment_method_not_current';

        await dispatch('billing.savePaymentMethod', {
          paymentMethodId: null,
          label: null,
        }, ctx, { systemOrigin: 'stripe_webhook' });
        return 'payment_method_detached';
      }

      /**
       * 订阅发票扣款成功。
       *
       * `billing_invoices` 从 0052 起**只有读的一侧** —— 没有任何一条
       * webhook 往里写，所以「订阅发票」那一页一直是空的，而老板问的
       * 第一个问题就是「上个月扣的那 $99 有没有单据」。
       *
       * ⚠️ 金额、税、按比例摊分**一律照抄 Stripe**，不自己算。
       * 自己算一定会差几分钱，而对不上的那几分钱会让他怀疑整套账。
       */
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        // Payment can arrive without subscription.updated (or before it).
        // Fetch current Stripe truth, never infer active from an old paid invoice.
        const { subscriptionId } = invoiceStripeRefs(
          event.data.object as unknown as Record<string, unknown>);
        if (subscriptionId) {
          const sub = await stripeClient().subscriptions.retrieve(subscriptionId);
          await syncSubscription(sub, ctx, event.id);
        }
        await recordInvoice(event.data.object, ctx, 'paid');
        return 'invoice_recorded';
      }

      /**
       * 扣款失败。**不在这里停服** —— 订阅状态会由 Stripe 随后的
       * `customer.subscription.updated` 带成 `past_due`，冻结由那条统一处理。
       *
       * 这里做两件事：
       *   1. 把这张发票记成 failed，客服要答得出是哪一天、多少钱
       *   2. ⭐ **给老板发信**。这封信原来是没有的 —— 于是扣款失败之后
       *      他得到的唯一信号是第二天早上前台开不了单，而那时候他既不知道
       *      为什么，也不知道该做什么
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

        const recorded = await recordInvoice(inv, ctx, 'failed');
        const sent = await sendPaymentFailed(ctx, inv, recorded);
        return sent ? 'invoice_failure_notified' : 'invoice_failure_logged';
      }

      /**
       * 退款与拒付：把当初入账的那一笔额度**冲销掉**。
       *
       * ⚠️ 不冲销的话，客户把钱要了回去而额度还留在账上 —— 这是拿被盗的卡
       * 充值再拒付的标准玩法，而额度已经被烧成真金白银的 token 了。
       *
       * 认不出对应充值流水时什么都不做（订阅月费的退款走的就是这一支），
       * 凭空扣一笔额度比不扣更糟。
       */
      case 'charge.refunded':
      case 'charge.dispute.created': {
        const paymentIntentId = disputedPaymentIntent(event);
        if (!paymentIntentId) return 'ignored_no_payment_intent';
        const out = await dispatch<{ reversed: boolean }>('billing.recordTopupReversal', {
          stripePaymentIntentId: paymentIntentId,
          reason: event.type === 'charge.dispute.created' ? 'dispute' : 'refund',
        }, ctx, { systemOrigin: 'stripe_payment_intent' });
        return out.result.reversed ? 'topup_reversed' : 'reversal_not_applicable';
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
        }, ctx, { idempotencyKey: `topup-${pi.id}`, systemOrigin: 'stripe_payment_intent' });
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
        }, ctx, { systemOrigin: 'stripe_payment_intent' });
        return 'topup_failure_recorded';
      }

      default:
        return 'ignored_type';
    }
  }

  // ── 发票与通知 ────────────────────────────────────────────────────────────

  /** Stripe 的秒级时间戳 → `YYYY-MM-DD`。发票表那两列存的是文本（sql/0052） */
  function ymd(sec: number | null | undefined): string {
    return new Date((sec ?? Math.floor(Date.now() / 1000)) * 1000)
      .toISOString().slice(0, 10);
  }

  /**
   * 把一张 Stripe 发票落库，返回本地那一行的 id。
   *
   * ⚠️ 金额分两种取法：付成功了看 `amount_paid`，失败了看 `amount_due` ——
   * 失败的发票 `amount_paid` 是 0，照它记的话老板会看到一张 $0 的失败单，
   * 而他真正想知道的是「这次没扣上的是 $99」。
   */
  async function recordInvoice(
    inv: Stripe.Invoice, ctx: CommandContext, status: 'paid' | 'failed',
  ): Promise<string | null> {
    if (!inv.id) return null;
    const line = inv.lines?.data?.[0];
    const out = await dispatch<{ invoiceId: string }>('billing.recordInvoice', {
      stripeInvoiceId: inv.id,
      invoiceNumber: inv.number ?? inv.id,
      period: `${ymd(inv.period_start)} – ${ymd(inv.period_end)}`,
      description: (line?.description ?? 'GenieFront subscription').slice(0, 200),
      amountCents: status === 'paid' ? inv.amount_paid : inv.amount_due,
      status,
      date: ymd(inv.created),
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      receiptPdfUrl: inv.invoice_pdf ?? null,
    }, ctx, { systemOrigin: 'stripe_webhook' });
    return out.result.invoiceId;
  }

  /**
   * 扣款失败通知，**一张发票一封**。
   *
   * 去重键用本地发票行的 id：Stripe 每次自动重试都会再发一条
   * `invoice.payment_failed`，而老板不需要为同一张单收四封一样的信。
   */
  async function sendPaymentFailed(
    ctx: CommandContext, inv: Stripe.Invoice, invoiceRowId: string | null,
  ): Promise<boolean> {
    if (!invoiceRowId) return false;
    return queueOwnerEmail(ctx, {
      kind: 'payment_failed',
      entityType: 'billing_invoice',
      entityId: invoiceRowId,
      render: (shop) => renderPaymentFailed({
        shopName: shop.shopName,
        amountText: `$${(inv.amount_due / 100).toFixed(2)}`,
        nextAttemptText: inv.next_payment_attempt
          ? formatWhen(
              new Date(inv.next_payment_attempt * 1000).toISOString(),
              shop.timezone, shop.locale)
          : null,
        billingUrl: billingPortalUrl(),
        locale: shop.locale,
      }),
    });
  }

  /**
   * 退订通知。
   *
   * ⚠️ 去重键是「订阅 id + 终止时刻」而不是门店 id：后者会让
   * 「退订 → 恢复 → 再退订」的第二封信永远发不出去，而那恰恰是
   * 老板最需要确认的一次。
   */
  async function sendSubscriptionCanceled(
    ctx: CommandContext,
    args: { subscriptionId: string; atPeriodEnd: boolean; endsAtIso: string | null },
  ): Promise<boolean> {
    return queueOwnerEmail(ctx, {
      kind: 'subscription_canceled',
      entityType: 'billing_account',
      entityId: stableUuid(`cancel:${args.subscriptionId}:${args.endsAtIso ?? ''}`),
      render: (shop) => renderSubscriptionCanceled({
        shopName: shop.shopName,
        // ⚠️ null 交由模板按语言给兜底文案；此前在这里硬写中文串，
        //    英文信里会出现「当期结束时」
        endsAtText: args.endsAtIso
          ? formatWhen(args.endsAtIso, shop.timezone, shop.locale) : null,
        atPeriodEnd: args.atPeriodEnd,
        billingUrl: billingPortalUrl(),
        locale: shop.locale,
      }),
    });
  }

  /**
   * 从 `charge.refunded` / `charge.dispute.created` 里挖出 PaymentIntent id。
   *
   * 两个事件的 `data.object` 不是同一种东西（一个是 Charge，一个是 Dispute），
   * 但两者都带 `payment_intent` —— 而那正是我们记账时用的那个 id。
   */
  function disputedPaymentIntent(event: Stripe.Event): string | null {
    const obj = event.data.object as unknown as { payment_intent?: unknown };
    const pi = obj.payment_intent;
    if (typeof pi === 'string' && pi.length > 0) return pi;
    if (pi && typeof pi === 'object' && 'id' in pi) {
      const id = (pi as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return null;
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
    }, ctx, { systemOrigin: 'stripe_webhook' });
  }

  /**
   * 往发件箱里放一封计费通知，**同一件事只放一封**。
   *
   * 去重靠 `email_outbox` 上的唯一索引 `(entity_type, entity_id, kind)`
   * （sql/0029）。`entityId` 由调用方给一个**每件事一个**的 uuid ——
   * 发票用发票行 id，退订用「订阅 id + 取消时刻」的 md5，
   * 这样下一次退订还能再发一封，而同一次退订重投一百遍也只有一封。
   *
   * ⚠️ 发不出去**不算这条 webhook 失败**：订阅状态已经落库、门店该冻的
   * 已经冻了，为一封信让 Stripe 反复重投一件已经做完的事是错的。
   */
  async function queueOwnerEmail(
    ctx: CommandContext,
    args: {
      kind: 'payment_failed' | 'subscription_canceled';
      entityType: string;
      /** 每件事一个的 uuid。同一件事重投时命中唯一索引，不会重复入队 */
      entityId: string;
      render: (shop: OwnerShop) => { subject: string; html: string; text: string };
    },
  ): Promise<boolean> {
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      async (tx) => {
        const shop = await ownerShopOf(tx, ctx.locationId);
        if (!shop) {
          app.log.warn({ locationId: ctx.locationId, kind: args.kind },
                       'billing notice: 找不到 owner 邮箱，不发信');
          return false;
        }
        const msg = args.render(shop);
        const inserted = await tx<{ id: string }[]>`
          insert into email_outbox
            (org_id, location_id, kind, to_email, subject, body_html, body_text,
             entity_type, entity_id)
          values (${ctx.orgId}, ${ctx.locationId}, ${args.kind}, ${shop.email},
                  ${msg.subject}, ${msg.html}, ${msg.text},
                  ${args.entityType}, ${args.entityId}::uuid)
          on conflict (entity_type, entity_id, kind) do nothing
          returning id`;
        return inserted.length > 0;
      },
    );
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
      const [claimed] = await tx<{ id: string }[]>`
        update billing_accounts set trial_will_end_notified_at = now()
        where location_id = ${ctx.locationId} and trial_will_end_notified_at is null
        returning id`;
      if (!claimed) return false;

      // ② 收件人 = 这家店的 owner。找不到就不发（见 ownerShopOf 的注释）
      const shop = await ownerShopOf(tx, ctx.locationId);
      if (!shop) {
        app.log.warn({ locationId: ctx.locationId }, 'trial ending: 找不到 owner 邮箱，不发信');
        return false;
      }

      /*
       * ⚠️ 日期与金额文案均按**收件人的语言**生成。
       * 此前 `formatWhen` 缺省 `zh-CN`、`monthlyText` 硬写「每月 $99」，
       * 两者在英文分支中原样出现，构成一封中英混排的账单邮件。
       */
      const monthlyUsd = shop.plan === 'growth' ? 199 : 99;
      const msg = renderTrialEnding({
        shopName: shop.shopName,
        chargeDateText: sub.trial_end
          ? formatWhen(new Date(sub.trial_end * 1000).toISOString(),
                       shop.timezone, shop.locale)
          : trialLastDay(shop.locale),
        planLabel: shop.plan === 'voice_booking' ? 'AI Voice Booking' : shop.plan === 'growth' ? 'Growth' : 'Essential',
        monthlyText: monthlyPrice(shop.locale, monthlyUsd),
        billingUrl: billingPortalUrl(),
        locale: shop.locale,
      });

      // ③ 入队。唯一索引 (entity_type, entity_id, kind) 是第二道保险 ——
      //    ① 已经挡住并发了，这一条挡的是「有人手工清了 notified_at」
      await tx`
        insert into email_outbox
          (org_id, location_id, kind, to_email, subject, body_html, body_text,
           entity_type, entity_id)
        values (${ctx.orgId}, ${ctx.locationId}, 'trial_ending', ${shop.email},
                ${msg.subject}, ${msg.html}, ${msg.text},
                'billing_account', ${claimed.id})
        on conflict (entity_type, entity_id, kind) do nothing`;

      return true;
    });
  }

  /**
   * 这条订阅上，每个 item 分别属于哪家门店。
   *
   * ⭐ 多店经营共用**同一条订阅**，一家店一个 item（`/v1/billing/add-store`）。
   * 我们在建 item 时把 `gf_location_id` 写进了它的 metadata，这里读回来。
   *
   * ⚠️ 只认**认得出门店**的那些 item。认不出的（历史 item、手工在 Stripe
   * 后台加的）不进这份映射 —— 猜一个门店去改它的套餐，比不改糟得多。
   */
  function itemsByLocation(sub: Stripe.Subscription): Array<{
    locationId: string; subscriptionItemId: string;
    plan: 'voice_booking' | 'essential' | 'growth' | null; currentPeriodEnd: string | null;
  }> {
    const out: Array<{
      locationId: string; subscriptionItemId: string;
      plan: 'voice_booking' | 'essential' | 'growth' | null; currentPeriodEnd: string | null;
    }> = [];
    for (const item of sub.items?.data ?? []) {
      const locationId = item.metadata?.['gf_location_id'];
      if (!locationId) continue;
      out.push({
        locationId,
        subscriptionItemId: item.id,
        plan: planForPriceId(item.price?.id),
        currentPeriodEnd: item.current_period_end
          ? new Date(item.current_period_end * 1000).toISOString() : null,
      });
    }
    return out;
  }

  /**
   * 挑出**这家店**的那个 item。
   *
   * ⚠️ 退化到 `items.data[0]` 只在「这条订阅只有一个 item」时才是对的。
   * 多 item 时 Stripe 不保证列表顺序，取 `[0]` 会让主店的套餐被第二家店的
   * item 静默改掉 —— 而账单上看不出来，只有额度会突然变多或变少。
   */
  function itemForLocation(
    sub: Stripe.Subscription, locationId: string,
  ): Stripe.SubscriptionItem | undefined {
    const items = sub.items?.data ?? [];
    const own = items.find((i) => i.metadata?.['gf_location_id'] === locationId);
    if (own) return own;
    return items.length === 1 ? items[0] : undefined;
  }

  async function syncSubscription(
    sub: Stripe.Subscription, ctx: CommandContext, eventId: string,
  ): Promise<void> {
    const item = itemForLocation(sub, ctx.locationId);
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
      // Stripe retains historical trial_end after conversion; only a trialing
      // subscription may grant trial entitlements locally.
      trialEndsAt: sub.status === 'trialing' && sub.trial_end
        ? new Date(sub.trial_end * 1000).toISOString() : null,
      /**
       * ⭐ 期末取消。Stripe 在这种情况下 **status 仍然是 active** ——
       * 只有这两列能表达「还能用，但到期即止」。不镜像的话界面会一直
       * 显示「下次扣款 X 日」，直到那天突然全店冻结。
       */
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
      /**
       * ⭐⭐ 整条订阅上每家店的 item。**兄弟门店全靠它。**
       *
       * 一条 `customer.subscription.*` 只解析得出一家门店（metadata 里写的
       * 那一家）。不把这份映射交给命令的话，多店老板退订之后只有锚点店
       * 变成 canceled，第二家店永远停在 active —— 继续开单、继续烧 AI 额度。
       */
      items: itemsByLocation(sub),
      sourceEventId: eventId,
    }, ctx, { systemOrigin: 'stripe_webhook' });

    // Stripe remains paid-state truth for the card on file. Checkout subscription
    // mode sets subscription.default_payment_method; setup-mode Checkout writes
    // the same local columns via billing.savePaymentMethod. Do not invent a PM.
    await persistStripeDefaultPaymentMethod(sub, ctx);
  }

  /**
   * 把 Stripe 那边的默认支付方式投影到 `billing_accounts`，**双向**（AUD-07）。
   *
   * ## 原来只有一个方向
   *
   * `if (!resolved) return;` —— Stripe 有卡就写下来，Stripe 没卡就什么都不做。
   * 于是老板在 Stripe 客户门户里把卡删了之后：
   *   · 界面继续显示「Visa ···· 4242」，而 Stripe 那边一张卡都没有
   *   · 自动续充继续拿这个已经 detach 的 pm 去扣，一路失败到熔断
   *
   * 那次修复（QA-004）针对的是「投影缺失」，所以只补了「有 → 写」。
   * 但不变量是**本地投影等于 Stripe**，等号两边都要成立。
   *
   * ## 为什么订阅上没有卡不等于客户没有卡
   *
   * Checkout 的 subscription 模式会设 `subscription.default_payment_method`；
   * 而 setup 模式绑卡走的是 `customer.invoice_settings.default_payment_method`，
   * 订阅那一列**一直是空的**。只看订阅就清空的话，
   * 每来一条 `customer.subscription.updated` 都会把 setup 模式绑的卡抹掉一次。
   *
   * 所以判据是两级：订阅上没有 → 再问客户；两边都没有 → 才真的清空。
   */
  /**
   * 客户级默认支付方式。setup 模式绑的卡落在这里，不在订阅上。
   *
   * 取不到（网络抖动、权限、客户被删）时返回 `undefined` 而不是 null ——
   * 调用方据此**保持原样**，不清空。把「问不到」当成「没有」会在
   * 一次 Stripe 抖动之后把老板的卡从界面上抹掉。
   */
  async function customerDefaultPaymentMethod(
    customer: Stripe.Subscription['customer'],
  ): Promise<{ id: string; label: string | null } | null | undefined> {
    const customerId = typeof customer === 'string' ? customer : customer?.id;
    if (!customerId) return undefined;
    let c: Stripe.Customer | Stripe.DeletedCustomer;
    try {
      c = await stripeClient().customers.retrieve(customerId);
    } catch {
      // 问不到 ≠ 没有。返回 undefined 让调用方保持原样。
      return undefined;
    }
    if (c.deleted) return undefined;
    const out = stripeDefaultPaymentMethod(c.invoice_settings?.default_payment_method ?? null);
    if (!out) return null;          // 问到了，答案是「没有」
    if (out.label) return out;
    try {
      const full = await stripeClient().paymentMethods.retrieve(out.id);
      return { id: out.id, label: paymentMethodLabel(full) };
    } catch {
      // id 是 Stripe 事实，label 只是显示用
      return out;
    }
  }

  async function persistStripeDefaultPaymentMethod(
    sub: Stripe.Subscription, ctx: CommandContext,
  ): Promise<void> {
    let resolved = stripeDefaultPaymentMethod(sub.default_payment_method);

    if (!resolved) {
      const fromCustomer = await customerDefaultPaymentMethod(sub.customer);
      // undefined = 问不到（Stripe 抖了 / 客户被删）。什么都不做，保持原样 ——
      // 一次网络抖动不该把老板界面上的卡抹掉。
      if (fromCustomer === undefined) return;
      resolved = fromCustomer;
    }

    if (!resolved) {
      // 订阅上没有、客户上也没有 = Stripe 真的没有卡了（多半是老板在
      // 客户门户里把卡删了）。把本地投影清掉，等号两边才成立。
      // `billing.savePaymentMethod` 接受 null，并会把 label 一起清干净。
      await dispatch('billing.savePaymentMethod', {
        paymentMethodId: null,
        label: null,
      }, ctx, { systemOrigin: 'stripe_webhook' });
      return;
    }

    let label = resolved.label;
    if (!label) {
      try {
        const pm = await stripeClient().paymentMethods.retrieve(resolved.id);
        label = paymentMethodLabel(pm);
      } catch {
        // Id is Stripe truth. Label is display-only; retrieve may be unavailable
        // in signed-webhook unit tests that expand the payment method inline.
      }
    }

    await dispatch('billing.savePaymentMethod', {
      paymentMethodId: resolved.id,
      label,
    }, ctx, { systemOrigin: 'stripe_webhook' });
  }
}

export { maybeAutoTopup, safeReturnUrls, safePortalReturnUrl, resolveWebhookTenant };
export type { QuotaUnit };
