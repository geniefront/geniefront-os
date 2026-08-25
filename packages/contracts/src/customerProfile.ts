/**
 * 客人偏好的 schema（批 6）。
 *
 * ## 为什么要把 key 定死
 *
 * `customer_preferences.profile` 是一列自由 jsonb。库里装得下任何东西 ——
 * 而这正是问题：前端重做的时候，两边对 key 的拼写、取值、单位各写一套，
 * 而不一致的表现是「前台改了力度，技师端看不到」，
 * 没有报错、没有日志，只有客人抱怨。
 *
 * 所以 key 和取值在这里定死，两端都从这里读。加一项要改这个文件，
 * 而那正是我们希望它发生的地方。
 *
 * ## 取值都是枚举，不是自由文本
 *
 * 「力度：偏重一点但肩膀轻一点」这种写在 `notes` 里。
 * 枚举的意义是**能筛能派单** —— 尤其 `serviceLanguage`：
 * 客人要中文，派单时就该把不会中文的技师排除掉。自由文本做不到这件事。
 */

import { z } from 'zod';

export const PRESSURE = ['gentle', 'moderate', 'firm'] as const;
export const MUSIC = ['light', 'nature', 'silent'] as const;
export const AROMA = ['none', 'basic', 'moderate', 'premium'] as const;
export const ROOM_TEMP = ['warm', 'neutral', 'cool'] as const;
export const STAFF_GENDER = ['any', 'male', 'female'] as const;
/** ⭐ 和界面语言用同一套码，不另起一套 —— 两套码迟早对不上 */
export const SERVICE_LANGUAGE = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'] as const;
/** 重点部位。和健康表的 `avoid_areas` 是**两回事**：一个要多做，一个不能碰 */
export const FOCUS_AREAS = [
  'neck', 'shoulders', 'upper_back', 'lower_back', 'arms', 'hips', 'legs', 'feet',
] as const;

export const customerProfileSchema = z.object({
  pressure: z.enum(PRESSURE).optional(),
  music: z.enum(MUSIC).optional(),
  aroma: z.enum(AROMA).optional(),
  roomTemp: z.enum(ROOM_TEMP).optional(),
  /**
   * ⚠️ 和 `customer_preferences.preferred_gender` 是**同一件事的两处**。
   * 那一列是事实源（派单引擎读它），这里只是给界面用的镜像。
   * 写的时候两处一起写 —— 只写 jsonb 的话派单不会生效。
   */
  staffGender: z.enum(STAFF_GENDER).optional(),
  /** ⭐ 华人店的刚需。派单时能按它过滤技师 */
  serviceLanguage: z.enum(SERVICE_LANGUAGE).optional(),
  focusAreas: z.array(z.enum(FOCUS_AREAS)).max(8).optional(),
}).strict();

export type CustomerProfile = z.infer<typeof customerProfileSchema>;

/**
 * 读一份可能很旧、可能被手改过的 profile。
 *
 * ⚠️ **认不出的 key 一律丢掉，不报错。** 这一列是历史遗留的自由 jsonb，
 * 里面一定有当初随手塞进去的东西。为一个拼错的 key 让整个客户详情页
 * 打不开，是最没必要的一种故障。
 */
export function readCustomerProfile(raw: unknown): CustomerProfile {
  const parsed = customerProfileSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // 逐项挑出合法的那些 —— 部分正确好过整份丢掉
  const out: Record<string, unknown> = {};
  const obj = (raw ?? {}) as Record<string, unknown>;
  for (const [key, shape] of Object.entries(customerProfileSchema.shape)) {
    const v = shape.safeParse(obj[key]);
    if (v.success && obj[key] !== undefined) out[key] = v.data;
  }
  return out as CustomerProfile;
}
