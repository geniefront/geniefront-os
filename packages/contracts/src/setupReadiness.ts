import { z } from 'zod';
import { aiVoiceReadiness } from './aiVoiceReadiness.js';

export const SETUP_STEP_IDS = [
  'store', 'directory', 'rooms', 'catalog', 'team', 'features', 'launch',
] as const;
export const setupStepId = z.enum(SETUP_STEP_IDS);
export type SetupStepId = z.infer<typeof setupStepId>;

export const SETUP_MISSING_CODES = [
  'profile', 'business_hours', 'active_room', 'active_service', 'bookable_staff',
] as const;
export const setupMissingCode = z.enum(SETUP_MISSING_CODES);
export type SetupMissingCode = z.infer<typeof setupMissingCode>;

export const SETUP_WARNING_CODES = [
  'directory_recommended', 'active_room_repair',
  // 店主已勾选「要 AI 电话」但落地号 / 工具 token 还没就绪。
  // 只是提示，**不阻塞开店**：外部号码准备状态与门店营业无关（S1 §3）。
  'ai_voice_pending',
] as const;
export const setupWarningCode = z.enum(SETUP_WARNING_CODES);
export type SetupWarningCode = z.infer<typeof setupWarningCode>;

export const setupReadinessItem = z.object({
  code: setupMissingCode,
  stepId: setupStepId,
});

export const setupReadinessWarning = z.object({
  code: setupWarningCode,
  stepId: setupStepId,
});

export const setupReadiness = z.object({
  locationId: z.string().uuid(),
  status: z.string(),
  canLaunch: z.boolean(),
  steps: z.array(z.object({ id: setupStepId, complete: z.boolean() })),
  missing: z.array(setupReadinessItem),
  warnings: z.array(setupReadinessWarning),
  /**
   * AI 电话线就绪状态。向导「功能设置」这一步与「来电记录」页共用同一份
   * 推导。功能关着（`intent` 非 true）时 `state` 为 `unconfigured`，`features`
   * 步骤仍可完成、`canLaunch` 不受影响。
   */
  aiVoice: aiVoiceReadiness,
  /** 「功能设置」步骤的当前选择，供向导回填开关。 */
  features: z.object({
    /** 健康表开关。老店缺字段为 null（legacy：有发布版即启用）。 */
    healthFormsEnabled: z.boolean().nullable(),
    /** 功能步骤确认时间；非空即步骤已确认。 */
    confirmedAt: z.string().nullable(),
  }),
});
export type SetupReadiness = z.infer<typeof setupReadiness>;

/** Compatibility names consumed by the pre-readiness FinishSetup error UI. */
export const LEGACY_SETUP_MISSING_BY_CODE: Record<SetupMissingCode, string> = {
  profile: 'profile',
  business_hours: 'business_hours',
  active_room: 'active_room',
  active_service: 'active_service',
  bookable_staff: 'bookable_staff',
};
