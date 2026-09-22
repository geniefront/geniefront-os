/**
 * 额度与充值的纯逻辑（Phase 2，决策 8 / `04` §4.1）
 *
 * 放在 `@gf/payroll` 里是因为这里已经是「算钱的纯函数都在这一个包」的地方 ——
 * 小费、提成、日结都在这儿，额度没有理由另开一处（宪法第 2 条）。
 *
 * 全程整数。不出现一次浮点。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## 两种额度，各自独立，**不能互换**
 *
 *   · **AI 积分**（`credit`）—— 副驾、拍照开店，一切走模型的操作
 *   · **AI 语音分钟**（`voice_minute`）—— AI 接电话
 *
 * ⚠️ **不提供任何换算**。这不是偷懒，是决策 8 的核心：
 * 一分钟电话的成本是一次副驾的 5–6 倍，只要两者能换，客户就会把额度
 * 全换成最贵的那种用 —— 而那恰恰是最忙、最该赚钱的客户。
 * 想加「1 积分换 X 分钟」的时候，回来读这一句。
 *
 * ## 1 积分 = $0.01 的真实成本（向上取整）
 *
 * 不是拍脑袋定的：实测一次典型的副驾操作成本就是 ~$0.01
 *（`05` §6.0），所以「平均一次操作扣 1 积分」自然成立。
 * 而拍照开店走 Opus、一张 $0.08，按同一个尺子自动扣 8 积分 ——
 * 不需要为它单独定一套规则，也不会有人拿它当免费午餐。
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────── 额度单位

/** 两种额度。**没有第三种，也没有互换** */
export const QUOTA_UNITS = ['credit', 'voice_minute'] as const;
export type QuotaUnit = (typeof QUOTA_UNITS)[number];

export const isQuotaUnit = (v: unknown): v is QuotaUnit =>
  typeof v === 'string' && (QUOTA_UNITS as readonly string[]).includes(v);

/**
 * 1 积分对应多少毫分的**真实成本**。
 *
 * $0.01 = 1 分 = 1000 毫分。实测一次典型副驾操作就是这个数（`05` §6.0）。
 */
export const MILLICENTS_PER_CREDIT = 1000;

/**
 * 一次调用扣几个积分。**向上取整** —— 每次少收一点点，
 * 累计起来就是我们在替客户付 AI 的钱。
 *
 * 成本为 0（缓存全命中、或者关键词直接答的）返回 0，调用方据此跳过扣费。
 */
export function creditsFor(costMillicents: number): number {
  if (costMillicents <= 0) return 0;
  return Math.ceil(costMillicents / MILLICENTS_PER_CREDIT);
}

/** 一通电话扣几分钟。29 秒也算一分钟 —— 电话行业的通行口径 */
export function minutesFor(durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

// ─────────────────────────────────────────────────────────────────── 套餐

/** 套餐。和 Stripe 后台的产品名对齐（Essential $99 / Growth $199） */
export const PLANS = ['voice_booking', 'essential', 'growth'] as const;
export type Plan = (typeof PLANS)[number];

export const isPlan = (v: unknown): v is Plan =>
  typeof v === 'string' && (PLANS as readonly string[]).includes(v);

/**
 * Public display prices in integer cents (decision 8 / docs/11).
 *
 * Stripe Price IDs stay in env (`STRIPE_PRICE_ESSENTIAL` / `STRIPE_PRICE_GROWTH`).
 * These cents are what marketing and emails may render. They must never be sent
 * to Stripe as a custom amount — Checkout always uses `priceIdFor(plan)`.
 */
export const PLAN_PRICES_CENTS: Record<Plan, number> = {
  voice_booking: 9900,
  essential: 9900,
  growth: 19900,
};

export interface PlanQuota {
  /** 每期含多少 AI 积分 */
  credits: number;
  /** 每期含多少 AI 语音分钟 */
  voiceMinutes: number;
}

/**
 * 套餐内含的额度（2026-08-17 定，算账过程见 `04` §4.1.1）。
 *
 * ⚠️ **Essential 的 60 分钟 ≈ 每天 1 通电话，是「尝鲜」不是「够用」。**
 * 这是有意的：语音是成本大头（一分钟 $0.062，是一次副驾的 6.2 倍），
 * Essential 给 200 分钟的话它自己的毛利会从 91% 掉到 82%，
 * 而且**没人会升级到 Growth** —— 实测三种配法之后才定的这一刀。
 *
 * 销售时必须直说：开店时问一句「一天大概接几通电话」，
 * 超过 2 通就直接推 Growth，别让老板自己撞上账单。
 */
export const PLAN_QUOTAS: Record<Plan, PlanQuota> = {
  voice_booking: { credits: 0, voiceMinutes: 200 },
  essential: { credits: 500, voiceMinutes: 60 },
  growth: { credits: 1200, voiceMinutes: 500 },
};

/**
 * 认不出的套餐按**最小的**给。
 *
 * 试用期、或者以后加了新档又回滚，都会走到这一支。给无限额度的话
 * 试用期会被薅（`04` §4.2）。
 */
export function planQuota(plan: string): PlanQuota {
  return isPlan(plan) ? PLAN_QUOTAS[plan] : PLAN_QUOTAS.essential;
}

/**
 * ⭐ **试用期额度是单独一档，不是套餐额度按天折算。**
 *
 * 七天给 Essential 一整期的额度，等于白送一个月的量给一个还没付钱的人 ——
 * 而 AI 语音一分钟 $0.062，这是可以被薅的（`04` §4.2）。
 * 按天折算（500/30×7 ≈ 117）也不对：那是个会随套餐定价漂动的隐式公式，
 * 改一次套餐额度就会顺带改掉试用成本，而没有人会想到去看。
 *
 * 所以写死两个数，理由各自说清楚：
 *   · **150 积分** —— 副驾一次 1 积分，够他把前台的活真的过一遍
 *   · **20 分钟** —— AI 电话一通约 3 分钟，够接六七通。
 *     少于这个数他试不出「AI 到底能不能接住我的电话」，
 *     多于这个数就够一家小店白用一周
 *
 * 试用期**超额直接拒绝，不自动续充**（见 `chargeQuota` 的 trialing 分支）：
 * 一个还没付过一分钱的账户不该能触发自动扣款。
 */
export const TRIAL_QUOTA: PlanQuota = { credits: 150, voiceMinutes: 20 };

/** 试用期天数。改这个数要同步改 Stripe Checkout 的 trial_period_days */
export const TRIAL_DAYS = 7;

export function includedFor(plan: string, unit: QuotaUnit, trialing = false, manualVoiceMinutes: number | null = null, billingSource = 'license'): number {
  // Stripe overrides apply only while trialing; paid subscriptions keep their plan quota.
  const useOverride = billingSource === 'license' || (billingSource === 'stripe' && trialing);
  if (unit === 'voice_minute' && manualVoiceMinutes !== null && useOverride) return manualVoiceMinutes;
  const q = trialing ? TRIAL_QUOTA : planQuota(plan);
  return unit === 'credit' ? q.credits : q.voiceMinutes;
}

// ─────────────────────────────────────────────────────────────────── 充值

/**
 * 一次充值固定 **$50**，买到多少单位。
 *
 * 单价：积分 $0.05/个（成本 $0.01 → 80% 毛利）、
 *       语音 $0.25/分钟（成本 $0.062 → 78% 毛利）。
 *
 * ⚠️ **只有一个金额档**。让客户填任意金额会引来拿被盗的卡试活的人
 *（$0.53、$1.07 那种试探性小额是盗卡验证的标准手法）。
 * 而且档位越少，「这次扣了我多少」越不会有歧义。
 *
 * ⚠️ 买了**不会过期** —— 用不完一直留着，所以没有到期作废的争议。
 */
export const TOPUP_PRICE_CENTS = 5000;

export const TOPUP_UNITS: Record<QuotaUnit, number> = {
  credit: 1000,
  voice_minute: 200,
};

export function unitsPerTopup(unit: QuotaUnit): number {
  return TOPUP_UNITS[unit];
}

// ─────────────────────────────────────────────────────── 先用套餐里的

export type QuotaSource =
  /** 走套餐内额度，不动充值余额 */
  | 'included'
  /** 套餐内用完了，扣充值买来的余额 */
  | 'balance';

export interface QuotaDecision {
  source: QuotaSource;
  /** 从套餐内额度扣掉几个 */
  fromIncluded: number;
  /** 从充值余额扣掉几个 */
  fromBalance: number;
  /** 扣完之后套餐内还剩几个 */
  includedRemaining: number;
  /** 扣完之后充值余额还剩几个。**可以是负数** */
  balanceAfter: number;
}

/**
 * 这一次该从哪儿扣。**先用套餐里的**。
 *
 * ⭐ 顺序反过来（先扣充值余额、月底再退套餐内的）在账单上完全说不清 ——
 * 老板看到的是「我明明还有额度，为什么在扣我买的分钟」。
 *
 * ⚠️ **一次可以跨两边扣**：套餐内还剩 3 个而这次要扣 8 个，
 * 就是 3 个走额度 + 5 个走余额。不做「不够就整笔走余额」——
 * 那会让老板白白浪费掉最后那几个额度。
 *
 * ⚠️ **余额允许扣成负数**，这是有意的：AI 调用已经发生了、钱已经花出去了，
 * 拒绝记账不会把那次调用变没，只会让账本和现实对不上。
 * 欠着的部分下次充值时自动补上，而负余额会在老板端显红。
 */
export function allocateQuota(
  amount: number,
  opts: {
    plan: string; unit: QuotaUnit; includedUsed: number; balance: number;
    /**
     * 本期套餐内额度的总数。调用方算好了就传进来。
     *
     * ⭐ 不传的话这里按 `plan` 现算，而那个算法**不知道账户在不在试用期**，
     * 也不知道它有没有接过计费 —— 于是试用期会按整档套餐（500）而不是
     * 试用档（150）扣，一家从没订阅过的店会拿到一整份 Essential 额度。
     * 判据只应该有一处（`includedTotalOf`），这个参数就是那一处的出口。
     */
    includedTotal?: number;
  },
): QuotaDecision {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`额度只用非负整数，收到：${amount}`);
  }

  const included = opts.includedTotal ?? includedFor(opts.plan, opts.unit);
  const includedLeft = Math.max(0, included - opts.includedUsed);

  const fromIncluded = Math.min(amount, includedLeft);
  const fromBalance = amount - fromIncluded;

  return {
    // 只要有一部分走了余额，这一次就算「扣钱了」—— 老板端要显示成扣费
    source: fromBalance > 0 ? 'balance' : 'included',
    fromIncluded,
    fromBalance,
    includedRemaining: includedLeft - fromIncluded,
    balanceAfter: opts.balance - fromBalance,
  };
}

// ─────────────────────────────────────────────────────────────── 自动续充

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

/**
 * 自动续充的默认触发线。
 *
 * 定得太低会在半夜断服务（前台正忙着，副驾突然不能用了），
 * 太高等于一直在充钱。按「大约还能撑半天」取的。
 */
export const DEFAULT_TOPUP_THRESHOLD: Record<QuotaUnit, number> = {
  credit: 50,
  voice_minute: 20,
};

export interface AutoTopupState {
  /** 当前充值余额（该单位的） */
  balance: number;
  enabled: boolean;
  thresholdUnits: number;
  lastAt: Date | null;
  failures: number;
  defaultPaymentMethodId: string | null;
  subscriptionStatus: string;
  /** 套餐内还剩多少 —— 套餐内还有额度就不该急着充 */
  includedRemaining: number;
}

export type TopupDecision =
  | { charge: false; reason:
      | 'disabled' | 'above_threshold' | 'no_payment_method'
      | 'cooling_down' | 'too_many_failures' | 'subscription_inactive'
      | 'included_remaining' }
  | { charge: true; priceCents: number; units: number };

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
  unit: QuotaUnit,
  acct: AutoTopupState,
  now: Date = new Date(),
): TopupDecision {
  if (!acct.enabled) return { charge: false, reason: 'disabled' };

  // 订阅都停了就别再往余额里充钱 —— 客户已经在走流失流程，
  // 这时候扣他一笔 $50 是最容易变成投诉和拒付的操作
  if (!['active', 'trialing'].includes(acct.subscriptionStatus)) {
    return { charge: false, reason: 'subscription_inactive' };
  }

  if (!acct.defaultPaymentMethodId) return { charge: false, reason: 'no_payment_method' };
  if (acct.failures >= MAX_TOPUP_FAILURES) {
    return { charge: false, reason: 'too_many_failures' };
  }

  /**
   * ⭐ 套餐内还有额度就不充。
   *
   * 少了这一条，一个刚续期、套餐额度满格的账户会因为「充值余额是 0」
   * 而立刻被扣 $50 —— 而他这个月根本用不到充值余额。
   */
  if (acct.includedRemaining > 0) return { charge: false, reason: 'included_remaining' };

  if (acct.balance > acct.thresholdUnits) return { charge: false, reason: 'above_threshold' };

  if (acct.lastAt && now.getTime() - acct.lastAt.getTime() < TOPUP_COOLDOWN_MS) {
    return { charge: false, reason: 'cooling_down' };
  }

  return { charge: true, priceCents: TOPUP_PRICE_CENTS, units: unitsPerTopup(unit) };
}

// ─────────────────────────────────────────────────────────────────── 账本

export interface LedgerEntryInput {
  kind: 'topup' | 'usage' | 'refund' | 'adjustment' | 'reversal';
  unit: QuotaUnit;
  /** 有符号。充值为正，扣费为负 */
  amount: number;
  reason?: string;
}

export interface LedgerEntry extends LedgerEntryInput {
  balanceAfter: number;
}

/**
 * 记一笔账。返回这一笔之后的余额。
 *
 * ⚠️ **余额允许为负**（见 `allocateQuota` 的长注释）。
 */
export function applyEntry(balance: number, entry: LedgerEntryInput): LedgerEntry {
  if (!Number.isInteger(entry.amount)) {
    throw new Error(`额度只用整数，收到：${entry.amount}`);
  }
  if (!isQuotaUnit(entry.unit)) {
    throw new Error(`未知的额度单位：${entry.unit}`);
  }
  // 调账和冲销必须写原因 —— 没有原因的调账是查不清的账
  if ((entry.kind === 'adjustment' || entry.kind === 'reversal') && !entry.reason?.trim()) {
    throw new Error(`${entry.kind} 必须写原因`);
  }
  // 方向和类型要对得上，否则「充值 −1000」这种行会悄悄混进账本
  if (entry.kind === 'topup' && entry.amount <= 0) {
    throw new Error('充值必须为正');
  }
  if (entry.kind === 'usage' && entry.amount >= 0) {
    throw new Error('用量扣费必须为负');
  }

  return { ...entry, balanceAfter: balance + entry.amount };
}

/**
 * 拿账本重算余额，用来和缓存的余额对账。
 *
 * ⚠️ **按单位分开算** —— 积分和分钟各有各的链条，混在一起加
 * 得到的是一个没有意义的数。
 */
export function replayBalance(
  entries: readonly { unit: QuotaUnit; amount: number }[],
  unit: QuotaUnit,
): number {
  return entries.filter((e) => e.unit === unit)
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * 账本自洽性检查：每一行的 `balanceAfter` 必须等于**同单位**前一行加上本行。
 *
 * 任何一行被就地改过，这个检查都会指出**第一个**对不上的位置
 *（返回的是在该单位序列里的下标）。
 */
export function findLedgerBreak(
  entries: readonly { unit: QuotaUnit; amount: number; balanceAfter: number }[],
  unit: QuotaUnit,
  startingBalance = 0,
): number | null {
  let running = startingBalance;
  const own = entries.filter((e) => e.unit === unit);
  for (let i = 0; i < own.length; i++) {
    running += own[i]!.amount;
    if (running !== own[i]!.balanceAfter) return i;
  }
  return null;
}
