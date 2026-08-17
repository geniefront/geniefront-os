/**
 * 计费命令（Phase 2，决策 8 / 04 §4.1）
 *
 * ## 为什么这里几乎全是 `exposed: false`
 *
 * 副驾**一条计费命令都不该会用**。它是给前台调度用的助手，而调 Stripe 的钱
 * 是老板一个人的事 —— 让模型有能力触发一次扣款，等于把「今天扣了我 $200」
 * 这种电话的解释权交给一段自然语言。
 * 唯一暴露的是 `billing.setAutoTopup`，而它 `confirm: 'always'`。
 *
 * ## 为什么「创建 Checkout」不是一条命令
 *
 * 命令跑在数据库事务里（bus.ts）。调 Stripe 是几百毫秒到几秒的外部 IO，
 * 塞进事务等于让一个连接和一个快照被占住那么久 —— 和
 * `POST /v1/blueprint/:id/extract` 那条路由躲开的是同一个坑（server.ts 有长注释）。
 *
 * 所以分工是：**HTTP 路由做编排（调 Stripe），命令做落库**。
 * 宪法第 1 条守的是「写操作必须是命令」—— 每一次余额变动、每一次订阅状态
 * 变化仍然是一条有审计、有幂等、有 RLS 的命令，守住了。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents } from '../command.js';

/**
 * 自动续充的三档。**只有这三个值合法**（DB 的 `billing_topup_tier` 约束兜底）。
 *
 * 让客户填任意金额会引来拿被盗的卡试活的人：$0.53、$1.07 这种试探性小额
 * 是盗卡验证的标准手法，而我们这边看起来只是一笔正常充值。
 */
export const topupTier = z.union([
  z.literal(5000), z.literal(10000), z.literal(20000),
]);

export const billingPlan = z.enum(['starter', 'pro']);
export const subscriptionStatus = z.enum(['trialing', 'active', 'past_due', 'canceled']);

// ─────────────────────────────────────────────────────────────── 老板可见

/**
 * 开关自动续充 + 设阈值和档位。
 *
 * 这是整组里唯一给副驾看的命令，而且必须确认 —— 它决定「什么时候自动
 * 从老板卡上扣钱」，改错一个数字的后果要到账单出来才被发现。
 */
export const SetAutoTopup = defineCommand({
  name: 'billing.setAutoTopup',
  input: z.object({
    enabled: z.boolean(),
    /** 余额低于这个数就自动充。0–$500，DB 约束兜底 */
    thresholdCents: cents.min(0).max(50_000),
    amountCents: topupTier,
  }),
  output: z.object({
    enabled: z.boolean(),
    thresholdCents: cents,
    amountCents: cents,
    /** 重新打开时把失败计数清零 —— 老板换了张卡就该重新给机会 */
    failuresReset: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description:
      '打开或关闭余额自动续充，并设置触发阈值与每次充值的档位' +
      '（只能是 $50 / $100 / $200 三档之一）。这会影响什么时候从老板的卡上扣钱。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────── 内部：Stripe 回写

/**
 * 把 Stripe 那边的客户 / 订阅状态同步回来。
 *
 * 所有字段可选 = 局部更新。三个调用点各只带自己知道的那几个：
 *   · 建 Checkout 的路由 —— 只知道 `stripeCustomerId`
 *   · `customer.subscription.*` webhook —— 订阅那几个
 *   · `checkout.session.completed` —— 两边都有
 *
 * ⚠️ `null` 的含义**按字段分两类**（实现里有长注释）：
 *   · **id 类**（customer / subscription）：null = 明确清空。退订之后
 *     确实没有订阅 id 了。
 *   · **枚举类**（plan / status）：null = 认不出来，**保持原样**。
 *     把一个未知 price 写成 starter 会让付 Pro 钱的客户被静默降档，
 *     而账单上完全看不出来。
 */
export const SyncSubscription = defineCommand({
  name: 'billing.syncSubscription',
  input: z.object({
    stripeCustomerId: z.string().max(80).nullable().optional(),
    stripeSubscriptionId: z.string().max(80).nullable().optional(),
    plan: billingPlan.nullable().optional(),
    subscriptionStatus: subscriptionStatus.nullable().optional(),
    /** 订阅当期结束时刻（ISO）。前台显示「下次扣费 9 月 16 日」用 */
    currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
    /** 这条同步是哪个 Stripe 事件带来的，留着好查 */
    sourceEventId: z.string().max(80).nullable().optional(),
  }),
  output: z.object({
    accountId: uuid,
    plan: z.string(),
    subscriptionStatus: z.string(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）把 Stripe 的订阅状态同步进本地账户。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 记住那张用于自动续充的卡。
 *
 * ⚠️ 存的是 Stripe 的 `payment_method` id，**不是卡号**。
 * 这个系统里永远不出现卡号、CVV、有效期。`label` 只是给人看的
 * 「Visa ···· 4242」，不参与任何判断 —— 判断有没有卡看的是 id 是否为空。
 */
export const SavePaymentMethod = defineCommand({
  name: 'billing.savePaymentMethod',
  input: z.object({
    /** `pm_…`。传 null = 解绑 */
    paymentMethodId: z.string().max(80).nullable(),
    /** 给人看的一句话，例如 `Visa ···· 4242` */
    label: z.string().max(60).nullable().optional(),
  }),
  output: z.object({
    hasPaymentMethod: z.boolean(),
    label: z.string().nullable(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）记下老板绑定的支付方式 id。',
    confirm: 'always',
    // 副驾永远不该碰支付方式 —— 连解绑都不行
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────────── 余额账本

/**
 * 记一笔充值。**由路由在 Stripe 真的扣款成功之后调**。
 *
 * `idempotency: 'required'` 不是走过场：Stripe 那边成功了、我们这边写库失败
 * 然后重试，是一定会发生的场景。幂等键用 PaymentIntent id ——
 * 同一笔扣款无论重放多少次，账本上只会有一条。
 */
export const RecordTopup = defineCommand({
  name: 'billing.recordTopup',
  input: z.object({
    amountCents: cents.positive(),
    /** `pi_…`。手工调账（没有对应扣款）时才允许为 null */
    stripePaymentIntentId: z.string().max(80).nullable(),
    /** manual = 老板自己点的；auto = 自动续充触发的 */
    trigger: z.enum(['manual', 'auto']),
  }),
  output: z.object({
    ledgerId: uuid,
    balanceAfterCents: cents,
    /** 这一笔之前就记过了（幂等命中 / 同一个 PaymentIntent 已入账） */
    alreadyRecorded: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）把一笔已经扣款成功的充值记进余额账本。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'required',
});

/**
 * 认领一次自动续充：**先占位，再去扣钱**。
 *
 * ⭐ 顺序反过来（先扣钱再占位）会在并发时重复扣款：两个请求同时看到
 * 余额低于阈值，各自去 Stripe 扣一笔 $50，老板一分钟内被扣两次。
 * 所以这条命令在事务里拿 advisory lock、重新判一次
 * `shouldAutoTopup()`、**当场把 `last_auto_topup_at` 写成现在** ——
 * 冷却窗口从这一刻开始算，第二个请求进来会被 `cooling_down` 挡掉。
 *
 * 代价是：Stripe 那边扣失败时，这一次冷却是白占的（十分钟内不再试）。
 * 这个代价是对的 —— 卡被拒的时候，最不该做的事就是马上再试一次。
 */
export const ClaimAutoTopup = defineCommand({
  name: 'billing.claimAutoTopup',
  input: z.object({}),
  output: z.object({
    charge: z.boolean(),
    /** charge = false 时说明为什么。出账单纠纷时要能回答「那天为什么没充上」 */
    reason: z.string().nullable(),
    amountCents: cents.nullable(),
    stripeCustomerId: z.string().nullable(),
    paymentMethodId: z.string().nullable(),
    /** 给 Stripe 的幂等键，由冷却窗口分桶 —— 重试风暴里复用同一个 */
    idempotencyKey: z.string().nullable(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）判断并认领一次自动续充。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 自动续充扣款失败。
 *
 * 连续失败到 `MAX_TOPUP_FAILURES` 就自动关掉自动续充 —— 别再骚扰那张卡。
 * 银行看到连续失败会直接把卡冻了，那时候我们不只是没收到钱，
 * 是把客户的卡搞停了。
 */
export const RecordTopupFailure = defineCommand({
  name: 'billing.recordTopupFailure',
  input: z.object({
    /** Stripe 的 decline_code / code。**不是**给客人看的原文 */
    reason: z.string().max(120),
  }),
  output: z.object({
    failures: z.number().int(),
    /** 失败太多次，自动续充已经被关掉了 —— 前台要红着显示 */
    disabled: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）记一次自动续充失败。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

export const BILLING_COMMANDS = [
  SetAutoTopup,
  SyncSubscription,
  SavePaymentMethod,
  RecordTopup,
  ClaimAutoTopup,
  RecordTopupFailure,
] as const;
