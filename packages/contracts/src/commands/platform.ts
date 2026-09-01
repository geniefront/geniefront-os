/**
 * Platform operator mutation inputs.
 *
 * These are NOT registered on the customer command bus. They are invoked
 * only through /v1/platform after server-side operator authorization.
 * Names are recorded in audit_log.command.
 */

import { z } from 'zod';

export const platformTenDlcAction = z.enum([
  'under_review',
  'request_changes',
  'reject',
  'approve_internal',
]);

export const PlatformReview10DlcInput = z.object({
  locationId: z.string().uuid(),
  action: platformTenDlcAction,
  notes: z.string().trim().max(4000).optional(),
});

/**
 * 营销发件域名的运营动作。
 *
 * ⚠️ 没有「直接填一个地址」这个选项。
 *
 * 手填意味着一个笔误就把营销邮件指到一个不存在的地址上 —— 而后果不是
 * 报错，是**整批退信**，而退信率同样计入发信域名信誉。因此启用这条路
 * 只有一种走法：由服务端去问 SES「这个域名验过没有」，验过了才写库。
 *
 *   check   向 SES 核验，通过则写入 locations.marketing_email_from
 *   disable 清空该列，营销邮件立刻停发（不动 SES 上的域名身份）
 */
export const platformMarketingEmailAction = z.enum(['check', 'disable']);

export const PlatformSetMarketingEmailInput = z.object({
  locationId: z.string().uuid(),
  action: platformMarketingEmailAction,
  /**
   * 子域标签。不传就按 `locations.slug` 推算
   * （`domainLabelFromSlug`：去掉随机后缀、只留字母数字）。
   *
   * ⚠️ 两家同名门店会算出同一个标签，而域名必须唯一 —— 那时第二家叫什么
   * 由运营在这里显式指定。**不自动加数字后缀**：`lotusspa2@…` 看起来
   * 就像仿冒。
   */
  label: z.string().trim().regex(/^[a-z0-9]{2,40}$/, '只能是 2–40 位小写字母或数字').optional(),
});

export const platformSupportStatus = z.enum([
  'open', 'in_progress', 'waiting', 'resolved', 'closed',
]);

export const PlatformUpdateSupportRequestInput = z.object({
  requestId: z.string().uuid(),
  status: platformSupportStatus.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignedOperatorId: z.string().uuid().nullable().optional(),
});

export const PlatformAddSupportNoteInput = z.object({
  requestId: z.string().uuid(),
  body: z.string().trim().min(1).max(8000),
});

export const platformStorefrontBriefAction = z.enum(['mark_drafted']);

export const PlatformUpdateStorefrontBriefInput = z.object({
  briefId: z.string().uuid(),
  action: platformStorefrontBriefAction,
});

export const platformRevisionStatus = z.enum([
  'submitted', 'in_progress', 'accepted', 'declined',
]);

export const PlatformUpdateStorefrontRevisionInput = z.object({
  revisionId: z.string().uuid(),
  status: platformRevisionStatus,
  response: z.string().trim().max(4000).optional(),
});
