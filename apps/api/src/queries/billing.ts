/**
 * 「订阅与余额」那一屏要的全部数据，一次给全。
 *
 * 老板最想在这一屏回答的是三个问题，页面的三块就是这三个：
 *   1. 我现在是什么套餐、下次什么时候扣钱
 *   2. 余额还剩多少、够用多久
 *   3. **这些钱花在哪了** —— 这一条最重要，也是最容易被做成一堆看不懂的流水
 *
 * 所以账本不是原样倒出来，而是按 `kind` 分组给一个本月小计，
 * 再给最近若干条明细。老板要的是「这个月副驾花了 $3.20」，
 * 不是四百行 −$0.04。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { findLedgerBreak, replayBalance, includedAssistsFor } from '@gf/payroll';
import { includedRemaining } from '../billing/usage';

export interface LedgerRow {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  source: string | null;
  reason: string | null;
  at: string;
}

export interface BillingView {
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;

  balanceCents: number;
  hasPaymentMethod: boolean;
  paymentMethodLabel: string | null;

  autoTopup: {
    enabled: boolean;
    thresholdCents: number;
    amountCents: number;
    failures: number;
    lastAt: string | null;
  };

  /**
   * 套餐内额度（先用套餐里的，用完了才扣余额）。
   * `used`/`remaining` 按**订阅周期**算，不是自然月 —— 跟着 Stripe 的续期清零。
   */
  included: { used: number; total: number; remaining: number };

  /** 本月按功能分的花费。qty 对 ai_assist 是次数，对 ai_call_min 是分钟 */
  monthToDate: Array<{ kind: string; qty: number; chargedCents: number }>;
  recent: LedgerRow[];

  /**
   * ⭐ 账本**内部**自洽性：第几行的 balance_after 和前一行接不上。
   * null = 对得上。不为 null 说明有账本行被就地改过。
   */
  ledgerBreakAt: number | null;

  /**
   * ⭐ 余额缓存和账本**对不对得上**。null = 对得上。
   *
   * ⚠️ 这一条和 `ledgerBreakAt` 查的**不是同一件事**，两条都要：
   *   · `ledgerBreakAt` 抓的是「账本行被改过」
   *   · 这一条抓的是「没碰账本，直接 update 了 billing_accounts.balance_cents」
   *
   * 后者才是更可能发生的那一种（一句手写的 SQL 就能干出来），而且
   * 光看账本完全发现不了 —— 账本自己是自洽的，只是没人再看它了。
   *
   * 发现之后**不在界面上悄悄纠正**：账本是事实，缓存错了是事故，
   * 要有人去查为什么（宪法第 9 条）。
   */
  balanceMismatch: { cachedCents: number; ledgerCents: number } | null;
}

const RECENT_LIMIT = 50;

export async function loadBilling(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<BillingView | null> {
  const [acct] = await tx<{
    plan: string; subscription_status: string;
    current_period_end: string | Date | null;
    stripe_subscription_id: string | null;
    balance_cents: number;
    default_payment_method_id: string | null; payment_method_label: string | null;
    auto_topup_enabled: boolean; auto_topup_threshold_cents: number;
    auto_topup_amount_cents: number; auto_topup_failures: number;
    last_auto_topup_at: string | Date | null;
    included_assists_used: number;
  }[]>`
    select plan, subscription_status, current_period_end, stripe_subscription_id,
           balance_cents, default_payment_method_id, payment_method_label,
           auto_topup_enabled, auto_topup_threshold_cents, auto_topup_amount_cents,
           auto_topup_failures, last_auto_topup_at, included_assists_used
    from billing_accounts where location_id = ${ctx.locationId}`;

  // 还没有账户 = 这家店从没用过 AI 也没订过阅。给 null 让前端显示引导页，
  // 而不是一屏「$0.00 / 0 条」的空表格 —— 那看起来像是坏了
  if (!acct) return null;

  /**
   * 本月用量。按 `usage_events` 而不是账本分组：
   * 账本上一条 usage 只知道扣了多少钱，而老板问的是「用了多少次」。
   * 两张表都要，各回答一半问题。
   */
  const usage = await tx<{ kind: string; qty: string; charged: string | null }[]>`
    select ue.kind,
           sum(ue.qty) as qty,
           -- 账本记的是负数（扣费），这里取绝对值给人看
           coalesce(-sum(cl.amount_cents), 0) as charged
    from usage_events ue
    left join credit_ledger cl on cl.usage_event_id = ue.id
    where ue.location_id = ${ctx.locationId}
      and ue.at >= date_trunc('month', now())
    group by ue.kind
    order by ue.kind`;

  const rows = await tx<{
    id: string; kind: string; amount_cents: number; balance_after_cents: number;
    source: string | null; reason: string | null; created_at: string | Date;
  }[]>`
    select id, kind, amount_cents, balance_after_cents, source, reason, created_at
    from credit_ledger
    where location_id = ${ctx.locationId}
    order by seq desc
    limit ${RECENT_LIMIT}`;

  /**
   * 账本自洽性检查。
   *
   * ⚠️ 两条都不能省：
   *
   * 1. **只能拿全部流水检查**，不能拿上面那 50 条 —— 从中间截一段的话
   *    起始余额是未知的，`findLedgerBreak` 会把第一行就报成断点。
   *    条数多的店这一趟也就几百行，一天看一次的页面付得起。
   * 2. **必须按 `seq` 排，不能按 `created_at`** —— `now()` 是事务开始时刻，
   *    并发扣费时它和 balance_after 的链条对不上，会报一个根本不存在的
   *    断点（迁移 0019 的长注释）。
   */
  const all = await tx<{ amount_cents: number; balance_after_cents: number }[]>`
    select amount_cents, balance_after_cents from credit_ledger
    where location_id = ${ctx.locationId}
    order by seq`;
  const entries = all.map((r) => ({
    amountCents: r.amount_cents, balanceAfterCents: r.balance_after_cents,
  }));

  const ledgerBreakAt = findLedgerBreak(entries);
  // 账本是事实，balance_cents 只是缓存 —— 重算一遍看两者对不对得上
  const ledgerCents = replayBalance(entries);
  const balanceMismatch = ledgerCents === acct.balance_cents
    ? null
    : { cachedCents: acct.balance_cents, ledgerCents };

  return {
    plan: acct.plan,
    subscriptionStatus: acct.subscription_status,
    currentPeriodEnd: acct.current_period_end
      ? parseTs(acct.current_period_end).toISOString() : null,
    hasSubscription: Boolean(acct.stripe_subscription_id),

    balanceCents: acct.balance_cents,
    hasPaymentMethod: Boolean(acct.default_payment_method_id),
    paymentMethodLabel: acct.payment_method_label,

    autoTopup: {
      enabled: acct.auto_topup_enabled,
      thresholdCents: acct.auto_topup_threshold_cents,
      amountCents: acct.auto_topup_amount_cents,
      failures: acct.auto_topup_failures,
      lastAt: acct.last_auto_topup_at ? parseTs(acct.last_auto_topup_at).toISOString() : null,
    },

    included: {
      used: acct.included_assists_used,
      total: includedAssistsFor(acct.plan),
      remaining: includedRemaining(acct.plan, acct.included_assists_used),
    },

    monthToDate: usage.map((u) => ({
      kind: u.kind,
      qty: Number(u.qty),
      chargedCents: Number(u.charged ?? 0),
    })),
    recent: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amount_cents,
      balanceAfterCents: r.balance_after_cents,
      source: r.source,
      reason: r.reason,
      at: parseTs(r.created_at).toISOString(),
    })),
    ledgerBreakAt,
    balanceMismatch,
  };
}
