import { z } from 'zod';

/**
 * AI 电话线的就绪五态。开店向导「功能设置」这一步与「来电记录」页
 * 共用同一份推导（`apps/api/src/queries/aiVoiceReadiness.ts`），因此
 * 形状冻结在 contracts。
 *
 * 五态之间是**推导**出来的，不落库：落一列状态就要有人维护它，而它
 * 和 `phone_lines` / `locations.settings.features` 随时会对不上。
 *
 *   · `unconfigured` —— 店主没表达过意愿，也没有绑定的落地号。
 *   · `requested`    —— 店主已勾选「要 AI 电话」（`features.ai_voice_requested`），
 *                       但平台还没把落地号绑好 / 工具 token 还没生成。开通是人工的。
 *   · `ready_off`    —— 落地号已绑、工具 token 已生成（本地可证明就绪），
 *                       但 `phone_lines.ai_answer = false`：店主还没打开今日接听。
 *   · `on`           —— 就绪且 `ai_answer = true`：现在打进来 AI 会接。
 *   · `suspended`    —— 店主意愿仍为 true，但曾经绑过的落地号已被停用
 *                       （`active = false`）：平台侧撤下了这条线（供应商故障 /
 *                       违规 / 欠费），需要重新开通。
 *
 * ⚠️ `assistantConfigured`（Telnyx 侧 assistant_id）只作展示，**不**参与
 * `ready` 判定：assistant 建在供应商那边，本仓库的种子与测试都不写它，
 * 而「本地 configured」与「真实 provider-ready」必须分开（S1 §5）。
 */
export const AI_VOICE_STATES = [
  'unconfigured', 'requested', 'ready_off', 'on', 'suspended',
] as const;
export const aiVoiceState = z.enum(AI_VOICE_STATES);
export type AiVoiceState = z.infer<typeof aiVoiceState>;

export const aiVoiceReadiness = z.object({
  /** 店主意愿。老店缺 `features.ai_voice_requested` 字段时为 null（legacy 语义）。 */
  intent: z.boolean().nullable(),
  /** 有一条 active 的 `ai_voice` 线绑给本店。 */
  lineBound: z.boolean(),
  /** Telnyx assistant 已配（`assistant_id` 非空）。仅展示，不参与 `ready`。 */
  assistantConfigured: z.boolean(),
  /** 电话工具 token 已生成（`tool_token_digest` 非空）。 */
  toolTokenSet: z.boolean(),
  /** 本地可证明的就绪：`lineBound && toolTokenSet`。不代表供应商侧一定能接。 */
  ready: z.boolean(),
  /** 实际是否会让 AI 接听。fail-closed：未就绪一律 false，与 telnyx/routes 同口径。 */
  effectiveAiAnswer: z.boolean(),
  state: aiVoiceState,
});
export type AiVoiceReadiness = z.infer<typeof aiVoiceReadiness>;
