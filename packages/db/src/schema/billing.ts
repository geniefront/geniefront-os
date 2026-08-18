/**
 * 计费：固定套餐月费 + 预充值余额 + 自动续充（Phase 2，决策 8 / 04 §4.1）
 *
 * ## 为什么是「月费 + 预充值」两条腿
 *
 * 决策 8 定的是「门店月费 + AI 分离计费」。月费是 Stripe 订阅，稳定可预测；
 * 而 AI 用量（副驾 / 电话分钟）成本差一个数量级，**必须分开卖**，
 * 否则电话量大的店会把额度全用在最贵的地方。
 *
 * 预充值余额就是那个「分开卖」的载体：用多少扣多少，扣的是**真实成本**
 * 折算出来的钱，而不是一个抽象的「次数」。
 *
 * ## 三条不能破的纪律
 *
 * 1. **金额只用整数分**（宪法第 4 条）。余额、充值、扣费全是 int。
 * 2. **账本只追加，不修改**（宪法第 9 条）。冲一笔账要写一条反向记录，
 *    不是把原来那条改掉 —— 否则「为什么少了 $12」永远查不清。
 * 3. **余额是账本算出来的**，`billing_accounts.balance_cents` 只是缓存。
 *    两者对不上时以账本为准，而且有测试盯着它们一致。
 */

import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex,
  bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * 一家店一个计费账户（决策 10：一店一订阅）。
 *
 * 为什么不做成 org 级：一个老板有三家店，其中一家生意差要降档 ——
 * org 级的话他只能整体降。而且多店老板最想看的恰恰是
 * 「哪家店在烧钱」，账挂在 org 上就再也拆不开。
 */
export const billingAccounts = pgTable('billing_accounts', {
  id: id(),
  orgId: orgCol(),
  locationId: uuid('location_id').notNull().references(() => locations.id),

  /** Stripe 的客户与订阅。null = 还没接上（试用期） */
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  /** essential | growth。**和 Stripe 后台的产品名对齐**（迁移 0021） */
  plan: text('plan').notNull().default('essential'),
  /** trialing | active | past_due | canceled */
  subscriptionStatus: text('subscription_status').notNull().default('trialing'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),

  /**
   * 自动续充要用的那张卡。
   *
   * ⚠️ 存的是 Stripe 的 payment_method id，**不是卡号**。
   * 这个系统里永远不出现卡号、CVV、有效期 —— 那是 PCI 范围，
   * 碰一下整个合规成本就是另一个量级（决策 3 的同一条精神）。
   */
  defaultPaymentMethodId: text('default_payment_method_id'),
  /** 给人看的：`Visa ···· 4242`。只是显示，不参与任何逻辑 */
  paymentMethodLabel: text('payment_method_label'),

  /**
   * ⚠️ 上一版的「钱余额」。**列留着但不再写**（宪法第 9 条：财务数据不删）。
   * 历史那几行是真实发生过的钱。从迁移 0023 起改成两种额度，见下面两列。
   */
  balanceCents: integer('balance_cents').notNull().default(0),
  autoTopupEnabled: boolean('auto_topup_enabled').notNull().default(false),
  autoTopupThresholdCents: integer('auto_topup_threshold_cents').notNull().default(1000),
  autoTopupAmountCents: integer('auto_topup_amount_cents').notNull().default(10000),
  lastAutoTopupAt: timestamp('last_auto_topup_at', { withTimezone: true }),
  autoTopupFailures: integer('auto_topup_failures').notNull().default(0),

  // ── 充值买来的两种额度（迁移 0023）────────────────────────────────────
  //
  // ⚠️ **两种额度不能互换**。一分钟电话的成本是一次副驾操作的 6.2 倍，
  // 只要能换，客户就会把额度全换成最贵的那种用 —— 而那恰恰是最忙、
  // 最该赚钱的客户（决策 8）。代码里没有任何换算函数，别加。
  //
  // 这两个都是**账本的缓存**，事实在 credit_ledger 里。
  /** AI 积分余额（充值买的，不过期）。1 积分 ≈ $0.01 的真实成本 */
  creditBalance: integer('credit_balance').notNull().default(0),
  /** AI 语音分钟余额（充值买的，不过期） */
  voiceMinuteBalance: integer('voice_minute_balance').notNull().default(0),

  // ── 套餐内额度（先用套餐里的，用完了才扣充值余额）──────────────────────
  /** 本期已用的套餐内积分。跟着 Stripe 的续期清零 */
  includedCreditsUsed: integer('included_credits_used').notNull().default(0),
  /** 本期已用的套餐内语音分钟 */
  includedMinutesUsed: integer('included_minutes_used').notNull().default(0),

  // ── 自动续充：两种额度各一套，每次都是 $50 ────────────────────────────
  //
  // 没有「充多少」这个设置 —— 只有「低于多少就充」。少一个可调项
  // 就少一处能填错的地方。`last_at` 用来防「续充风暴」：卡被拒时
  // 一晚上能触发几十次扣款尝试，而银行看到连续失败会把卡冻了。
  autoTopupCreditsEnabled: boolean('auto_topup_credits_enabled').notNull().default(false),
  autoTopupCreditsThreshold: integer('auto_topup_credits_threshold').notNull().default(50),
  autoTopupCreditsLastAt: timestamp('auto_topup_credits_last_at', { withTimezone: true }),
  autoTopupCreditsFailures: integer('auto_topup_credits_failures').notNull().default(0),
  autoTopupMinutesEnabled: boolean('auto_topup_minutes_enabled').notNull().default(false),
  autoTopupMinutesThreshold: integer('auto_topup_minutes_threshold').notNull().default(20),
  autoTopupMinutesLastAt: timestamp('auto_topup_minutes_last_at', { withTimezone: true }),
  autoTopupMinutesFailures: integer('auto_topup_minutes_failures').notNull().default(0),
  /**
   * 本期从什么时候开始算。
   *
   * 清零跟着 **Stripe 的续订**走（`customer.subscription.updated` 里
   * current_period_end 变了就重置），不自己数日子 ——
   * 自己数就一定会和 Stripe 的账单周期漂开，而漂开之后
   * 「这个月到底还剩几次」谁也说不清。
   */
  includedPeriodStart: timestamp('included_period_start', { withTimezone: true }),

  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('billing_accounts_location_key').on(t.locationId),
  index('billing_accounts_topup_idx').on(t.autoTopupEnabled, t.balanceCents),
]);

/**
 * 余额账本 —— **只追加，永不修改**（宪法第 9 条）。
 *
 * 每一行都记下「这一笔之后余额是多少」。这样对账时不用把整张表加起来，
 * 而且任何一行被改动都会立刻和相邻行对不上 —— 篡改是看得见的。
 *
 * 一条硬规则：**扣费永远走这里，不许直接 update 余额**。
 * 直接改余额的那一刻，「钱去哪了」就变成了一个没有答案的问题。
 */
export const creditLedger = pgTable('credit_ledger', {
  id: id(),
  /**
   * ⭐ 账本顺序的**事实来源**（迁移 0019）。
   *
   * 不用 `created_at` 排序：Postgres 的 `now()` 返回的是**事务开始时刻**，
   * 并发扣费时两行的 balance_after 按提交顺序串好了，按 created_at 排却是
   * 反的 —— 对账当场报一个根本不存在的断点，而且每次位置都不一样，
   * 看起来完全像是有人在篡改账本。
   *
   * bigserial 在插入那一刻取号，而插入必然在拿到行锁之后，
   * 所以它和 balance_after 的链条严格一致。
   */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  orgId: orgCol(),
  locationId: uuid('location_id').notNull().references(() => locations.id),

  /**
   * topup        充值（+）
   * usage        AI 用量扣费（−）
   * refund       退款（+）
   * adjustment   人工调整（±，必须写原因）
   * reversal     冲销某一笔（±）
   */
  kind: text('kind').notNull(),
  /**
   * ⚠️ 上一版的「钱」两列。**留着不删**（宪法第 9 条），但从迁移 0023
   * 起不再写入 —— 新的账目走下面的 unit / amount / balance_after。
   */
  amountCents: integer('amount_cents'),
  balanceAfterCents: integer('balance_after_cents'),

  /** credit | voice_minute。**两种额度各有各的链条，对账要分开算** */
  unit: text('unit').notNull().default('credit'),
  /** 有符号的单位数。充值为正，扣费为负 */
  amount: integer('amount'),
  /** 这一笔之后该单位的余额。对账靠它，不用把整张表加起来 */
  balanceAfter: integer('balance_after'),
  /** 充值时付了多少钱。用量扣费为 null —— 那一笔没有钱经手 */
  paidCents: integer('paid_cents'),

  /** ai_assist | ai_call_min | sms | email | manual | stripe */
  source: text('source'),
  /** 扣费对应的那条 usage_events，能一路查回「这 3 分钱是哪次调用」 */
  usageEventId: uuid('usage_event_id'),

  stripePaymentIntentId: text('stripe_payment_intent_id'),
  /** 冲销指向被冲销的那一条 */
  reversalOfId: uuid('reversal_of_id'),
  /** adjustment / reversal 必填 —— 没有原因的调账是查不清的账 */
  reason: text('reason'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),

  createdAt: createdAt(),
}, (t) => [
  index('credit_ledger_account_idx').on(t.locationId, t.createdAt),
  index('credit_ledger_usage_idx').on(t.usageEventId),
  // 对账与翻流水都按 seq，不按时间（见上面 seq 的长注释）
  index('credit_ledger_seq_idx').on(t.locationId, t.seq),
  // 两种额度分开对账
  index('credit_ledger_unit_idx').on(t.locationId, t.unit, t.seq),
]);

/**
 * 处理过的 Stripe 事件。
 *
 * ⚠️ **Stripe 会重投 webhook**，而且明确说了「至少一次」投递。
 * 不去重的话，一次 `payment_intent.succeeded` 会给客户充值两次 ——
 * 这次是我们亏钱，反过来（扣费重复）就是多收客户的钱。两个方向都不能接受。
 */
export const stripeEvents = pgTable('stripe_events', {
  /** Stripe 的 event id（`evt_...`）就是主键 —— 天然幂等 */
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  locationId: uuid('location_id').references(() => locations.id),
  /**
   * ⚠️ **不能用上面那个 `createdAt()` helper** —— 它把列名写死成 `created_at`。
   *
   * 写成 `processedAt: createdAt()` 的话，字段叫 processedAt、列却叫
   * created_at，而且 typecheck、迁移、运行时全都不报错（插入时走默认值，
   * 没人显式写这一列），一直到有人写 `where processed_at > …` 才炸。
   * 这是 10-HANDOFF §4.1 那个坑的第二次发作；迁移 0020 把列名改回来了。
   */
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  /** 处理时出的错。留着是为了能回头补处理，而不是让事件默默消失 */
  error: text('error'),
});
