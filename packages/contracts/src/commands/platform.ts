import { phoneE164 } from '../command.js';
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

// ────────────────────────────────────────── 订阅码（迁移 0120，计划批 2/6）

/**
 * 签发一张码。
 *
 * ## 为什么 `paymentNote` 必填
 *
 * 一张码就是一次「我们已经收到钱了」的断言。三个月后有人问「这家店为什么
 * 免费用到年底」，唯一能回答这个问题的东西就是这一行字。让它可空 =
 * 让这个问题在最需要答案的时候没有答案。
 *
 * ## 为什么面值 `amountCents` 只是留档
 *
 * 它不参与任何计算（宪法第 4 条只允许整数分，而这笔钱根本没进过我们的系统）。
 * 存它是为了对账：月底把私下收款的总额和银行 / 微信流水对一遍。
 */
export const PlatformIssueLicenseInput = z.object({
  kind: z.enum(['subscription', 'quota_pack', 'store_open']),

  /** subscription / store_open 必填 */
  plan: z.enum(['voice_booking', 'essential', 'growth']).optional(),
  /** 这张码买多少天。⚠️ 兑换那一刻才开始算 */
  durationDays: z.number().int().min(1).max(3650).optional(),

  /** quota_pack 必填。两种额度不能互换（决策 8），码上写死哪一种 */
  unit: z.enum(['credit', 'voice_minute']).optional(),
  amount: z.number().int().positive().max(1_000_000).optional(),

  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  paymentNote: z.string().trim().min(1, '收款说明不能为空').max(500),

  /** 定向到某家店。空 = 任意门店可兑换 */
  targetLocationId: z.string().uuid().optional(),
  /** 码本身多少天内有效（不是订阅有效期）。默认 90 天 */
  validForDays: z.number().int().min(1).max(365).default(90),
  maxRedemptions: z.number().int().min(1).max(50).default(1),
});

export const PlatformRevokeLicenseInput = z.object({
  codeId: z.string().uuid(),
  reason: z.string().trim().min(1, '撤销原因不能为空').max(500),
});

/**
 * 直接给一家店挂上订阅码额度（等价于「定向签发 + 立即兑换」）。
 *
 * ⚠️ 走的仍然是签发 + 兑换那一条路，**不另开写入口** ——
 * 两处分别写 entitlement，迟早在「清零」和「到期」上漂开，
 * 而漂开的表现是「有的店过期了还能用」。
 */
export const PlatformApplyLicenseInput = z.object({
  kind: z.enum(['subscription', 'quota_pack']),
  plan: z.enum(['voice_booking', 'essential', 'growth']).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
  unit: z.enum(['credit', 'voice_minute']).optional(),
  amount: z.number().int().positive().max(1_000_000).optional(),
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  paymentNote: z.string().trim().min(1, '收款说明不能为空').max(500),
});

/**
 * 改有效期。二选一：给一个绝对时刻，或者延 / 缩多少天。
 *
 * `note` 必填，理由同 `paymentNote` —— 改到期日是直接改「这家店能用到哪天」，
 * 没有原因的改动和一次误操作长得一模一样。
 */
export const PlatformUpdateLicensePeriodInput = z.object({
  periodEnd: z.string().datetime({ offset: true }).optional(),
  /** 负数 = 往回缩。范围钳在 ±3650 天 */
  extendDays: z.number().int().min(-3650).max(3650).optional(),
  note: z.string().trim().min(1, '改期原因不能为空').max(500),
}).refine(
  (v) => (v.periodEnd === undefined) !== (v.extendDays === undefined),
  { message: 'periodEnd 与 extendDays 必须且只能给一个' },
);

/** 立刻收回一家店的订阅码额度（改账户，**不改兑换历史**） */
export const PlatformRevokeStoreLicenseInput = z.object({
  reason: z.string().trim().min(1, '收回原因不能为空').max(500),
});

/**
 * 运营直接开店（不经 Stripe，计划批 6）。
 *
 * 幂等键是那张开店码 —— 重复提交返回同一家店，不会建出第二家。
 * 建店逻辑复用 `gf_provision_tenant()`：抄第二遍就一定会有一天两边不一致，
 * 而不一致的那一半是默认营业时间、角色预设这些「不会报错只会错着跑」的东西。
 */
export const PlatformCreateStoreInput = z.object({
  shopName: z.string().trim().min(1).max(80),
  ownerEmail: z.string().trim().email().max(254),
  plan: z.enum(['voice_booking', 'essential', 'growth']),
  /** 这次开店送多少天。到期后按 `expired` 冻结写入 */
  durationDays: z.number().int().min(1).max(3650),
  baseVoiceMinutes: z.number().int().min(0).max(1000000).optional(),
  businessType: z.enum(['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed'])
    .default('nail'),
  timezone: z.string().trim().min(1).max(64).default('America/New_York'),
  locale: z.enum(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']).default('en'),
  phone: phoneE164.optional(),
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  paymentNote: z.string().trim().min(1, '收款说明不能为空').max(500),
  /**
   * 建完店立刻发激活信（一次性登录链接）。
   *
   * ⚠️ 默认 true。默认不发的话，运营点完「开店」什么都没发生 ——
   * 而老板那边永远等不到那封信，也没人会发现（docs/12 §2.2）。
   */
  sendActivation: z.boolean().default(true),
});

export const PlatformVoiceQuotaInput = z.object({
  baseVoiceMinutes: z.number().int().min(0).max(1000000).nullable(),
  note: z.string().trim().min(1).max(500),
}).strict();
