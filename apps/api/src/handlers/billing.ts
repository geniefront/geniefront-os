/**
 * 计费命令的实现（Phase 2，决策 8）
 *
 * 这个文件里**一行 Stripe 调用都没有**。所有和 Stripe 说话的编排在
 * `apps/api/src/stripe/routes.ts`，理由写在 `commands/billing.ts` 顶部：
 * 命令跑在数据库事务里，把几秒的外部 IO 塞进事务会占住连接和快照。
 *
 * 分工是：**路由调 Stripe，命令落库。** 每一次额度变动仍然是一条
 * 有审计、有幂等、有 RLS 的命令（宪法第 1 条）。
 *
 * 三条纪律，每一条都在下面有对应的代码：
 *
 *   1. **额度只用整数**（宪法第 4 条的同一条精神）。全程不出现浮点。
 *   2. **扣额度永远走 `credit_ledger`**，不许直接 update 余额 ——
 *      直接改的那一刻，「我的积分去哪了」就变成一个没有答案的问题。
 *   3. **算额度的判断全在 `@gf/payroll/credits` 的纯函数里**（宪法第 2 条），
 *      这里只负责取数、写库、留痕。
 *
 * ⚠️ **两种额度不能互换**，这个文件里没有任何换算（决策 8）。
 */

import {
  SetAutoTopup, SyncSubscription, SavePaymentMethod,
  RecordTopup, ClaimAutoTopup, RecordTopupFailure,
  AppError, ERROR_CODES, type CommandContext,
} from '@gf/contracts';
import { ts } from '@gf/db';
import {
  shouldAutoTopup, applyEntry, unitsPerTopup, includedFor,
  MAX_TOPUP_FAILURES, TOPUP_COOLDOWN_MS, TOPUP_PRICE_CENTS,
  type QuotaUnit, type AutoTopupState, type LedgerEntryInput,
} from '@gf/payroll';
import { registerHandler, type HandlerArgs } from '../bus';
import type postgres from 'postgres';

export interface AccountRow {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  subscription_status: string;
  current_period_end: string | Date | null;
  trial_ends_at: string | Date | null;
  trial_will_end_notified_at: string | Date | null;
  default_payment_method_id: string | null;
  payment_method_label: string | null;

  credit_balance: number;
  voice_minute_balance: number;
  included_credits_used: number;
  included_minutes_used: number;
  included_period_start: string | Date | null;

  auto_topup_credits_enabled: boolean;
  auto_topup_credits_threshold: number;
  auto_topup_credits_last_at: string | Date | null;
  auto_topup_credits_failures: number;
  auto_topup_minutes_enabled: boolean;
  auto_topup_minutes_threshold: number;
  auto_topup_minutes_last_at: string | Date | null;
  auto_topup_minutes_failures: number;
}

/**
 * 每种额度在账户行上对应哪几列。
 *
 * ⭐ 集中成一张表，是为了让「加一种额度」变成改一处而不是改二十处 ——
 * 而更重要的是：**两种额度的处理必须一模一样**，散在各处写两遍
 * 迟早会漂移成「积分有冷却而分钟没有」这种只在半夜出现的 bug。
 */
const COLS: Record<QuotaUnit, {
  balance: string; includedUsed: string;
  enabled: string; threshold: string; lastAt: string; failures: string;
}> = {
  credit: {
    balance: 'credit_balance', includedUsed: 'included_credits_used',
    enabled: 'auto_topup_credits_enabled', threshold: 'auto_topup_credits_threshold',
    lastAt: 'auto_topup_credits_last_at', failures: 'auto_topup_credits_failures',
  },
  voice_minute: {
    balance: 'voice_minute_balance', includedUsed: 'included_minutes_used',
    enabled: 'auto_topup_minutes_enabled', threshold: 'auto_topup_minutes_threshold',
    lastAt: 'auto_topup_minutes_last_at', failures: 'auto_topup_minutes_failures',
  },
};

export const balanceOf = (row: AccountRow, unit: QuotaUnit): number =>
  unit === 'credit' ? row.credit_balance : row.voice_minute_balance;

export const includedUsedOf = (row: AccountRow, unit: QuotaUnit): number =>
  unit === 'credit' ? row.included_credits_used : row.included_minutes_used;

/**
 * ⭐ 在不在试用期，**看 `trial_ends_at` 是不是还在未来，不看 status**。
 *
 * Stripe 的 `trialing` 状态在扣款那一刻就变成 `active`，但我们本地这行
 * 要等 webhook 回来才更新 —— 中间那几秒如果按 status 判，
 * 客户会短暂拿到试用额度而不是他刚付钱买的那一档。
 */
export const isTrialing = (row: Pick<AccountRow, 'trial_ends_at'>, now = new Date()): boolean =>
  row.trial_ends_at !== null && new Date(ts(row.trial_ends_at)).getTime() > now.getTime();

export const includedRemainingOf = (row: AccountRow, unit: QuotaUnit): number =>
  Math.max(0, includedFor(row.plan, unit, isTrialing(row)) - includedUsedOf(row, unit));

/** postgres.js 回来的 timestamptz 可能是字符串（见 @gf/db 的 parseTs 注释） */
const toDate = (v: string | Date | null): Date | null => {
  if (v === null) return null;
  if (typeof v !== 'string') return v;
  return new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
};

/**
 * 拿这家店的计费账户，没有就建一个。
 *
 * ⚠️ **一定要自动建**：一家还在试用期、从没进过 Stripe 的店照样会产生
 * AI 用量。没有账户就没法记账，而「用量发生了但账上看不到」是最糟的
 * 那一种 —— 到月底突然冒出一笔对不上的差额。
 *
 * `on conflict do nothing` 而不是先查后插：两个请求同时给一家新店记账时，
 * 先查后插会撞唯一索引，而客户看到的是一个莫名其妙的 500。
 */
export async function ensureAccount(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  opts: { forUpdate?: boolean } = {},
): Promise<AccountRow> {
  await tx`
    insert into billing_accounts (org_id, location_id)
    values (${ctx.orgId}, ${ctx.locationId})
    on conflict (location_id) do nothing`;

  const rows = opts.forUpdate
    ? await tx<AccountRow[]>`
        select * from billing_accounts
        where location_id = ${ctx.locationId} for update`
    : await tx<AccountRow[]>`
        select * from billing_accounts where location_id = ${ctx.locationId}`;

  const row = rows[0];
  if (!row) {
    // 插了又查不到，只可能是 RLS 把它挡住了 —— 那是配置事故，不是业务分支
    throw new AppError(ERROR_CODES.INTERNAL, {
      details: { reason: 'billing_account_unreachable', locationId: ctx.locationId },
    });
  }
  return row;
}

/** DB 行 → 纯函数吃的状态。转换只有一份，免得两处各写一遍漂移 */
export function toAutoTopupState(row: AccountRow, unit: QuotaUnit): AutoTopupState {
  const isCredit = unit === 'credit';
  return {
    balance: balanceOf(row, unit),
    enabled: isCredit ? row.auto_topup_credits_enabled : row.auto_topup_minutes_enabled,
    thresholdUnits: isCredit
      ? row.auto_topup_credits_threshold : row.auto_topup_minutes_threshold,
    lastAt: toDate(isCredit ? row.auto_topup_credits_last_at : row.auto_topup_minutes_last_at),
    failures: isCredit ? row.auto_topup_credits_failures : row.auto_topup_minutes_failures,
    defaultPaymentMethodId: row.default_payment_method_id,
    subscriptionStatus: row.subscription_status,
    includedRemaining: includedRemainingOf(row, unit),
  };
}

/**
 * 记一笔账并同步余额缓存。**所有额度变动的唯一入口。**
 *
 * 账本是事实，`billing_accounts.*_balance` 只是缓存 —— 每次都从传进来的
 * 余额算，而那个值必须来自 `for update` 锁住的那一行，
 * 否则并发下两笔会算出同一个 balance_after。
 */
export async function appendLedger(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  account: AccountRow,
  entry: LedgerEntryInput & {
    source?: string | null;
    usageEventId?: string | null;
    stripePaymentIntentId?: string | null;
    paidCents?: number | null;
  },
): Promise<{ ledgerId: string; balanceAfter: number }> {
  // 纯函数把关：方向和类型对不上（「充值 −1000」）、调账没写原因、
  // 不是整数 —— 全在这里被挡下，而不是等 DB 约束报一句看不懂的话
  const applied = applyEntry(balanceOf(account, entry.unit), entry);

  const [row] = await tx<{ id: string }[]>`
    insert into credit_ledger
      (org_id, location_id, kind, unit, amount, balance_after, paid_cents,
       amount_cents, balance_after_cents,
       source, usage_event_id, stripe_payment_intent_id, reason)
    values (${ctx.orgId}, ${ctx.locationId}, ${entry.kind}, ${entry.unit},
            ${entry.amount}, ${applied.balanceAfter}, ${entry.paidCents ?? null},
            -- ⚠️ 钱那两列是上一版留下的，从 0023 起不再有意义 → 写 **null**。
            -- 写 0 是错的：0 的意思是「这笔金额是零」，而事实是
            -- 「这一笔跟钱没关系」——对账时会被读成完全不同的意思（迁移 0024）
            null, null,
            ${entry.source ?? null}, ${entry.usageEventId ?? null},
            ${entry.stripePaymentIntentId ?? null}, ${entry.reason ?? null})
    returning id`;

  const col = COLS[entry.unit].balance;
  await tx`
    update billing_accounts set ${tx(col)} = ${applied.balanceAfter}
    where id = ${account.id}`;

  return { ledgerId: row!.id, balanceAfter: applied.balanceAfter };
}

// ─────────────────────────────────────────────────────────── 自动续充设置

registerHandler(SetAutoTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetAutoTopup.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const unit = input.unit as QuotaUnit;
  const c = COLS[unit];
  const state = toAutoTopupState(acct, unit);

  /**
   * 重新打开时把失败计数清零。
   *
   * 老板来动这个开关，通常正是因为他刚换了张卡 —— 还揣着上一张卡的
   * 三次失败不放，等于他明明修好了却还是充不上，而界面上不会告诉他为什么。
   */
  const reopening = input.enabled && !state.enabled;
  const failuresReset = reopening && state.failures > 0;

  await tx`
    update billing_accounts set
      ${tx(c.enabled)} = ${input.enabled},
      ${tx(c.threshold)} = ${input.thresholdUnits},
      ${tx(c.failures)} = ${failuresReset ? 0 : state.failures}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { unit, enabled: state.enabled, thresholdUnits: state.thresholdUnits },
    after: { unit, enabled: input.enabled, thresholdUnits: input.thresholdUnits, failuresReset },
  });

  return {
    unit: input.unit,
    enabled: input.enabled,
    thresholdUnits: input.thresholdUnits,
    failuresReset,
  };
});

// ───────────────────────────────────────────────────────────── 订阅状态同步

registerHandler(SyncSubscription, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SyncSubscription.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  /**
   * 局部更新，而且 `null` 的含义**按字段分两类**：
   *
   * · **id 类**（customer / subscription）：`null` = 明确清空。
   *   退订之后确实没有订阅 id 了，这时候必须能写回 null。
   * · **枚举类**（plan / status）：`null` = 认不出来，**保持原样**。
   *   ⚠️ `planForPriceId` 认不出一个 price 时返回 null；按「明确清空」处理的话，
   *   一个付 Growth 钱的客户会被静默降档，而账单上完全看不出来。
   */
  const clearable = <T>(next: T | null | undefined, cur: T | null): T | null =>
    next === undefined ? cur : (next ?? null);

  const plan = input.plan ?? acct.plan;
  const status = input.subscriptionStatus ?? acct.subscription_status;
  const customerId = clearable(input.stripeCustomerId, acct.stripe_customer_id);
  const subscriptionId = clearable(input.stripeSubscriptionId, acct.stripe_subscription_id);

  // 时间参数一律先转成字符串再配 ::timestamptz（见 @gf/db 的 ts() 注释）
  const periodEnd: string | null = input.currentPeriodEnd === undefined
    ? (acct.current_period_end === null ? null : ts(acct.current_period_end))
    : (input.currentPeriodEnd === null ? null : ts(new Date(input.currentPeriodEnd)));

  /**
   * 试用结束时刻。**id 类语义**：`null` = 明确清空。
   *
   * 试用一旦转正，Stripe 的 `trial_end` 就不再出现在订阅对象上，
   * 这时候必须真的写回 null —— 留着旧值的话 `isTrialing()` 会一直
   * 拿它和 now 比，虽然结果也是 false，但「这家店试用到什么时候」
   * 这个问题在客服那边会得到一个早就过期的答案。
   */
  const trialEndsAt: string | null = input.trialEndsAt === undefined
    ? (acct.trial_ends_at === null ? null : ts(acct.trial_ends_at))
    : (input.trialEndsAt === null ? null : ts(new Date(input.trialEndsAt)));

  /**
   * 试用结束时刻变了 = 换了一段试用，提醒信的去重标记要跟着清掉。
   *
   * ⚠️ **按毫秒比，不能按字符串比。** 入参是客户端给的 ISO 串，
   * 库里那个是 Postgres round-trip 回来的 —— 同一个时刻两边的
   * 小数位和时区写法都可能不一样，字符串比会把「没变」判成「变了」，
   * 于是每一条重投的 trial_will_end 都会重新发一封信。
   */
  const msOf = (v: string | null): number | null => (v === null ? null : new Date(v).getTime());
  const trialChanged = msOf(trialEndsAt)
    !== msOf(acct.trial_ends_at === null ? null : ts(acct.trial_ends_at));

  /**
   * ⭐ **续期就把两种套餐内额度都清零。**
   *
   * 清零的时机跟着 Stripe 的 `current_period_end` 走，不自己数日子 ——
   * 自己数就一定会和 Stripe 的账单周期漂开，而漂开之后
   * 「这个月到底还剩几次」谁也说不清，客户和我们各算各的。
   *
   * ⚠️ 只有**往后走**才算续期。Stripe 偶尔会重投一条旧事件，
   * 那条里的 period_end 比库里的早 —— 照着它清零等于白送客户一整期额度。
   */
  const prevEnd = acct.current_period_end ? new Date(ts(acct.current_period_end)).getTime() : 0;
  const nextEnd = periodEnd ? new Date(periodEnd).getTime() : 0;
  const renewed = nextEnd > prevEnd && prevEnd > 0;

  await tx`
    update billing_accounts set
      stripe_customer_id = ${customerId},
      stripe_subscription_id = ${subscriptionId},
      plan = ${plan},
      subscription_status = ${status},
      current_period_end = ${periodEnd}::timestamptz,
      trial_ends_at = ${trialEndsAt}::timestamptz,
      trial_will_end_notified_at = ${trialChanged
        ? null : (acct.trial_will_end_notified_at === null
          ? null : ts(acct.trial_will_end_notified_at))}::timestamptz,
      included_credits_used = ${renewed ? 0 : acct.included_credits_used},
      included_minutes_used = ${renewed ? 0 : acct.included_minutes_used},
      included_period_start = ${renewed ? tx`now()` : tx`included_period_start`}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { plan: acct.plan, status: acct.subscription_status },
    after: {
      plan, status,
      hasCustomer: Boolean(customerId),
      hasSubscription: Boolean(subscriptionId),
      sourceEventId: input.sourceEventId ?? null,
      // 续期清零要留痕：「我的额度怎么突然满了」是要能查的
      includedReset: renewed,
      // 试用起止也留痕：「我什么时候被扣的第一笔钱」是客服第一个被问到的问题
      trialEndsAt,
    },
  });

  return { accountId: acct.id, plan, subscriptionStatus: status, includedReset: renewed };
});

// ───────────────────────────────────────────────────────────────── 支付方式

registerHandler(SavePaymentMethod, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePaymentMethod.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  // 换了新卡就把两种额度的失败计数都清零 —— 换卡这个动作就是在说
  // 「这次能扣了」，还揣着旧卡的失败次数不放他会以为换了也没用
  const changed = input.paymentMethodId !== acct.default_payment_method_id;
  const reset = changed && Boolean(input.paymentMethodId);
  const label = input.paymentMethodId ? (input.label ?? null) : null;

  await tx`
    update billing_accounts set
      default_payment_method_id = ${input.paymentMethodId},
      payment_method_label = ${label},
      auto_topup_credits_failures = ${reset ? 0 : acct.auto_topup_credits_failures},
      auto_topup_minutes_failures = ${reset ? 0 : acct.auto_topup_minutes_failures}
    where id = ${acct.id}`;

  // ⚠️ 审计里只留「换了一张卡，显示成什么」。payment_method id 也不记 ——
  // 它不是卡号，但它是能对着 Stripe 发起扣款的东西
  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { hadPaymentMethod: Boolean(acct.default_payment_method_id) },
    after: { hasPaymentMethod: Boolean(input.paymentMethodId), label },
  });

  return { hasPaymentMethod: Boolean(input.paymentMethodId), label };
});

// ─────────────────────────────────────────────────────────────────── 充值

registerHandler(RecordTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordTopup.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const unit = input.unit as QuotaUnit;

  /**
   * 第二道去重：同一个 PaymentIntent 只入账一次。
   *
   * 命令总线的幂等键（PaymentIntent id）已经挡住了绝大多数重复，
   * 但**两条路都会来记这一笔**：扣款成功后路由记一次，Stripe 的
   * `payment_intent.succeeded` webhook 也会来记一次。两条路各自生成
   * 幂等键，挡不住对方 —— 而重复入账的方向是我们白送客户一笔额度。
   */
  if (input.stripePaymentIntentId) {
    const [dupe] = await tx<{ id: string; balance_after: number }[]>`
      select id, balance_after from credit_ledger
      where location_id = ${ctx.locationId}
        and stripe_payment_intent_id = ${input.stripePaymentIntentId}
        and kind = 'topup'
      limit 1`;
    if (dupe) {
      audit({
        entityType: 'credit_ledger', entityId: dupe.id,
        after: { alreadyRecorded: true, stripePaymentIntentId: input.stripePaymentIntentId },
      });
      return {
        ledgerId: dupe.id, unit: input.unit,
        balanceAfter: dupe.balance_after, alreadyRecorded: true,
      };
    }
  }

  const { ledgerId, balanceAfter } = await appendLedger(tx, ctx, acct, {
    kind: 'topup',
    unit,
    amount: input.units,
    paidCents: input.paidCents,
    source: 'stripe',
    stripePaymentIntentId: input.stripePaymentIntentId,
  });

  // 充上了就把这一种额度的失败计数清零：这张卡现在是好的
  const c = COLS[unit];
  await tx`
    update billing_accounts set
      ${tx(c.failures)} = 0,
      ${tx(c.lastAt)} = ${input.trigger === 'auto' ? tx`now()` : tx(c.lastAt)}
    where id = ${acct.id}`;

  audit({
    entityType: 'credit_ledger', entityId: ledgerId,
    after: {
      kind: 'topup', unit, units: input.units,
      paidCents: input.paidCents, trigger: input.trigger, balanceAfter,
    },
  });

  return { ledgerId, unit: input.unit, balanceAfter, alreadyRecorded: false };
});

// ──────────────────────────────────────────────────────── 自动续充：先占位

registerHandler(ClaimAutoTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ClaimAutoTopup.input._type>) => {
  const unit = input.unit as QuotaUnit;

  /**
   * ⭐ 先锁住这家店这一种额度的续充位，再判断。
   *
   * 不锁的话，两个并发请求会同时看到「余额低于阈值」，各自去 Stripe
   * 扣一笔 $50 —— 老板一分钟内被扣两次，而账本上是两条看起来都合法的记录。
   * advisory lock 只锁这一家店的这一种额度，别的店、另一种额度互不影响。
   */
  await tx`select pg_advisory_xact_lock(hashtext(${`topup:${ctx.locationId}:${unit}`}))`;

  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const decision = shouldAutoTopup(unit, toAutoTopupState(acct, unit));

  if (!decision.charge) {
    // 不充也要留痕 —— 出账单纠纷时要能回答「那天为什么没自动充上」，
    // 而不是耸肩。每个分支都有名字（disabled / cooling_down / …）
    audit({
      entityType: 'billing_account', entityId: acct.id,
      after: { autoTopup: 'skipped', unit, reason: decision.reason },
    });
    return {
      charge: false, reason: decision.reason, unit: input.unit,
      units: null, priceCents: null,
      stripeCustomerId: null, paymentMethodId: null, idempotencyKey: null,
    };
  }

  /**
   * **当场占位。** 冷却窗口从这一刻开始算，第二个请求进来会被
   * `cooling_down` 挡掉 —— 哪怕 Stripe 那边这次还没扣完。
   *
   * 代价是：扣失败时这次冷却是白占的（十分钟内不再试）。
   * 这个代价是对的 —— 卡被拒的时候，最不该做的事就是马上再试一次。
   */
  await tx`update billing_accounts set ${tx(COLS[unit].lastAt)} = now() where id = ${acct.id}`;

  /**
   * 给 Stripe 的幂等键按**冷却窗口分桶**。
   * 我们这边重试风暴时复用同一个键 → Stripe 只会扣一次。
   * 用 UUID 的话每次重试都是 Stripe 眼里的一笔新扣款。
   */
  const bucket = Math.floor(Date.now() / TOPUP_COOLDOWN_MS);
  const idempotencyKey = `gf-topup-${unit}-${ctx.locationId}-${bucket}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: {
      autoTopup: 'claimed', unit,
      units: decision.units, priceCents: decision.priceCents,
      balance: balanceOf(acct, unit),
    },
  });

  return {
    charge: true, reason: null, unit: input.unit,
    units: decision.units, priceCents: decision.priceCents,
    stripeCustomerId: acct.stripe_customer_id,
    paymentMethodId: acct.default_payment_method_id,
    idempotencyKey,
  };
});

registerHandler(RecordTopupFailure, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordTopupFailure.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const unit = input.unit as QuotaUnit;
  const c = COLS[unit];
  const state = toAutoTopupState(acct, unit);

  const failures = state.failures + 1;
  const disabled = failures >= MAX_TOPUP_FAILURES;

  /**
   * 连续失败到上限就**自动关掉**这一种额度的自动续充。
   *
   * 银行看到一张卡连续被拒会直接把它冻了 —— 那时候我们不只是没收到钱，
   * 是把客户的卡搞停了，而他要打电话给银行才能解开。
   */
  await tx`
    update billing_accounts set
      ${tx(c.failures)} = ${failures},
      ${tx(c.enabled)} = ${disabled ? false : state.enabled}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: { autoTopup: 'failed', unit, reason: input.reason, failures, disabled },
  });

  return { unit: input.unit, failures, disabled };
});

export { unitsPerTopup, TOPUP_PRICE_CENTS };
