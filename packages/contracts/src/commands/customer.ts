/**
 * 顾客档案写命令（02-DATA-MODEL §3，客户 CRM 闭环）
 *
 * 包含：
 *   - customer.saveProfile: 新建 / 编辑顾客档案（姓名/电话/邮箱/VIP/标签/生日/性别/备注）
 *   - customer.savePreferences: 保存服务偏好与健康禁忌/SOAP/前台备忘
 *   - customer.setBlocked: 客户拉黑 / 解除拉黑（带原因审计）
 *   - customer.merge: 重复客户合并（合并预约/工单/礼品卡/问卷）
 */

import { z } from 'zod';
import { defineCommand, uuid, phoneE164 } from '../command.js';

// ─────────────────────────────────────────────────────────── customer.saveProfile

export const customerSaveProfileInput = z.object({
  customerId: uuid.optional(),
  name: z.string().trim().min(1, '客户姓名不能为空').max(100),
  firstName: z.string().trim().max(50).nullable().optional(),
  lastName: z.string().trim().max(50).nullable().optional(),
  phoneE164: phoneE164.nullable().optional(),
  email: z.string().email('邮箱格式不正确').nullable().optional().or(z.literal('')),
  vipLevel: z.number().int().min(0).max(5).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式必须为 YYYY-MM-DD').nullable().optional(),
  tags: z.array(z.string().trim().max(30)).optional(),
  gender: z.enum(['female', 'male', 'other', 'unspecified']).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  source: z.string().max(50).nullable().optional(),
});
export type CustomerSaveProfileInput = z.infer<typeof customerSaveProfileInput>;

export const customerSaveProfileOutput = z.object({
  customerId: uuid,
  created: z.boolean(),
});
export type CustomerSaveProfileOutput = z.infer<typeof customerSaveProfileOutput>;

export const customerSaveProfile = defineCommand({
  name: 'customer.saveProfile',
  input: customerSaveProfileInput,
  output: customerSaveProfileOutput,
  permission: 'customer.write',
  ai: {
    description: '新建或编辑客户基础档案（姓名、电话、邮箱、VIP 等级、生日、标签、备注）',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── customer.savePreferences

export const customerSavePreferencesInput = z.object({
  customerId: uuid,
  allergies: z.object({
    skinAllergies: z.array(z.string()).optional(),
    fragranceSensitivities: z.array(z.string()).optional(),
    medications: z.array(z.string()).optional(),
    customNotes: z.string().max(1000).optional(),
  }).optional().default({}),
  preferredStaffIds: z.array(uuid).default([]),
  avoidStaffIds: z.array(uuid).default([]),
  preferredGender: z.string().max(20).optional(),
  freeNotes: z.string().max(2000).optional(),
  profile: z.record(z.string(), z.unknown()).optional().default({}),
});
export type CustomerSavePreferencesInput = z.infer<typeof customerSavePreferencesInput>;

export const customerSavePreferencesOutput = z.object({
  customerId: uuid,
  saved: z.boolean(),
});
export type CustomerSavePreferencesOutput = z.infer<typeof customerSavePreferencesOutput>;

export const customerSavePreferences = defineCommand({
  name: 'customer.savePreferences',
  input: customerSavePreferencesInput,
  output: customerSavePreferencesOutput,
  permission: 'customer.write',
  ai: {
    description: '保存客户偏好、过敏禁忌、偏好/避开技师及前台备忘',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── customer.setBlocked

export const customerSetBlockedInput = z.object({
  customerId: uuid,
  blocked: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type CustomerSetBlockedInput = z.infer<typeof customerSetBlockedInput>;

export const customerSetBlockedOutput = z.object({
  customerId: uuid,
  blocked: z.boolean(),
});
export type CustomerSetBlockedOutput = z.infer<typeof customerSetBlockedOutput>;

export const customerSetBlocked = defineCommand({
  name: 'customer.setBlocked',
  input: customerSetBlockedInput,
  output: customerSetBlockedOutput,
  permission: 'customer.write',
  ai: {
    description: '拉黑或解除拉黑指定客户',
    confirm: 'destructive',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── customer.merge

export const customerMergeInput = z.object({
  targetCustomerId: uuid,
  sourceCustomerId: uuid,
});
export type CustomerMergeInput = z.infer<typeof customerMergeInput>;

export const customerMergeOutput = z.object({
  targetCustomerId: uuid,
  sourceCustomerId: uuid,
  mergedCount: z.number().int(),
});
export type CustomerMergeOutput = z.infer<typeof customerMergeOutput>;

export const customerMerge = defineCommand({
  name: 'customer.merge',
  input: customerMergeInput,
  output: customerMergeOutput,
  permission: 'customer.merge',
  ai: {
    description: '合并重复的客户档案，将历史预约、工单、礼品卡与预付资产并入目标客户',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'required',
});

// ─────────────────────────────────────────────────────────── customer.sendSms

export const customerSendSmsInput = z.object({
  customerId: uuid,
  body: z.string().trim().min(1, '短信正文不能为空').max(1600),
  templateId: z.string().optional(),
  mediaUrls: z.array(z.string().url()).optional(),
});
export type CustomerSendSmsInput = z.infer<typeof customerSendSmsInput>;

export const customerSendSmsOutput = z.object({
  outboxId: uuid,
  customerId: uuid,
  phone: z.string(),
  segments: z.number().int().min(1),
  status: z.enum(['pending', 'sent', 'suppressed', 'failed']),
});
export type CustomerSendSmsOutput = z.infer<typeof customerSendSmsOutput>;

export const customerSendSms = defineCommand({
  name: 'customer.sendSms',
  input: customerSendSmsInput,
  output: customerSendSmsOutput,
  permission: 'comms.send',
  ai: {
    description: '向指定客户直接发送短信或营销关怀内容',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

export const CUSTOMER_COMMANDS = [
  customerSaveProfile,
  customerSavePreferences,
  customerSetBlocked,
  customerMerge,
  customerSendSms,
] as const;
