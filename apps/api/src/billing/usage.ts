/**
 * 用量扣额度：`usage_events` 落库的地方，同时记一条 `credit_ledger`。
 *
 * ## 为什么是一个函数而不是一条命令
 *
 * 它**必须和 `usage_events` 的那条 insert 在同一个事务里**。
 * 分成两条命令的话，中间挂掉就会留下「用量记了但没扣额度」或者反过来 ——
 * 而这两种漂移都要到月底对账时才被发现，那时候已经查不清是哪几次调用。
 *
 * 调用它的地方本身已经是命令（`ai.recordAssist`、`call.record`、
 * `blueprint.saveExtraction`），审计、幂等、RLS 都在外面那一层守着，
 * 宪法第 1 条没有被绕开。
 *
 * ## ⚠️ 两种额度不能互换
 *
 * 积分和分钟各扣各的。一分钟电话的成本是一次副驾操作的 6.2 倍，
 * 只要能换，客户就会把额度全换成最贵的那种用（决策 8）。
 * 这个文件里没有任何换算。
 */

import {
  allocateQuota, includedFor, type QuotaUnit,
} from '@gf/payroll';
import type { CommandContext } from '@gf/contracts';
import type postgres from 'postgres';
import {
  ensureAccount, appendLedger, balanceOf, includedUsedOf, includedRemainingOf,
} from '../handlers/billing';

export interface QuotaChargeInput {
  unit: QuotaUnit;
  /** 要扣几个（积分 / 分钟）。0 表示不用扣 */
  amount: number;
  /** 对应的那条 usage_events，能一路查回「这 4 个积分是哪次调用」 */
  usageEventId?: string | null;
  /** 记进账本 source 列：ai_assist | ai_call_min | price_list_vision … */
  source?: string;
}

export interface QuotaChargeResult {
  unit: QuotaUnit;
  /** 走套餐内额度的部分 */
  fromIncluded: number;
  /** 走充值余额的部分（真正花钱的那部分） */
  fromBalance: number;
  /** 套餐内还剩几个 */
  includedRemaining: number;
  /** 充值余额还剩几个。**可以是负数** */
  balanceAfter: number;
  /** 只有 fromBalance > 0 时才有账本记录 */
  ledgerId: string | null;
}

/**
 * 扣一次额度。返回 null = 这次不用扣（数量是 0）。
 *
 * **先用套餐里的**，用完了才扣充值余额；一次可以跨两边扣
 *（套餐内剩 3 个而要扣 8 个 = 3 + 5），别浪费掉已经付过钱的那几个。
 *
 * ⚠️ 走套餐内额度那部分**不记账本** —— 账本记的是额度余额的进出，
 * 而套餐内的用量没有动余额。用了多少在 `usage_events` 里查得到。
 */
export async function chargeQuota(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  input: QuotaChargeInput,
): Promise<QuotaChargeResult | null> {
  if (input.amount <= 0) return null;

  // for update：两笔并发扣费必须在这一行上排队，否则各自读到同一个余额，
  // 账本上会留下一个对不齐的断点；套餐内计数同理
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  const decision = allocateQuota(input.amount, {
    plan: acct.plan,
    unit: input.unit,
    includedUsed: includedUsedOf(acct, input.unit),
    balance: balanceOf(acct, input.unit),
  });

  // 套餐内那部分：只加计数，不动账本
  if (decision.fromIncluded > 0) {
    const col = input.unit === 'credit' ? 'included_credits_used' : 'included_minutes_used';
    await tx`
      update billing_accounts set
        ${tx(col)} = ${includedUsedOf(acct, input.unit) + decision.fromIncluded},
        included_period_start = coalesce(included_period_start, now())
      where id = ${acct.id}`;
  }

  let ledgerId: string | null = null;
  if (decision.fromBalance > 0) {
    /**
     * ⚠️ **余额允许扣成负数**，这是有意的（`@gf/payroll/credits` 的长注释）。
     *
     * AI 调用已经发生了、钱已经花出去了 —— 拒绝记账不会把那次调用变没，
     * 只会让账本和现实对不上。欠着的部分下次充值时自动补上，
     * 而负余额会在老板端显红。
     */
    const out = await appendLedger(tx, ctx, acct, {
      kind: 'usage',
      unit: input.unit,
      amount: -decision.fromBalance,
      source: input.source ?? input.unit,
      usageEventId: input.usageEventId ?? null,
    });
    ledgerId = out.ledgerId;
  }

  return {
    unit: input.unit,
    fromIncluded: decision.fromIncluded,
    fromBalance: decision.fromBalance,
    includedRemaining: decision.includedRemaining,
    balanceAfter: decision.balanceAfter,
    ledgerId,
  };
}

/** 套餐内还剩多少。前台那一屏要显示「本期还剩 431 积分」 */
export { includedFor, includedRemainingOf };
