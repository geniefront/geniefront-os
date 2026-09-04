/**
 * 营销中心命令（P1 营销体系：次卡套餐 / 优惠券 / 会员积分）
 *
 * 统一接入 customer_credit_ledger 资产账本。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, basisPoints, phoneE164 } from '../command.js';

// ─────────────────────────────────────────────────────────── 套餐次卡 (Packages)

export const packageSaveTemplateInput = z.object({
  templateId: uuid.optional(),
  name: z.record(z.string(), z.string()).or(z.string().min(1)),
  priceCents: cents.refine((v) => v >= 0, '售价不能为负'),
  sessions: z.number().int().min(0, '次数不能为负数（0 表示无限次 Unlimited）'),
  serviceIds: z.array(uuid).default([]),
  validDays: z.number().int().min(1).optional().nullable(),
  scope: z.enum(['location', 'org']).default('location'),
  onlineSale: z.boolean().default(false),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});
export type PackageSaveTemplateInput = z.infer<typeof packageSaveTemplateInput>;

export const packageSaveTemplateOutput = z.object({
  templateId: uuid,
  created: z.boolean(),
});
export type PackageSaveTemplateOutput = z.infer<typeof packageSaveTemplateOutput>;

export const packageSaveTemplate = defineCommand({
  name: 'package.saveTemplate',
  input: packageSaveTemplateInput,
  output: packageSaveTemplateOutput,
  permission: 'catalog.manage',
  ai: {
    description: '创建或编辑次卡/套餐模板（名称、售价、包含项目及次数、有效期）',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const packageIssueInput = z.object({
  templateId: uuid,
  /** 已知客户 ID 时直接传；与 `customer` 二选一，两者都给时以此为准。 */
  customerId: uuid.optional(),
  /**
   * 前台只报了客人姓名（可能附手机号）时传这个，由 handler 解析成真实客户。
   * 与 `customerId` 二选一。
   *
   * ⚠️ 绝不按手机号单独自动匹配已有客户（宪法第 16 条）。复用只发生在
   * 「手机号 + 姓名都一模一样且库里只有一条」时，其余一律新建，事后由
   * 前台用 `customer.merge` 收口手滑建重的记录。语义对齐 appointment.create
   * 的 `guest.customer`。
   */
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    phoneE164: phoneE164.optional(),
    email: z.string().email().max(200).optional(),
  }).optional(),
  ticketId: uuid.optional(),
  priceCentsSnapshot: cents.optional(),
  soldPriceCentsOverride: cents.optional(),
  customSessions: z.number().int().min(1).optional(),
  validDays: z.number().int().min(1).optional(),
}).refine((d) => d.customerId != null || d.customer != null, {
  message: '缺少 customerId 或 customer（客户姓名）',
  path: ['customerId'],
});
export type PackageIssueInput = z.infer<typeof packageIssueInput>;

export const packageIssueOutput = z.object({
  packageId: uuid,
  customerId: uuid,
  totalSessions: z.number().int(),
  remainingSessions: z.number().int(),
});
export type PackageIssueOutput = z.infer<typeof packageIssueOutput>;

export const packageIssue = defineCommand({
  name: 'package.issue',
  input: packageIssueInput,
  output: packageIssueOutput,
  permission: 'ticket.write',
  ai: {
    description: '向客户发售/发放次卡套餐，并计入客户预付资产账本',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const marketingIssuePackage = defineCommand({
  name: 'marketing.issuePackage',
  input: packageIssueInput,
  output: packageIssueOutput,
  permission: 'ticket.write',
  ai: {
    description: '向客户发售/发放次卡套餐，并计入客户预付资产账本',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const packageRedeemInput = z.object({
  packageId: uuid.optional(),
  customerPackageId: uuid.optional(),
  customerId: uuid.optional(),
  ticketId: uuid.optional(),
  sessions: z.number().int().min(1).optional(),
  units: z.number().int().min(1).optional(),
  reason: z.string().max(200).optional(),
}).refine((d) => d.packageId || d.customerPackageId, { message: '缺少 packageId 或 customerPackageId' });
export type PackageRedeemInput = z.infer<typeof packageRedeemInput>;

export const packageRedeemOutput = z.object({
  packageId: uuid,
  remainingSessions: z.number().int(),
  redeemedSessions: z.number().int(),
  status: z.enum(['active', 'depleted', 'expired', 'void']),
});
export type PackageRedeemOutput = z.infer<typeof packageRedeemOutput>;

export const packageRedeem = defineCommand({
  name: 'package.redeem',
  input: packageRedeemInput,
  output: packageRedeemOutput,
  permission: 'ticket.write',
  ai: {
    description: '核销客户名下的套餐次卡项目，并在资产账本记录扣减',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const marketingRedeemPackage = defineCommand({
  name: 'marketing.redeemPackage',
  input: packageRedeemInput,
  output: packageRedeemOutput,
  permission: 'ticket.write',
  ai: {
    description: '核销客户名下的套餐次卡项目，并在资产账本记录扣减',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── 优惠券 (Coupons)

export const couponSaveTemplateInput = z.object({
  templateId: uuid.optional(),
  code: z.string().trim().min(2, '优惠码至少 2 个字符').max(30).toUpperCase(),
  name: z.record(z.string(), z.string()).or(z.string().min(1)),
  kind: z.enum(['amount', 'percent']),
  discountCents: cents.default(0),
  percentBp: basisPoints.default(0),
  minSpendCents: cents.default(0),
  validFrom: z.string().datetime().optional().nullable(),
  validUntil: z.string().datetime().optional().nullable(),
  maxUses: z.number().int().min(1).optional().nullable(),
  active: z.boolean().default(true),
});
export type CouponSaveTemplateInput = z.infer<typeof couponSaveTemplateInput>;

export const couponSaveTemplateOutput = z.object({
  templateId: uuid,
  code: z.string(),
  created: z.boolean(),
});
export type CouponSaveTemplateOutput = z.infer<typeof couponSaveTemplateOutput>;

export const couponSaveTemplate = defineCommand({
  name: 'coupon.saveTemplate',
  input: couponSaveTemplateInput,
  output: couponSaveTemplateOutput,
  permission: 'settings.manage',
  ai: {
    description: '创建或编辑优惠券/折扣券模板（券码、满减金额/折扣比例、门槛、有效期）',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const marketingSaveCouponTemplate = defineCommand({
  name: 'marketing.saveCouponTemplate',
  input: couponSaveTemplateInput,
  output: couponSaveTemplateOutput,
  permission: 'settings.manage',
  ai: {
    description: '创建或编辑优惠券/折扣券模板（券码、满减金额/折扣比例、门槛、有效期）',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const couponVoidInput = z.object({
  couponId: uuid,
  reason: z.string().max(500).optional(),
});
export type CouponVoidInput = z.infer<typeof couponVoidInput>;

export const couponVoidOutput = z.object({
  couponId: uuid,
  voided: z.boolean(),
});
export type CouponVoidOutput = z.infer<typeof couponVoidOutput>;

export const couponVoid = defineCommand({
  name: 'coupon.void',
  input: couponVoidInput,
  output: couponVoidOutput,
  permission: 'settings.manage',
  ai: {
    description: '作废指定优惠券',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

export const marketingVoidCoupon = defineCommand({
  name: 'marketing.voidCoupon',
  input: couponVoidInput,
  output: couponVoidOutput,
  permission: 'settings.manage',
  ai: {
    description: '作废指定优惠券',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── 会员积分 (Loyalty)

export const loyaltySaveRulesInput = z.object({
  enabled: z.boolean().default(true),
  earnRateCentsPerPoint: z.number().int().min(1).default(100), // 消费 $1 = 100 cents 积 1 分
  redeemCentsPerPoint: z.number().int().min(1).default(5),     // 1 积分抵扣 5 cents ($0.05)
  minRedeemPoints: z.number().int().min(0).default(100),       // 满 100 积分可用
});
export type LoyaltySaveRulesInput = z.infer<typeof loyaltySaveRulesInput>;

export const loyaltySaveRulesOutput = z.object({
  saved: z.boolean(),
});
export type LoyaltySaveRulesOutput = z.infer<typeof loyaltySaveRulesOutput>;

export const loyaltySaveRules = defineCommand({
  name: 'loyalty.saveRules',
  input: loyaltySaveRulesInput,
  output: loyaltySaveRulesOutput,
  permission: 'settings.manage',
  ai: {
    description: '设置会员积分获取与抵扣规则',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const loyaltyAdjustPointsInput = z.object({
  customerId: uuid,
  deltaPoints: z.number().int().optional(),
  pointsDelta: z.number().int().optional(),
  reason: z.string().min(1, '调整积分必须说明原因').max(500),
}).refine((d) => d.deltaPoints !== undefined || d.pointsDelta !== undefined, { message: '缺少积分变动值' });
export type LoyaltyAdjustPointsInput = z.infer<typeof loyaltyAdjustPointsInput>;

export const loyaltyAdjustPointsOutput = z.object({
  customerId: uuid,
  deltaPoints: z.number().int(),
  currentPoints: z.number().int(),
});
export type LoyaltyAdjustPointsOutput = z.infer<typeof loyaltyAdjustPointsOutput>;

export const loyaltyAdjustPoints = defineCommand({
  name: 'loyalty.adjustPoints',
  input: loyaltyAdjustPointsInput,
  output: loyaltyAdjustPointsOutput,
  permission: 'settings.manage',
  ai: {
    description: '人工调整客户会员积分并写入积分流水账本',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const marketingAdjustLoyaltyPoints = defineCommand({
  name: 'marketing.adjustLoyaltyPoints',
  input: loyaltyAdjustPointsInput,
  output: loyaltyAdjustPointsOutput,
  permission: 'settings.manage',
  ai: {
    description: '人工调整客户会员积分并写入积分流水账本',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const MARKETING_COMMANDS = [
  packageSaveTemplate,
  packageIssue,
  marketingIssuePackage,
  packageRedeem,
  marketingRedeemPackage,
  couponSaveTemplate,
  marketingSaveCouponTemplate,
  couponVoid,
  marketingVoidCoupon,
  loyaltySaveRules,
  loyaltyAdjustPoints,
  marketingAdjustLoyaltyPoints,
] as const;
