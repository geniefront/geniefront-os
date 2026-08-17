/**
 * 预充值余额的纯逻辑（Phase 2，决策 8）
 *
 * 放在 `@gf/payroll` 里是因为这里已经是「算钱的纯函数都在这一个包」的地方 ——
 * 小费、提成、日结都在这儿，余额没有理由另开一处（宪法第 2 条）。
 *
 * 全程整数分。不出现一次浮点。
 */

/**
 * 充值只有**一档：$100**（AI 分钟包）。
 *
 * 原本是三档 $50/$100/$200。收窄成一档有两个理由：
 *   · Stripe 那边就一个 `GenieFront AI Minutes (200 mins)` 的价格，
 *     代码里摆三档而后台只有一个，迟早对不上
 *   · 档位越少，「让客户填任意金额」这条路越远 —— 任意金额会引来
 *     拿被盗的卡试活的人（$0.53、$1.07 那种试探性小额）
 *
 * ⚠️ **买了不会过期。** 余额是钱不是次数，用不完一直留着（决策 8 的
 * 「预充值」本意）。所以不需要「有效期」这个概念，也就没有到期作废的争议。
 */
export const TOPUP_TIERS = [10000] as const;
export type TopupTier = (typeof TOPUP_TIERS)[number];

export const isTopupTier = (v: number): v is TopupTier =>
  (TOPUP_TIERS as readonly number[]).includes(v);

/**
 * 两次自动续充之间的冷却。
 *
 * ⭐ 没有这个，卡被拒或者用量异常时一晚上能触发几十次扣款尝试。
 * 每一次都是客户账单上的一条失败记录，而银行看到连续失败会直接把卡冻了 ——
 * 那时候我们不只是没收到钱，是把客户的卡搞停了。
 */
export const TOPUP_COOLDOWN_MS = 10 * 60_000;

/** 连续失败几次就自动关掉自动续充，别再骚扰那张卡 */
export const MAX_TOPUP_FAILURES = 3;

export interface BillingAccountState {
  balanceCents: number;
  autoTopupEnabled: boolean;
  autoTopupThresholdCents: number;
  autoTopupAmountCents: number;
  lastAutoTopupAt: Date | null;
  autoTopupFailures: number;
  defaultPaymentMethodId: string | null;
  subscriptionStatus: string;
}

export type TopupDecision =
  | { charge: false; reason:
      | 'disabled' | 'above_threshold' | 'no_payment_method'
      | 'cooling_down' | 'too_many_failures' | 'subscription_inactive' }
  | { charge: true; amountCents: TopupTier };

/**
 * 该不该现在自动续充。
 *
 * **纯函数**，不碰 Stripe 也不碰数据库 —— 这样「什么时候扣客户的钱」
 * 这件事可以被完整地测，而不用真的去扣一次。
 *
 * 每一个 `charge: false` 的分支都有名字：出账单纠纷时要能回答
 * 「为什么那天没自动充上」，而不是耸肩。
 */
export function shouldAutoTopup(
  acct: BillingAccountState,
  now: Date = new Date(),
): TopupDecision {
  if (!acct.autoTopupEnabled) return { charge: false, reason: 'disabled' };

  // 订阅都停了就别再往余额里充钱 —— 客户已经在走流失流程，
  // 这时候扣他一笔 $50 是最容易变成投诉和拒付的操作
  if (!['active', 'trialing'].includes(acct.subscriptionStatus)) {
    return { charge: false, reason: 'subscription_inactive' };
  }

  if (!acct.defaultPaymentMethodId) return { charge: false, reason: 'no_payment_method' };
  if (acct.autoTopupFailures >= MAX_TOPUP_FAILURES) {
    return { charge: false, reason: 'too_many_failures' };
  }
  if (acct.balanceCents > acct.autoTopupThresholdCents) {
    return { charge: false, reason: 'above_threshold' };
  }
  if (acct.lastAutoTopupAt
      && now.getTime() - acct.lastAutoTopupAt.getTime() < TOPUP_COOLDOWN_MS) {
    return { charge: false, reason: 'cooling_down' };
  }

  // 档位存坏了（人工改库、或者以后加了新档又回滚）不能就这么扣一笔怪金额
  const amount = acct.autoTopupAmountCents;
  return isTopupTier(amount)
    ? { charge: true, amountCents: amount }
    : { charge: true, amountCents: TOPUP_TIERS[0] };
}

export interface LedgerEntryInput {
  kind: 'topup' | 'usage' | 'refund' | 'adjustment' | 'reversal';
  amountCents: number;
  reason?: string;
}

export interface LedgerEntry extends LedgerEntryInput {
  balanceAfterCents: number;
}

/**
 * 记一笔账。返回这一笔之后的余额。
 *
 * ⚠️ **余额允许为负**。这是有意的：AI 调用已经发生了、钱已经花出去了，
 * 拒绝记账不会把那次调用变没，只会让账本和现实对不上。
 * 欠着的部分下次充值时自动补上，而余额为负会在老板端显红。
 *
 * 相反的做法（余额不足就拒绝扣费）会导致：用量照常发生、账上却看不到，
 * 到月底突然冒出一笔对不上的差额 —— 那时候谁也说不清是哪几次调用。
 */
export function applyEntry(balanceCents: number, entry: LedgerEntryInput): LedgerEntry {
  if (!Number.isInteger(entry.amountCents)) {
    throw new Error(`余额只用整数分，收到：${entry.amountCents}`);
  }
  // 调账和冲销必须写原因 —— 没有原因的调账是查不清的账
  if ((entry.kind === 'adjustment' || entry.kind === 'reversal') && !entry.reason?.trim()) {
    throw new Error(`${entry.kind} 必须写原因`);
  }
  // 方向和类型要对得上，否则「充值 −$50」这种行会悄悄混进账本
  if (entry.kind === 'topup' && entry.amountCents <= 0) {
    throw new Error('充值金额必须为正');
  }
  if (entry.kind === 'usage' && entry.amountCents >= 0) {
    throw new Error('用量扣费必须为负');
  }

  return { ...entry, balanceAfterCents: balanceCents + entry.amountCents };
}

/**
 * 拿账本重算余额，用来和缓存的 `balance_cents` 对账。
 *
 * 账本是事实，缓存只是为了不用每次都把整张表加起来。
 * 两者对不上说明有人绕过账本改了余额 —— 那是要当事故查的。
 */
export function replayBalance(entries: readonly { amountCents: number }[]): number {
  return entries.reduce((sum, e) => sum + e.amountCents, 0);
}

/**
 * 账本自洽性检查：每一行的 `balanceAfterCents` 必须等于前一行加上本行金额。
 *
 * 任何一行被就地改过，这个检查都会指出**第一个**对不上的位置。
 */
export function findLedgerBreak(
  entries: readonly { amountCents: number; balanceAfterCents: number }[],
  startingBalance = 0,
): number | null {
  let running = startingBalance;
  for (let i = 0; i < entries.length; i++) {
    running += entries[i]!.amountCents;
    if (running !== entries[i]!.balanceAfterCents) return i;
  }
  return null;
}

/**
 * 一次 AI 调用要从余额里扣多少。
 *
 * 传进来的是**成本**（毫分），乘上加价率就是卖价。
 * 加价率放在这里而不是散在各处：调价是一次改一个数的事。
 *
 * `04` §4.1：副驾成本极低，额度给得大方就是纯卖点；
 * 电话是真金白银，单独成包、单独计价。所以两者的加价率不同。
 */
export const MARKUP_BP: Record<string, number> = {
  ai_assist: 30000,     // 3.0x —— 成本 ~$0.012，卖 ~$0.036
  ai_call_min: 15000,   // 1.5x —— 本来就贵，加太多没人用
  sms: 20000,
  email: 20000,
};

export function usageChargeCents(costMillicents: number, kind: string): number {
  const bp = MARKUP_BP[kind] ?? 10000;
  // 毫分 × bp / 10000 = 毫分；再 /1000 变成分。**向上取整** ——
  // 每次少收一点点，累计起来就是我们在替客户付 AI 的钱
  return Math.ceil((costMillicents * bp) / 10000 / 1000);
}

// ─────────────────────────────────────────────────── 套餐内额度（先用套餐里的）

/** 套餐。和 Stripe 后台的产品名对齐（Essential $99 / Growth $199） */
export const PLANS = ['essential', 'growth'] as const;
export type Plan = (typeof PLANS)[number];

export const isPlan = (v: unknown): v is Plan =>
  typeof v === 'string' && (PLANS as readonly string[]).includes(v);

/**
 * 每个套餐每期含多少次副驾（决策 8）。
 *
 * ⚠️ **只含副驾，不含电话分钟。** 两者成本差 10–16 倍，合成一个「额度」
 * 必被套利 —— 电话量大的店会把额度全用在最贵的地方，而那恰恰是最忙、
 * 最该赚钱的客户（`04` §4.1）。电话走单独的分钟包。
 *
 * 试用期按 essential 给：额度不能是无限的，否则试用期会被薅（`04` §4.2）。
 */
export const PLAN_INCLUDED_ASSISTS: Record<Plan, number> = {
  essential: 500,
  growth: 2000,
};

export function includedAssistsFor(plan: string): number {
  return isPlan(plan) ? PLAN_INCLUDED_ASSISTS[plan] : PLAN_INCLUDED_ASSISTS.essential;
}

export type IncludedDecision =
  /** 这一次走套餐内额度，不扣余额 */
  | { source: 'included'; usedAfter: number; remaining: number }
  /** 套餐内额度用完了，扣余额 */
  | { source: 'balance'; remaining: 0 };

/**
 * 这一次该走套餐内额度还是扣余额。**先用套餐里的**。
 *
 * 纯函数，因为「这次为什么扣钱了」是客户会打电话来问的问题 ——
 * 它必须能被完整地测，而不是埋在一段 SQL 里。
 *
 * ⚠️ 只有 `ai_assist` 吃套餐额度。电话分钟和短信各有各的包，
 * 让它们共用一个计数就是决策 8 明确要避免的那种套利。
 */
export function consumeIncluded(
  kind: string, plan: string, usedThisPeriod: number,
): IncludedDecision {
  if (kind !== 'ai_assist') return { source: 'balance', remaining: 0 };

  const included = includedAssistsFor(plan);
  if (usedThisPeriod >= included) return { source: 'balance', remaining: 0 };

  const usedAfter = usedThisPeriod + 1;
  return { source: 'included', usedAfter, remaining: included - usedAfter };
}
