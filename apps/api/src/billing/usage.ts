/**
 * 用量扣费：`usage_events` 落库的地方，同时记一条 `credit_ledger`。
 *
 * ## 为什么是一个函数而不是一条命令
 *
 * 它**必须和 `usage_events` 的那条 insert 在同一个事务里**。
 * 分成两条命令的话，中间挂掉就会留下「用量记了但没扣钱」或者反过来 ——
 * 而这两种漂移都要到月底对账时才被发现，那时候已经查不清是哪几次调用。
 *
 * 调用它的地方本身已经是命令（`blueprint.saveExtraction`、`call.record`），
 * 审计、幂等、RLS 都在外面那一层守着，宪法第 1 条没有被绕开。
 *
 * ## ⚠️ 单位是**毫分**不是分
 *
 * `packages/ai/src/cost.ts` 全程用毫分（1/1000 分）：`$0.012 = 1.2 分 = 1200 毫分`。
 * 传成 12000 的话账单会**差 10 倍**，而这是最难被发现的一类错 ——
 * 数字看起来完全正常。所以这个函数的参数名叫 `costMillicents`，
 * 不叫 `cost`：让调用点自己把单位念出来。
 */

import { usageChargeCents, consumeIncluded, includedAssistsFor } from '@gf/payroll';
import type { CommandContext } from '@gf/contracts';
import type postgres from 'postgres';
import { ensureAccount, appendLedger } from '../handlers/billing';

export interface UsageChargeInput {
  /** ai_assist | ai_call_min | sms | email。**必须分开计**（决策 8） */
  kind: string;
  /** 这次调用的**成本**，单位毫分。乘上加价率才是卖价 */
  costMillicents: number;
  /** 对应的那条 usage_events，能一路查回「这 3 分钱是哪次调用」 */
  usageEventId?: string | null;
}

export interface UsageChargeResult {
  /** 从余额里扣了多少分。走套餐内额度时是 0 */
  chargedCents: number;
  balanceAfterCents: number;
  /** 走套餐内额度时没有账本记录 */
  ledgerId: string | null;
  /** 这一次走的是套餐内额度还是预充值余额 */
  source: 'included' | 'balance';
  /** 套餐内还剩几次（只对 ai_assist 有意义） */
  includedRemaining: number;
}

/**
 * 扣一次用量。返回 null = 这次不该扣（金额舍入后是 0）。
 *
 * **金额为 0 时不记账本**：`ai_call_min` 现在的 `cost_cents` 恒为 0
 *（Telnyx 单价还没实测，09 §6），记一堆 $0.00 的流水只会把老板要看的
 * 那几笔真扣费淹掉。等单价填上了，同一段代码自然就开始扣了。
 */
export async function chargeUsage(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  input: UsageChargeInput,
): Promise<UsageChargeResult | null> {
  const chargedCents = usageChargeCents(input.costMillicents, input.kind);
  if (chargedCents <= 0) return null;

  // for update：两笔并发扣费必须在这一行上排队，
  // 否则各自读到同一个余额，账本上会留下一个对不齐的断点。
  // 套餐内额度的计数也靠这把锁 —— 不锁的话两次并发都读到 499，
  // 各自写 500，实际用了两次却只记了一次
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  /**
   * ⭐ **先用套餐里的**（老板 2026-08-17 拍板）。
   *
   * Essential 每期含 500 次副驾、Growth 2000 次。用满了才开始扣预充值余额。
   * 顺序反过来（先扣余额、月底再退套餐内的）在账单上完全说不清 ——
   * 老板看到的是「我明明还有额度，为什么在扣我的钱」。
   *
   * ⚠️ 只有 `ai_assist` 吃这个额度。电话分钟单独成包 —— 两者成本差
   * 10–16 倍，合成一个额度必被套利（决策 8）。
   */
  const decision = consumeIncluded(input.kind, acct.plan, acct.included_assists_used);
  if (decision.source === 'included') {
    await tx`
      update billing_accounts set
        included_assists_used = ${decision.usedAfter},
        included_period_start = coalesce(included_period_start, now())
      where id = ${acct.id}`;

    // 走套餐内额度**不记账本** —— 账本记的是钱的进出，
    // 而这一次没有钱动。用了多少次在 usage_events 里查得到
    return {
      chargedCents: 0,
      balanceAfterCents: acct.balance_cents,
      ledgerId: null,
      source: 'included',
      includedRemaining: decision.remaining,
    };
  }

  /**
   * ⚠️ **余额允许扣成负数**，这是有意的（`@gf/payroll/credits` 的长注释）。
   *
   * AI 调用已经发生了、钱已经花出去了 —— 拒绝记账不会把那次调用变没，
   * 只会让账本和现实对不上。欠着的部分下次充值时自动补上，
   * 而负余额会在老板端显红。
   */
  const { ledgerId, balanceAfterCents } = await appendLedger(tx, ctx, acct, {
    kind: 'usage',
    amountCents: -chargedCents,
    source: input.kind,
    usageEventId: input.usageEventId ?? null,
  });

  return {
    chargedCents, balanceAfterCents, ledgerId,
    source: 'balance',
    includedRemaining: 0,
  };
}

/** 套餐内还剩几次。前台那一屏要显示「本期还剩 431 次」 */
export function includedRemaining(plan: string, used: number): number {
  return Math.max(0, includedAssistsFor(plan) - used);
}
