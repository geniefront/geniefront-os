/**
 * 计费命令（Phase 2，决策 8 / `04` §4.1）
 *
 * ## 两种额度，各自独立，不能互换
 *
 *   · **AI 积分**（`credit`）—— 副驾、拍照开店，一切走模型的操作
 *   · **AI 语音分钟**（`voice_minute`）—— AI 接电话
 *
 * ⚠️ 这一组命令里**没有任何换算**。一分钟电话的成本是一次副驾操作的
 * 6.2 倍，只要两者能换，客户就会把额度全换成最贵的那种用（决策 8）。
 *
 * ## 为什么这里几乎全是 `exposed: false`
 *
 * 副驾**一条计费命令都不该会用**。它是给前台调度用的助手，而调 Stripe 的钱
 * 是老板一个人的事 —— 让模型有能力触发一次扣款，等于把「今天扣了我 $50」
 * 这种电话的解释权交给一段自然语言。
 *
 * ## 为什么「创建 Checkout」不是一条命令
 *
 * 命令跑在数据库事务里（bus.ts）。调 Stripe 是几百毫秒到几秒的外部 IO，
 * 塞进事务等于让一个连接和一个快照被占住那么久 —— 和
 * `POST /v1/blueprint/:id/extract` 那条路由躲开的是同一个坑。
 *
 * 所以分工是：**HTTP 路由做编排（调 Stripe），命令做落库**。
 * 宪法第 1 条守的是「写操作必须是命令」—— 每一次额度变动、每一次订阅状态
 * 变化仍然是一条有审计、有幂等、有 RLS 的命令，守住了。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents } from '../command.js';

/** 两种额度单位。**没有第三种，也没有互换** */
export const quotaUnit = z.enum(['credit', 'voice_minute']);
export type QuotaUnitInput = z.infer<typeof quotaUnit>;

/** 和 Stripe 后台的产品名对齐：Essential $99 / Growth $199 */
export const billingPlan = z.enum(['essential', 'growth']);
/**
 * `none` = 从未接过计费（迁移 0085）。
 *
 * 它和 `trialing` 必须分开：计费账户行会在任何一次记账时被自动建出来，
 * 默认值原来是 `trialing` —— 于是一家从没进过 Stripe 的门店会按
 * essential 档白拿一整份套餐内额度。`none` 不冻结写入，只把套餐内额度归零。
 */
export const subscriptionStatus = z.enum([
  'none', 'trialing', 'active', 'past_due', 'canceled',
]);

// ─────────────────────────────────────────────────────────────── 老板可见

/**
 * 开关某一种额度的自动续充，并设触发线。
 *
 * **没有「充多少」这个设置** —— 每次固定 $50（1000 积分 / 200 分钟）。
 * 少一个可调项就少一处能填错的地方。
 *
 * 这是整组里唯一给副驾看的命令，而且必须确认 —— 它决定「什么时候自动
 * 从老板卡上扣钱」，改错一个数字的后果要到账单出来才被发现。
 */
export const SetAutoTopup = defineCommand({
  name: 'billing.setAutoTopup',
  input: z.object({
    unit: quotaUnit,
    enabled: z.boolean(),
    /** 余额低于这个数（**单位数，不是钱**）就自动充 $50 */
    thresholdUnits: z.number().int().min(0).max(5000),
  }),
  output: z.object({
    unit: quotaUnit,
    enabled: z.boolean(),
    thresholdUnits: z.number().int(),
    /** 重新打开时把失败计数清零 —— 老板换了张卡就该重新给机会 */
    failuresReset: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description:
      '打开或关闭某一种 AI 额度（积分 credit / 语音分钟 voice_minute）的自动续充，' +
      '并设置触发线。每次固定充 $50。这会影响什么时候从老板的卡上扣钱。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────── 内部：Stripe 回写

/**
 * 把 Stripe 那边的客户 / 订阅状态同步回来。
 *
 * 所有字段可选 = 局部更新。三个调用点各只带自己知道的那几个。
 *
 * ⚠️ `null` 的含义**按字段分两类**（实现里有长注释）：
 *   · **id 类**（customer / subscription）：null = 明确清空
 *   · **枚举类**（plan / status）：null = 认不出来，**保持原样**。
 *     把未知 price 写成 essential 会让付 Growth 钱的客户被静默降档
 */
export const SyncSubscription = defineCommand({
  name: 'billing.syncSubscription',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    stripeCustomerId: z.string().max(80).nullable().optional(),
    stripeSubscriptionId: z.string().max(80).nullable().optional(),
    plan: billingPlan.nullable().optional(),
    subscriptionStatus: subscriptionStatus.nullable().optional(),
    currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
    /**
     * 试用结束时刻（sql/0039）。这是 **id 类**语义：
     * `null` = 明确清空（试用转正了，Stripe 那边 trial_end 就没了）。
     */
    trialEndsAt: z.string().datetime({ offset: true }).nullable().optional(),

    /**
     * 期末取消（sql/0085）。**布尔类语义**：`undefined` = 没带这个信息，
     * 保持原样；`true` / `false` 都是明确的事实。
     *
     * ⚠️ 老板在客户门户点「取消」时，Stripe 的 status **仍然是 active** ——
     * 只有这两列能表达「还能用，但到期即止」。
     */
    cancelAtPeriodEnd: z.boolean().optional(),
    cancelAt: z.string().datetime({ offset: true }).nullable().optional(),

    /**
     * ⭐ 这条订阅上每个 item 分别属于哪家门店（sql/0085）。
     *
     * 多店共用同一条订阅，一家店一个 item。没有这一份映射的话，
     * 一条 `customer.subscription.updated` 只能落到解析出来的那一家店上，
     * 而**兄弟门店的订阅状态从此永不更新** —— 老板退订之后第二家店
     * 仍然是 active，继续免费开单、继续烧 AI 额度。
     *
     * 给了这一份，命令就能把状态广播给同一条订阅上的每一家店，
     * 同时让每家店按**自己那个 item** 落套餐与账期。
     */
    items: z.array(z.object({
      locationId: uuid,
      subscriptionItemId: z.string().max(80),
      /** 认不出的 price 给 null —— 语义同 plan：保持原样，不静默降档 */
      plan: billingPlan.nullable().optional(),
      currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
    })).max(200).optional(),

    sourceEventId: z.string().max(80).nullable().optional(),
  }),
  output: z.object({
    accountId: uuid,
    plan: z.string(),
    subscriptionStatus: z.string(),
    /** 续期时套餐内额度被清零了 */
    includedReset: z.boolean(),
    /** 这次一并同步了几家兄弟门店（多店共用一条订阅时 > 0） */
    siblingsSynced: z.number().int(),
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
 * 这个系统里永远不出现卡号、CVV、有效期。
 */
export const SavePaymentMethod = defineCommand({
  name: 'billing.savePaymentMethod',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    paymentMethodId: z.string().max(80).nullable(),
    /** 给人看的一句话，例如 `Visa ···· 4242`。只是显示，不参与判断 */
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
    exposed: false,   // 副驾永远不该碰支付方式，连解绑都不行
  },
  reversible: false,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────────── 额度账本

/**
 * 记一笔充值。**由路由在 Stripe 真的扣款成功之后调**。
 *
 * `idempotency: 'required'` 不是走过场：Stripe 那边成功了、我们这边写库失败
 * 然后重试，是一定会发生的场景。幂等键用 PaymentIntent id。
 */
export const RecordTopup = defineCommand({
  name: 'billing.recordTopup',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    unit: quotaUnit,
    /** 买到多少单位（$50 = 1000 积分 或 200 分钟） */
    units: z.number().int().positive().max(100_000),
    /** 实付多少分。对账时和 Stripe 那边比 */
    paidCents: cents.positive(),
    /** `pi_…`。手工补账（没有对应扣款）时才允许为 null */
    stripePaymentIntentId: z.string().max(80).nullable(),
    /** manual = 老板自己点的；auto = 自动续充触发的 */
    trigger: z.enum(['manual', 'auto']),
  }),
  output: z.object({
    ledgerId: uuid,
    unit: quotaUnit,
    balanceAfter: z.number().int(),
    /** 这一笔之前就记过了（幂等命中 / 同一个 PaymentIntent 已入账） */
    alreadyRecorded: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）把一笔已经扣款成功的充值记进额度账本。',
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
 * 所以这条命令在事务里拿 advisory lock、重新判一次 `shouldAutoTopup()`、
 * **当场把 last_at 写成现在** —— 冷却窗口从这一刻开始算。
 *
 * 代价是：Stripe 那边扣失败时这次冷却是白占的（十分钟内不再试）。
 * 这个代价是对的 —— 卡被拒的时候，最不该做的事就是马上再试一次。
 */
export const ClaimAutoTopup = defineCommand({
  name: 'billing.claimAutoTopup',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({ unit: quotaUnit }),
  output: z.object({
    charge: z.boolean(),
    /** charge = false 时说明为什么。出账单纠纷时要能回答 */
    reason: z.string().nullable(),
    unit: quotaUnit,
    units: z.number().int().nullable(),
    priceCents: cents.nullable(),
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
 * 连续失败到上限就自动关掉 —— 银行看到一张卡连续被拒会直接把它冻了，
 * 那时候我们不只是没收到钱，是把客户的卡搞停了。
 */
export const RecordTopupFailure = defineCommand({
  name: 'billing.recordTopupFailure',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    unit: quotaUnit,
    /** Stripe 的 decline_code / code。**不是**给客人看的原文 */
    reason: z.string().max(120),
  }),
  output: z.object({
    unit: quotaUnit,
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

/**
 * 把一张 Stripe 发票落库（sql/0085）。
 *
 * ## 为什么要存一份
 *
 * `billing_invoices` 从 0052 起**只有读的一侧**，没有任何一条 webhook
 * 往里写 —— 于是「订阅发票」那一页永远是空的，而老板问的第一个问题
 * 就是「上个月扣的那 $99 有没有单据」。
 *
 * ## 存什么、不存什么
 *
 * 只存对账要用的那几个字段 + 一个 `hostedInvoiceUrl`。
 * **不自己排版 PDF**：税、优惠、按比例摊分这些 Stripe 已经算好了，
 * 我们再算一遍必然对不上，而对不上的那几分钱会让老板怀疑整套账。
 *
 * 幂等键是 `stripeInvoiceId` —— invoice.* 同样是「至少一次」投递。
 */
export const RecordInvoice = defineCommand({
  name: 'billing.recordInvoice',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    stripeInvoiceId: z.string().max(80),
    invoiceNumber: z.string().max(80),
    /** 账期，给人看的一行字，例如 `2026-08-01 – 2026-08-31` */
    period: z.string().max(80),
    description: z.string().max(200),
    amountCents: cents,
    status: z.enum(['paid', 'pending', 'failed']),
    /** 发票日期（YYYY-MM-DD）。存文本是为了和 0052 建表时的口径一致 */
    date: z.string().max(20),
    hostedInvoiceUrl: z.string().max(500).nullable().optional(),
    receiptPdfUrl: z.string().max(500).nullable().optional(),
  }),
  output: z.object({
    invoiceId: uuid,
    alreadyRecorded: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）把一张 Stripe 发票记进本地发票表。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 冲销一笔已经入账的充值（退款或拒付）。
 *
 * ⭐ **写一条反向流水，不改原来那一行。** 账本是只追加的（sql/0018 的
 * `ledger_append_only` 触发器连 update 都不给）—— 「为什么少了 1000 积分」
 * 这个问题必须能从流水上一眼看出来，而不是靠猜。
 *
 * ⚠️ 余额允许被冲成负数。客户拿走了额度又把钱要了回去，那个负数
 * 就是事实本身；抹平它等于替他把账做平（见 `allocateQuota` 的长注释）。
 */
export const RecordTopupReversal = defineCommand({
  name: 'billing.recordTopupReversal',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    /** 被冲销的那一笔充值的 PaymentIntent。找不到对应流水就什么都不做 */
    stripePaymentIntentId: z.string().max(80),
    /** refund = 退款；dispute = 拒付。两者的客服话术完全不同 */
    reason: z.enum(['refund', 'dispute']),
  }),
  output: z.object({
    reversed: z.boolean(),
    unit: quotaUnit.nullable(),
    units: z.number().int().nullable(),
    balanceAfter: z.number().int().nullable(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '（内部）为一笔被退款或拒付的充值写一条反向流水。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * Kept registered for API compatibility. The handler refuses without
 * mutating paid state until a Stripe Checkout / Portal path exists.
 * Do not reimplement as a local writer of plan or invoices.
 */
export const BillingChangePlan = defineCommand({
  name: 'billing.changePlan',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    targetPlan: z.enum(['starter', 'growth', 'enterprise', 'essential']),
    billingCycle: z.enum(['monthly', 'annual']).default('monthly'),
  }),
  output: z.object({
    success: z.boolean(),
    targetPlan: z.string(),
    billingCycle: z.string(),
    proratedChargeCents: cents,
    effectiveImmediately: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '变更或升降级 SaaS 订阅套餐版本与计费周期。',
    confirm: 'always',
    exposed: false,
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * Kept registered for API compatibility. The handler refuses without
 * granting credits or inserting a paid invoice. Buy packs via Stripe
 * topup / Checkout; ledger writes belong to `billing.recordTopup`.
 */
export const BillingBuyAddon = defineCommand({
  name: 'billing.buyAddon',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    addonType: z.enum(['voice_minutes_100', 'copilot_credits_500', 'marketing_sms_1000']),
    priceCents: cents.positive(),
  }),
  output: z.object({
    success: z.boolean(),
    addonType: z.string(),
    priceCents: cents,
    invoiceId: uuid,
    invoiceNumber: z.string(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '增购即时 AI 语音分钟包、副驾算力包或营销短信包。',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

export const BillingSaveTaxProfile = defineCommand({
  name: 'billing.saveTaxProfile',
  input: z.object({
    legalEntityName: z.string().trim().min(1, '公司/法定实体名称不能为空').max(200),
    taxId: z.string().trim().min(1, 'EIN / 纳税人识别号不能为空').max(100),
    billingEmail: z.string().trim().email('财务发票邮箱格式不正确'),
  }),
  output: z.object({
    saved: z.boolean(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '保存企业发票与税务登记信息（EIN 纳税人识别号与财务邮箱）。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const BILLING_COMMANDS = [
  SetAutoTopup,
  SyncSubscription,
  SavePaymentMethod,
  RecordTopup,
  ClaimAutoTopup,
  RecordTopupFailure,
  BillingChangePlan,
  BillingBuyAddon,
  BillingSaveTaxProfile,
  RecordInvoice,
  RecordTopupReversal,
] as const;
