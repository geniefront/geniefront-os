/**
 * AI 用量计价（05 §7.3）
 *
 * 全程整数（宪法第 4 条）。单位是 **毫分**（1/1000 分，millicent）——
 * 不是洁癖：一次价目表提取大约 2.4 分，四舍五入到分之后，
 * 把一家店一个月的调用加起来会漂出百分之几。而这个数字是
 * 「副驾额度包卖多少钱」的计算基础（决策 8），漂不得。
 *
 * `usage_events.cost_cents` 仍然存整数分（表结构如此），
 * 精确的毫分同时写进 `meta`，出账单时用后者。
 */

/** 每百万 token 的价格，单位毫分。$5.00 = 500 分 = 500_000 毫分 */
export interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  /** 缓存命中读取，官方是输入价的 0.1 倍 */
  cacheReadPerMTok: number;
  /** 写缓存，5 分钟 TTL 是 1.25 倍 */
  cacheWritePerMTok: number;
}

/**
 * claude-opus-5：$5 / $25 每百万 token（05 §7）。
 *
 * 价目表提取是**低频高价值**场景 —— 一家店一辈子做几次，一次几毛钱，
 * 而认错一个价格的代价是之后每一单都收错钱。这里不要为了省钱降模型
 * （决策 22 已经验证过：这正是选 Anthropic 而不是 DeepSeek 的原因）。
 */
export const OPUS_5_RATES: ModelRates = {
  inputPerMTok: 500_000,
  outputPerMTok: 2_500_000,
  cacheReadPerMTok: 50_000,
  cacheWritePerMTok: 625_000,
};

/**
 * Sonnet 5 的价格，单位毫分（$3 / $15 每百万 token，05 §7 说了别按优惠价算）。
 *
 * 仍在用的是价目表提取、门店文案生成、评价分析这几个 Sonnet 场景；
 * 前台副驾早已换到 Luna，费率见 `runtime/config.ts` 的 LUNA_RATES。
 */
export const SONNET_5_RATES: ModelRates = {
  inputPerMTok: 300_000,
  outputPerMTok: 1_500_000,
  cacheReadPerMTok: 30_000,
  cacheWritePerMTok: 375_000,
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** 一次调用花了多少毫分。整数除法，向上取整 —— 少收自己的钱比多收好。 */
export function costMillicents(u: TokenUsage, rates: ModelRates = OPUS_5_RATES): number {
  const parts =
    u.inputTokens * rates.inputPerMTok +
    u.outputTokens * rates.outputPerMTok +
    (u.cacheReadInputTokens ?? 0) * rates.cacheReadPerMTok +
    (u.cacheCreationInputTokens ?? 0) * rates.cacheWritePerMTok;
  return Math.ceil(parts / 1_000_000);
}

/** 折成整数分，写 `usage_events.cost_cents` 用 */
export function millicentsToCents(millicents: number): number {
  return Math.round(millicents / 1000);
}

/** 计量口径：`usage_events.qty` 记总 token 数（05 §7.3） */
export function billableTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens +
    (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
}

/** 多次调用（一次提取要跑 N 张图）的合计 */
export function sumUsage(list: readonly TokenUsage[]): TokenUsage {
  return list.reduce<TokenUsage>((a, u) => ({
    inputTokens: a.inputTokens + u.inputTokens,
    outputTokens: a.outputTokens + u.outputTokens,
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (a.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
}
