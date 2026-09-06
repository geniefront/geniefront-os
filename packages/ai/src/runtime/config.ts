/**
 * Luna 模型运行时配置与常量 (29 §1.2, §3, §5)
 */

export const LUNA_MODEL = 'gpt-5.6-luna';

/** Luna 思考深度档位 */
export const LUNA_EFFORT = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

export type LunaEffort = typeof LUNA_EFFORT[keyof typeof LUNA_EFFORT];

/** 默认场景使用 medium 深度 */
export const LUNA_DEFAULT_EFFORT: LunaEffort = LUNA_EFFORT.MEDIUM;

/** 超时配置 (毫秒) */
export const LUNA_TIMEOUTS = {
  DEFAULT_MS: 120_000,
  VISION_MS: 180_000,
  TRANSLATION_MS: 60_000,
  FAST_MS: 30_000,
} as const;

/** 最大输出 token 预算 */
export const LUNA_MAX_OUTPUT_TOKENS = {
  COPILOT: 16_000,
  VISION: 32_000,
  DEFAULT: 8_000,
  TRANSLATE: 4_000,
} as const;

/** 前台副驾动态编排最多轮数 (29 §2) */
export const COPILOT_MAX_ROUNDS = 8;

/**
 * Luna 费率表 (单位: 毫分 / 每百万 Token)
 * $3.00 / MTok input = 300,000 毫分
 * $15.00 / MTok output = 1,500,000 毫分
 * 缓存读取 0.1x = 30,000 毫分
 * 缓存写入 1.25x = 375,000 毫分
 */
export const LUNA_RATES = {
  inputPerMTok: 300_000,
  outputPerMTok: 1_500_000,
  cacheReadPerMTok: 30_000,
  cacheWritePerMTok: 375_000,
} as const;
