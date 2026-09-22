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
import {
  findLedgerBreak, replayBalance, includedFor, TOPUP_PRICE_CENTS, unitsPerTopup,
  QUOTA_UNITS, type QuotaUnit,
} from '@gf/payroll';

export interface LedgerRow {
  id: string;
  kind: string;
  unit: QuotaUnit;
  /** 有符号的单位数 */
  amount: number;
  balanceAfter: number;
  /** 充值时付了多少分。用量扣费为 null */
  paidCents: number | null;
  source: string | null;
  reason: string | null;
  at: string;
}

/** 一种额度的完整状态。两种额度各一份，**互不相干** */
export interface QuotaView {
  unit: QuotaUnit;
  /** 套餐内：本期已用 / 总共 / 还剩 */
  included: { used: number; total: number; remaining: number };
  /** 充值买来的余额（不过期）。**可以是负数** */
  balance: number;
  /** $50 能买多少个 */
  unitsPerTopup: number;
  autoTopup: {
    enabled: boolean; thresholdUnits: number; failures: number; lastAt: string | null;
  };
  /** 本期用量（从 usage_events 统计） */
  usedThisMonth: number;
  /** 账本自洽性：第几行接不上。null = 对得上 */
  ledgerBreakAt: number | null;
  /** 余额缓存和账本对不对得上。null = 对得上 */
  balanceMismatch: { cached: number; ledger: number } | null;
}

export interface BillingView {
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;

  /**
   * 这一行的付费状态由谁说了算（迁移 0120）：
   * `none` 从未接计费 / `stripe` 订阅在 Stripe / `license` 运营签发的订阅码。
   *
   * ⚠️ 界面必须据此分叉：`license` 的店**没有** Stripe 客户门户可去，
   * 把「管理订阅」按钮给他会跳到一个 404。他要续期是找我们，不是找 Stripe。
   */
  billingSource: string;
  ownershipPaymentReview: boolean;
  /** license 模式下的到期时刻（与 currentPeriodEnd 镜像同一个值） */
  licensePeriodEnd: string | null;

  /** 试用结束时刻。null = 从未试用，或已经转正（批 1） */
  trialEndsAt: string | null;
  /** 现在是不是在试用期内。界面上要显示「还剩 N 天」和首次扣款日 */
  trialing: boolean;

  /**
   * ⭐ 老板已经在客户门户点了取消，订阅到期即止（sql/0085）。
   *
   * ⚠️ 这种情况下 `subscriptionStatus` **仍然是 active** —— 界面必须
   * 据此把「下次扣款 X 日」换成「X 日到期，之后转为只读」，
   * 否则老板会在到期那天突然发现全店冻结。
   */
  cancelAtPeriodEnd: boolean;
  /** 期末取消的确切时刻。cancelAtPeriodEnd 为 false 时为 null */
  cancelAt: string | null;

  hasPaymentMethod: boolean;
  paymentMethodLabel: string | null;

  /** 一次充值多少钱（固定 $50） */
  topupPriceCents: number;

  /**
   * 两种额度各一份。
   *
   * ⚠️ **不能互换**（决策 8）：一分钟电话的成本是一次副驾操作的 6.2 倍，
   * 能换就会被套利。界面上也要分成两块显示，不要合成一个「总额度」。
   */
  quotas: QuotaView[];

  recent: LedgerRow[];
}

const RECENT_LIMIT = 50;

export async function loadBilling(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<BillingView | null> {
  const [acct] = await tx<Record<string, never>[]>`
    select * from billing_accounts where location_id = ${ctx.locationId}`;

  // 还没有账户 = 这家店从没用过 AI 也没订过阅。给 null 让前端显示引导页，
  // 而不是一屏「0 / 0」的空表格 —— 那看起来像是坏了
  if (!acct) return null;
  const a = acct as unknown as AccountFields;
  if (a.billing_source === 'license' && a.license_period_end && parseTs(a.license_period_end).getTime() <= Date.now()) {
    a.subscription_status = 'expired';
  }

  /**
   * 全部流水，按 seq 排。
   *
   * ⚠️ 两条都不能省：
   * 1. **对账只能拿全部流水**，从中间截一段的话起始余额是未知的。
   * 2. **必须按 `seq` 排，不能按 `created_at`** —— `now()` 是事务开始时刻，
   *    并发扣费时它和 balance_after 的链条对不上，会报一个根本不存在的
   *    断点（迁移 0019 的长注释）。
   */
  const all = await tx<{
    unit: string; amount: number | null; balance_after: number | null;
  }[]>`
    select unit, amount, balance_after from credit_ledger
    where location_id = ${ctx.locationId} and amount is not null
    order by seq`;
  const entries = all.map((r) => ({
    unit: r.unit as QuotaUnit, amount: r.amount!, balanceAfter: r.balance_after!,
  }));

  /** 本期用量。按 usage_events 分 —— 账本只知道扣了多少，不知道用了几次 */
  const usage = await tx<{ kind: string; qty: string }[]>`
    select kind, sum(qty) as qty from usage_events
    where location_id = ${ctx.locationId} and at >= date_trunc('month', now())
    group by kind`;
  const usedBy = (k: string) => Number(usage.find((u) => u.kind === k)?.qty ?? 0);

  const rows = await tx<{
    id: string; kind: string; unit: string; amount: number | null;
    balance_after: number | null; paid_cents: number | null;
    source: string | null; reason: string | null; created_at: string | Date;
  }[]>`
    select id, kind, unit, amount, balance_after, paid_cents, source, reason, created_at
    from credit_ledger
    where location_id = ${ctx.locationId} and amount is not null
    order by seq desc limit ${RECENT_LIMIT}`;

  /** 试用期的判据只有一处：`trial_ends_at` 还在未来。见 handlers/billing.ts §isTrialing */
  const trialingNow = a.trial_ends_at !== null
    && parseTs(a.trial_ends_at).getTime() > Date.now();

  const quotaOf = (unit: QuotaUnit): QuotaView => {
    const isCredit = unit === 'credit';
    const used = isCredit ? a.included_credits_used : a.included_minutes_used;
    /*
     * 试用期显示的是试用额度，不是套餐额度 —— 否则老板看到「本期含 500 积分」
     * 而实际扣到 150 就没了，会当成 bug 报过来。
     *
     * ⚠️ `none`（从未接过计费）显示 0，和 `handlers/billing.ts` 的
     * `includedTotalOf` 是同一份判据。界面上显示 500 而实际一次都调不了，
     * 比显示 0 更糟。
     */
    const total = a.subscription_status === 'none'
      ? 0 : includedFor(a.plan, unit, trialingNow, a.manual_voice_minutes, a.billing_source);
    const cached = isCredit ? a.credit_balance : a.voice_minute_balance;
    const ledger = replayBalance(entries, unit);

    return {
      unit,
      included: { used, total, remaining: Math.max(0, total - used) },
      balance: cached,
      unitsPerTopup: unitsPerTopup(unit),
      autoTopup: {
        enabled: isCredit ? a.auto_topup_credits_enabled : a.auto_topup_minutes_enabled,
        thresholdUnits: isCredit
          ? a.auto_topup_credits_threshold : a.auto_topup_minutes_threshold,
        failures: isCredit ? a.auto_topup_credits_failures : a.auto_topup_minutes_failures,
        lastAt: (() => {
          const v = isCredit ? a.auto_topup_credits_last_at : a.auto_topup_minutes_last_at;
          return v ? parseTs(v).toISOString() : null;
        })(),
      },
      usedThisMonth: usedBy(isCredit ? 'ai_assist' : 'ai_call_min'),
      // 账本行被就地改过
      ledgerBreakAt: findLedgerBreak(entries, unit),
      /**
       * ⚠️ 这一条和 `ledgerBreakAt` 查的**不是同一件事**，两条都要：
       *   · ledgerBreakAt 抓的是「账本行被改过」
       *   · 这一条抓的是「没碰账本，直接 update 了余额缓存」
       * 后者更可能发生（一句手写 SQL 就能干出来），而且光看账本发现不了。
       */
      balanceMismatch: ledger === cached ? null : { cached, ledger },
    };
  };

  const [ownership] = await tx<{ required: boolean }[]>`select coalesce((settings->'ownership_payment_review'->>'required')::boolean,false) as required from locations where id=${ctx.locationId}`;
  return {
    ownershipPaymentReview: ownership?.required ?? false,
    plan: a.plan,
    subscriptionStatus: a.subscription_status,
    billingSource: a.billing_source,
    licensePeriodEnd: a.license_period_end
      ? parseTs(a.license_period_end).toISOString() : null,
    currentPeriodEnd: a.current_period_end
      ? parseTs(a.current_period_end).toISOString() : null,
    /*
     * ⚠️ 退订之后 `stripe_subscription_id` 是**留着的**（webhook 靠它定位
     * 租户），所以「有没有订阅」不能只看那一列 —— 否则退订之后界面还是
     * 「已订阅」，老板找不到重新订阅的入口。
     */
    hasSubscription: Boolean(a.stripe_subscription_id)
      && a.subscription_status !== 'canceled' && a.subscription_status !== 'none',

    /**
     * 试用状态（批 1）。
     *
     * `trialing` 看的是 `trial_ends_at` 还在不在未来，**不看 subscription_status** ——
     * Stripe 那边扣完款状态立刻变 active，而我们这行要等 webhook 回来，
     * 中间那几秒按 status 判会闪一下错的额度（见 handlers/billing.ts §isTrialing）。
     */
    trialEndsAt: a.trial_ends_at ? parseTs(a.trial_ends_at).toISOString() : null,
    trialing: trialingNow,

    cancelAtPeriodEnd: a.cancel_at_period_end === true,
    cancelAt: a.cancel_at ? parseTs(a.cancel_at).toISOString() : null,

    hasPaymentMethod: Boolean(a.default_payment_method_id),
    paymentMethodLabel: a.payment_method_label,

    topupPriceCents: TOPUP_PRICE_CENTS,
    quotas: QUOTA_UNITS.map(quotaOf),

    recent: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      unit: r.unit as QuotaUnit,
      amount: r.amount!,
      balanceAfter: r.balance_after!,
      paidCents: r.paid_cents,
      source: r.source,
      reason: r.reason,
      at: parseTs(r.created_at).toISOString(),
    })),
  };
}

/** billing_accounts 里这个视图用得到的列 */
interface AccountFields {
  plan: string; subscription_status: string;
  billing_source: string; license_period_end: string | Date | null;
  current_period_end: string | Date | null; stripe_subscription_id: string | null;
  trial_ends_at: string | Date | null;
  cancel_at_period_end: boolean; cancel_at: string | Date | null;
  default_payment_method_id: string | null; payment_method_label: string | null;
  credit_balance: number; voice_minute_balance: number;
  included_credits_used: number; included_minutes_used: number;
  manual_voice_minutes: number | null;
  auto_topup_credits_enabled: boolean; auto_topup_credits_threshold: number;
  auto_topup_credits_failures: number; auto_topup_credits_last_at: string | Date | null;
  auto_topup_minutes_enabled: boolean; auto_topup_minutes_threshold: number;
  auto_topup_minutes_failures: number; auto_topup_minutes_last_at: string | Date | null;
}
