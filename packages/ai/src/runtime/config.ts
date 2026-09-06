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

/** 默认场景使用 low 深度以保障前台低延迟秒级响应 (可节约 15~20s 内部思考等待) */
export const LUNA_DEFAULT_EFFORT: LunaEffort = LUNA_EFFORT.LOW;

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

/**
 * 前台副驾动态编排最多轮数。
 *
 * 上一版是 12 —— 那是因为当时服务目录、员工、房间、排班、预约全都要靠
 * 工具一样一样查，一个复合请求光取数就能烧掉七八轮。现在这些数据随请求
 * 一次性下发，剩下的工具（找客户、算空档、查流水）单次请求很少用到两个
 * 以上，6 轮足够，而且轮数上限低本身就是一道护栏：模型陷进无意义的反复
 * 查询时能早点被打断去做收敛总结，而不是让前台干等十几秒。
 */
export const COPILOT_MAX_ROUNDS = 6;

/**
 * Luna 费率表 (单位: 毫分 / 每百万 Token；1 毫分 = 1/1000 美分)
 *
 * 来源：developers.openai.com/api/docs/pricing，2026-09-06 核对。
 *
 * | 档位 | input | cached input | cache write | output |
 * |---|---|---|---|---|
 * | 短上下文 | $0.20 | $0.02 | $0.25 | $1.20 |
 * | 长上下文 | $0.40 | $0.04 | $0.50 | $1.80 |
 *
 * ⚠️ **这张表不只是显示用**：`costMillicentsNormalized()` 的结果会经
 * `maybeAutoTopup()` 去扣门店的 AI 额度余额。填错就是在动客户的钱。
 *
 * 修订记录：此前这里抄的是 Sonnet 的 $3 / $15 —— input 高 15 倍、
 * output 高 12.5 倍、缓存读取高 15 倍，门店的 AI 额度一直在被超额扣减。
 * 2026-09-06 按官方价目表订正。已扣掉的额度需要另外回溯核对。
 *
 * 顺带一个持续有效的结论：output 是 input 的 6 倍价。优化方向是压缩
 * **模型输出**，不是压缩上下文 —— 上下文该给全就给全（见 storeContext.ts）。
 */
export const LUNA_RATES = {
  inputPerMTok: 20_000,
  outputPerMTok: 120_000,
  cacheReadPerMTok: 2_000,
  cacheWritePerMTok: 25_000,
} as const;

/**
 * 超长上下文档位：input 2 倍、output 1.5 倍，**整个请求**一起换档。
 *
 * 官方原文（模型页）：
 * > Prompts with >272K input tokens are priced at 2x input and 1.5x output
 * > for the full request.
 */
export const LUNA_LONG_CONTEXT_RATES = {
  inputPerMTok: 40_000,
  outputPerMTok: 180_000,
  cacheReadPerMTok: 4_000,
  cacheWritePerMTok: 50_000,
} as const;

/**
 * 换档阈值：输入 Token 总数（含命中缓存的部分）超过这个数就整单按长上下文计价。
 *
 * 副驾前置全量上下文之后单轮大约 3~6 万 token，离这条线还很远；
 * 真正会顶上去的是「几十轮长会话 + 多张截图」那种极端情况。
 */
export const LUNA_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
