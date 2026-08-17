/**
 * 计费命令的实现（Phase 2，决策 8）
 *
 * 这个文件里**一行 Stripe 调用都没有**。所有和 Stripe 说话的编排在
 * `apps/api/src/stripe/routes.ts`，理由写在 `commands/billing.ts` 顶部：
 * 命令跑在数据库事务里，把几秒的外部 IO 塞进事务会占住连接和快照。
 *
 * 分工是：**路由调 Stripe，命令落库。** 每一次余额变动仍然是一条
 * 有审计、有幂等、有 RLS 的命令（宪法第 1 条）。
 *
 * 三条纪律，每一条都在下面有对应的代码：
 *
 *   1. **余额只用整数分**（宪法第 4 条）。全程不出现一次浮点。
 *   2. **扣费永远走 `credit_ledger`**，不许直接 update 余额 ——
 *      直接改的那一刻，「钱去哪了」就变成一个没有答案的问题。
 *   3. **算钱的判断全在 `@gf/payroll/credits` 的纯函数里**（宪法第 2 条），
 *      这里只负责取数、写库、留痕。
 */

import {
  SetAutoTopup, SyncSubscription, SavePaymentMethod,
  RecordTopup, ClaimAutoTopup, RecordTopupFailure,
  AppError, ERROR_CODES, type CommandContext,
} from '@gf/contracts';
import { ts } from '@gf/db';
import {
  shouldAutoTopup, applyEntry, MAX_TOPUP_FAILURES, TOPUP_COOLDOWN_MS,
  type BillingAccountState, type LedgerEntryInput,
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
  default_payment_method_id: string | null;
  payment_method_label: string | null;
  balance_cents: number;
  auto_topup_enabled: boolean;
  auto_topup_threshold_cents: number;
  auto_topup_amount_cents: number;
  last_auto_topup_at: string | Date | null;
  auto_topup_failures: number;
}

/**
 * 拿这家店的计费账户，没有就建一个。
 *
 * ⚠️ **一定要自动建**：一家还在试用期、从没进过 Stripe 的店照样会产生
 * AI 用量。没有账户就没法记账，而「用量发生了但账上看不到」是最糟的
 * 那一种 —— 到月底突然冒出一笔对不上的差额，谁也说不清是哪几次调用。
 *
 * `on conflict do nothing` 而不是先查后插：两个请求同时给一家新店记账时，
 * 先查后插会撞唯一索引，而客户看到的是一个莫名其妙的 500。
 *
 * `forUpdate` 给要改余额的调用方用：**同一行上排队**，
 * 否则两笔并发扣费会各自读到同一个余额，账本上留下一个对不齐的断点。
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
        select * from billing_accounts
        where location_id = ${ctx.locationId}`;

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
export function toAccountState(row: AccountRow): BillingAccountState {
  return {
    balanceCents: row.balance_cents,
    autoTopupEnabled: row.auto_topup_enabled,
    autoTopupThresholdCents: row.auto_topup_threshold_cents,
    autoTopupAmountCents: row.auto_topup_amount_cents,
    lastAutoTopupAt: row.last_auto_topup_at
      ? new Date(typeof row.last_auto_topup_at === 'string'
          ? row.last_auto_topup_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
          : row.last_auto_topup_at)
      : null,
    autoTopupFailures: row.auto_topup_failures,
    defaultPaymentMethodId: row.default_payment_method_id,
    subscriptionStatus: row.subscription_status,
  };
}

/**
 * 记一笔账并同步余额缓存。**所有余额变动的唯一入口。**
 *
 * 账本是事实，`billing_accounts.balance_cents` 只是缓存 ——
 * 每次都从传进来的 `balanceCents` 算，而那个值必须来自
 * `for update` 锁住的那一行，否则并发下两笔会算出同一个 balance_after。
 */
export async function appendLedger(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  account: AccountRow,
  entry: LedgerEntryInput & {
    source?: string | null;
    usageEventId?: string | null;
    stripePaymentIntentId?: string | null;
  },
): Promise<{ ledgerId: string; balanceAfterCents: number }> {
  // 纯函数把关：方向和类型对不上（「充值 −$50」）、调账没写原因、
  // 金额不是整数 —— 全在这里被挡下，而不是等 DB 约束报一句看不懂的话
  const applied = applyEntry(account.balance_cents, entry);

  const [row] = await tx<{ id: string }[]>`
    insert into credit_ledger
      (org_id, location_id, kind, amount_cents, balance_after_cents,
       source, usage_event_id, stripe_payment_intent_id, reason)
    values (${ctx.orgId}, ${ctx.locationId}, ${entry.kind}, ${entry.amountCents},
            ${applied.balanceAfterCents}, ${entry.source ?? null},
            ${entry.usageEventId ?? null}, ${entry.stripePaymentIntentId ?? null},
            ${entry.reason ?? null})
    returning id`;

  await tx`
    update billing_accounts set balance_cents = ${applied.balanceAfterCents}
    where id = ${account.id}`;

  return { ledgerId: row!.id, balanceAfterCents: applied.balanceAfterCents };
}

// ─────────────────────────────────────────────────────────────── 自动续充设置

registerHandler(SetAutoTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetAutoTopup.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  /**
   * 重新打开时把失败计数清零。
   *
   * 老板来动这个开关，通常正是因为他刚换了张卡或者刚给卡充了钱 ——
   * 还揣着上一张卡的三次失败不放，等于他明明修好了却还是充不上，
   * 而界面上不会告诉他为什么。
   */
  const reopening = input.enabled && !acct.auto_topup_enabled;
  const failuresReset = reopening && acct.auto_topup_failures > 0;

  await tx`
    update billing_accounts set
      auto_topup_enabled = ${input.enabled},
      auto_topup_threshold_cents = ${input.thresholdCents},
      auto_topup_amount_cents = ${input.amountCents},
      auto_topup_failures = ${failuresReset ? 0 : acct.auto_topup_failures}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: {
      enabled: acct.auto_topup_enabled,
      thresholdCents: acct.auto_topup_threshold_cents,
      amountCents: acct.auto_topup_amount_cents,
    },
    after: {
      enabled: input.enabled,
      thresholdCents: input.thresholdCents,
      amountCents: input.amountCents,
      failuresReset,
    },
  });

  return {
    enabled: input.enabled,
    thresholdCents: input.thresholdCents,
    amountCents: input.amountCents,
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
   *   ⚠️ 这一条是有代价才定下来的：`planForPriceId` 认不出一个 price 时
   *   返回 null，如果按「明确清空」处理，一个付 Pro 钱的客户会被静默降档，
   *   而账单上完全看不出来 —— DB 的 not-null 约束替我们挡下过一次。
   *
   * 两类都用 `undefined` 表示「这个调用点不知道」：建 Checkout 时那次
   * 只带 customerId 的同步，不能把订阅状态整个抹成 trialing。
   */
  const clearable = <T>(next: T | null | undefined, cur: T | null): T | null =>
    next === undefined ? cur : (next ?? null);

  const plan = input.plan ?? acct.plan;
  const status = input.subscriptionStatus ?? acct.subscription_status;
  const customerId = clearable(input.stripeCustomerId, acct.stripe_customer_id);
  const subscriptionId = clearable(input.stripeSubscriptionId, acct.stripe_subscription_id);
  // 时间参数一律先转成字符串再配 ::timestamptz —— 直接传 Date 在 vitest 的
  // VM realm 里会被 postgres.js 的 instanceof 判错类型（见 @gf/db 的 ts() 注释）
  const periodEnd: string | null = input.currentPeriodEnd === undefined
    ? (acct.current_period_end === null ? null : ts(acct.current_period_end))
    : (input.currentPeriodEnd === null ? null : ts(new Date(input.currentPeriodEnd)));

  await tx`
    update billing_accounts set
      stripe_customer_id = ${customerId},
      stripe_subscription_id = ${subscriptionId},
      plan = ${plan},
      subscription_status = ${status},
      current_period_end = ${periodEnd}::timestamptz
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { plan: acct.plan, status: acct.subscription_status },
    after: {
      plan, status,
      hasCustomer: Boolean(customerId),
      hasSubscription: Boolean(subscriptionId),
      sourceEventId: input.sourceEventId ?? null,
    },
  });

  return { accountId: acct.id, plan, subscriptionStatus: status };
});

// ───────────────────────────────────────────────────────────────── 支付方式

registerHandler(SavePaymentMethod, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePaymentMethod.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  /**
   * 换了新卡就把失败计数清零。
   *
   * 上一张卡失败三次之后自动续充已经被关了；老板换卡这个动作
   * 就是在说「这次能扣了」—— 还揣着旧卡的失败次数不放，
   * 他会以为换了卡还是不管用。
   */
  const changed = input.paymentMethodId !== acct.default_payment_method_id;
  const label = input.paymentMethodId ? (input.label ?? null) : null;

  await tx`
    update billing_accounts set
      default_payment_method_id = ${input.paymentMethodId},
      payment_method_label = ${label},
      auto_topup_failures = ${changed && input.paymentMethodId ? 0 : acct.auto_topup_failures}
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

  /**
   * 第二道去重：同一个 PaymentIntent 只入账一次。
   *
   * 命令总线的幂等键（PaymentIntent id）已经挡住了绝大多数重复，
   * 但**两条路都会来记这一笔**：扣款成功后路由记一次，Stripe 的
   * `payment_intent.succeeded` webhook 也会来记一次。两条路各自生成
   * 幂等键，挡不住对方 —— 而重复入账的方向是我们白送客户一笔钱。
   */
  if (input.stripePaymentIntentId) {
    const [dupe] = await tx<{ id: string; balance_after_cents: number }[]>`
      select id, balance_after_cents from credit_ledger
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
        ledgerId: dupe.id,
        balanceAfterCents: dupe.balance_after_cents,
        alreadyRecorded: true,
      };
    }
  }

  const { ledgerId, balanceAfterCents } = await appendLedger(tx, ctx, acct, {
    kind: 'topup',
    amountCents: input.amountCents,
    source: 'stripe',
    stripePaymentIntentId: input.stripePaymentIntentId,
  });

  // 充上了就把失败计数清零：这张卡现在是好的
  await tx`
    update billing_accounts set
      auto_topup_failures = 0,
      last_auto_topup_at = ${input.trigger === 'auto'
        ? tx`now()` : tx`last_auto_topup_at`}
    where id = ${acct.id}`;

  audit({
    entityType: 'credit_ledger', entityId: ledgerId,
    after: {
      kind: 'topup', trigger: input.trigger,
      amountCents: input.amountCents, balanceAfterCents,
    },
  });

  return { ledgerId, balanceAfterCents, alreadyRecorded: false };
});

// ──────────────────────────────────────────────────────── 自动续充：先占位

registerHandler(ClaimAutoTopup, async ({ ctx, tx, audit }: HandlerArgs<
  typeof ClaimAutoTopup.input._type>) => {
  /**
   * ⭐ 先锁住这家店的续充位，再判断。
   *
   * 不锁的话，两个并发请求会同时看到「余额低于阈值」，各自去 Stripe
   * 扣一笔 $50 —— 老板一分钟内被扣两次，而账本上是两条看起来都合法的记录。
   * advisory lock 只锁这一家店，别的店同时续充互不影响。
   */
  await tx`select pg_advisory_xact_lock(hashtext(${`topup:${ctx.locationId}`}))`;

  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const decision = shouldAutoTopup(toAccountState(acct));

  if (!decision.charge) {
    // 不充也要留痕 —— 出账单纠纷时要能回答「那天为什么没自动充上」，
    // 而不是耸肩。每个分支都有名字（disabled / cooling_down / …）
    audit({
      entityType: 'billing_account', entityId: acct.id,
      after: { autoTopup: 'skipped', reason: decision.reason },
    });
    return {
      charge: false, reason: decision.reason, amountCents: null,
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
  await tx`
    update billing_accounts set last_auto_topup_at = now() where id = ${acct.id}`;

  /**
   * 给 Stripe 的幂等键按**冷却窗口分桶**。
   *
   * 我们这边重试风暴时复用同一个键 → Stripe 只会扣一次。
   * 用 UUID 的话每次重试都是 Stripe 眼里的一笔新扣款。
   */
  const bucket = Math.floor(Date.now() / TOPUP_COOLDOWN_MS);
  const idempotencyKey = `gf-topup-${ctx.locationId}-${bucket}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: {
      autoTopup: 'claimed',
      amountCents: decision.amountCents,
      balanceCents: acct.balance_cents,
      thresholdCents: acct.auto_topup_threshold_cents,
    },
  });

  return {
    charge: true,
    reason: null,
    amountCents: decision.amountCents,
    stripeCustomerId: acct.stripe_customer_id,
    paymentMethodId: acct.default_payment_method_id,
    idempotencyKey,
  };
});

registerHandler(RecordTopupFailure, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordTopupFailure.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const failures = acct.auto_topup_failures + 1;
  const disabled = failures >= MAX_TOPUP_FAILURES;

  /**
   * 连续失败到上限就**自动关掉**自动续充。
   *
   * 银行看到一张卡连续被拒会直接把它冻了 —— 那时候我们不只是没收到钱，
   * 是把客户的卡搞停了，而他要打电话给银行才能解开。
   */
  await tx`
    update billing_accounts set
      auto_topup_failures = ${failures},
      auto_topup_enabled = ${disabled ? false : acct.auto_topup_enabled}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: { autoTopup: 'failed', reason: input.reason, failures, disabled },
  });

  return { failures, disabled };
});
