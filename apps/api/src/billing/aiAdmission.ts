/**
 * AI 准入闸门（AUD-03）—— **在调模型之前**问三个问题。
 *
 * ## 为什么非有不可
 *
 * 原来的顺序是：查权限 → **调 Anthropic** → `ai.recordAssist` 记账。
 * 三件事因此同时成立：
 *
 * 1. **额度是可以扣成负数的**（`billing/usage.ts` 的长注释，那个决定本身是对的：
 *    调用已经发生、钱已经花出去了，拒绝记账只会让账本和现实对不上）。
 *    但它从来没有配一个「还没发生的调用要不要放行」的判断 ——
 *    于是余额可以无限往下掉，没有任何东西拦着。
 * 2. **没有任何限频**。`checkRateLimits` 只接在注册、找回密码、公开预约、
 *    表单链接和配对上，AI 路由一条都没有。
 * 3. **欠费冻结在 `dispatch()` 里面**。而模型调用在 `dispatch()` 外面、之前。
 *    于是一家 `past_due` 的店照样能烧掉真金白银的 token，
 *    只在最后记账那一步失败 —— 钱花了，`usage_events` 里**一行都没有**。
 *
 * 三条合起来是一个没有上界的成本敞口，而且账面上看不出来。
 *
 * ## 这一层做什么、不做什么
 *
 * 做：**准入**。欠费 → 拒；额度耗尽 → 拒；同一门店太频繁 → 拒。
 * 三种拒绝都发生在**一次 token 都没花掉之前**。
 *
 * 不做：**计量**。扣多少仍然由 `chargeQuota` 在调用之后按真实用量算，
 * 而且仍然允许扣成负数 —— 这一层挡的是「下一次」，不是「这一次」。
 * 那条纪律没有被改动：一次已经发生的调用永远如实入账。
 *
 * ⚠️ 判据故意宽松：**只要还有一点额度就放行**，不预估这次要花多少。
 * 预估是猜的，猜低了照样超支，猜高了会把一次本来做得完的操作拦掉 ——
 * 而后者是老板能直接看见的伤害。真正的上界由「用完之后下一次就拒」给出，
 * 单次的溢出最多是一次调用的成本，那是可接受的。
 */

import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { includedFor, type QuotaUnit } from '@gf/payroll';

/**
 * 欠费冻结的状态集合。和 `bus.ts` 的 FROZEN_STATUSES 是同一份判据。
 *
 * ⚠️ 只列**本地真的会出现**的值。`mapSubscriptionStatus` 把 Stripe 的七八种
 * 状态收敛成四态（none 由我们自己写），`unpaid` / `incomplete_expired`
 * 永远进不了库 —— 留在集合里会让人以为它们是活的判据。
 *
 * `none`（从未接过计费）**不在这里**：门店是真的，老板只是还没接上计费，
 * 把前台挡在门外解决不了任何问题。它的约束是「套餐内额度为 0」，在下面。
 */
const FROZEN_STATUSES = new Set(['past_due', 'canceled', 'expired']);

/**
 * 每家门店的 AI 调用限频。
 *
 * 内存计数就够，理由和 kiosk 那一处一样（宪法第 10 条：不自管状态）：
 * 两台实例各自限一半，攻击者的收益减半，而为这个引入 Redis 不划算。
 * 这里挡的是**脚本循环**，不是精确配额 —— 精确的那一层是额度本身。
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const HITS = new Map<string, { count: number; resetAt: number }>();

/** 仅供测试复位。生产里没有调用点。 */
export function __resetAiRateLimit(): void {
  HITS.clear();
}

function rateLimit(locationId: string): void {
  const now = Date.now();
  if (HITS.size > 5_000) {
    for (const [k, v] of HITS) if (v.resetAt < now) HITS.delete(k);
  }
  const cur = HITS.get(locationId);
  if (!cur || now > cur.resetAt) {
    HITS.set(locationId, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (++cur.count > MAX_PER_WINDOW) {
    throw new AppError(ERROR_CODES.AI_RATE_LIMITED, {
      details: { retryAfterMs: Math.max(0, cur.resetAt - now), limit: MAX_PER_WINDOW },
    });
  }
}

export interface AiAdmissionResult {
  unit: QuotaUnit;
  includedRemaining: number;
  balance: number;
}

/**
 * 调模型之前必须过这一关。
 *
 * @param unit 这次调用要消耗哪一种额度。积分和分钟**不能互换**（决策 8），
 *             所以两者各判各的，这个函数里没有任何换算。
 */
export async function assertAiAdmission(
  ctx: Pick<CommandContext, 'orgId' | 'locationId' | 'membershipId'>,
  unit: QuotaUnit = 'credit',
): Promise<AiAdmissionResult> {
  // 限频放最前面：它不查库，被脚本刷的时候正好省掉那次往返
  rateLimit(ctx.locationId);

  const [acct] = await withTenant(
    { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId ?? null },
    (tx) => tx<{
      subscription_status: string; plan: string;
      trial_ends_at: string | Date | null;
      credit_balance: number; voice_minute_balance: number;
      included_credits_used: number; included_minutes_used: number;
    }[]>`
      select subscription_status, plan, trial_ends_at,
             credit_balance, voice_minute_balance,
             included_credits_used, included_minutes_used
      from billing_accounts where location_id = ${ctx.locationId}`);

  // 查不到账户行 = 还没接计费（种子店、开发库、计费上线前建的老店）。
  // 和 `bus.ts` 的订阅闸门同一条纪律：放行。默认拒绝的话 `pnpm dev`
  // 起来第一件事就是全线报 402。
  if (!acct) return { unit, includedRemaining: Number.POSITIVE_INFINITY, balance: 0 };

  if (FROZEN_STATUSES.has(acct.subscription_status)) {
    throw new AppError(ERROR_CODES.SUBSCRIPTION_PAST_DUE, {
      details: { reason: 'ai_blocked', subscriptionStatus: acct.subscription_status },
    });
  }

  // 试用判据和 `handlers/billing.ts` 的 `isTrialing` 一致：看 trial_ends_at
  // 是不是还在未来，不看 status。status 在 Stripe 扣款那一刻就变 active，
  // 而本地要等 webhook 回来 —— 中间那几秒按 status 判会给错额度档位。
  const trialing = acct.trial_ends_at !== null
    && new Date(typeof acct.trial_ends_at === 'string'
      ? acct.trial_ends_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
      : acct.trial_ends_at.toISOString()).getTime() > Date.now();

  const used = unit === 'credit' ? acct.included_credits_used : acct.included_minutes_used;
  const balance = unit === 'credit' ? acct.credit_balance : acct.voice_minute_balance;
  /**
   * ⚠️ `none` = 从未接过计费 → 套餐内额度是 **0**（sql/0085）。
   * 判据和 `handlers/billing.ts` 的 `includedTotalOf` 必须一致：
   * 两处漂开的结果是「准入放行了但扣费时发现没额度」，账本会出现
   * 一笔没人解释得清的负数。
   */
  const includedTotal = acct.subscription_status === 'none'
    ? 0 : includedFor(acct.plan, unit, trialing);
  const includedRemaining = Math.max(0, includedTotal - used);

  if (includedRemaining <= 0 && balance <= 0) {
    throw new AppError(ERROR_CODES.AI_QUOTA_EXHAUSTED, {
      details: { unit, includedRemaining, balance, plan: acct.plan, trialing },
    });
  }

  return { unit, includedRemaining, balance };
}
