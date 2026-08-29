/**
 * 个人资料、安全与设备会话相关命令
 */

import { z } from 'zod';
import { defineCommand, phoneE164 } from '../command';

/** 更新当前用户个人档案与技师接单配置 */
export const UpdateUserProfile = defineCommand({
  name: 'user.updateProfile',
  input: z.object({
    fullName: z.string().trim().min(1).max(100).optional(),
    nickname: z.string().trim().max(60).optional(),
    phone: phoneE164.optional(),
    avatarUrl: z.string().url().or(z.literal('')).optional(),
    bio: z.string().max(500).optional(),
    locale: z.string().max(10).optional(),
    timezone: z.string().max(50).optional(),
    isBookable: z.boolean().optional(),
    maxConcurrentAppointments: z.number().int().min(1).max(10).optional(),
    skills: z.array(z.string().trim()).optional(),
  }),
  output: z.object({
    userId: z.string().uuid(),
    updated: z.boolean(),
  }),
  ai: {
    description: '更新当前登录用户的个人档案、联系方式、昵称以及技师接单设置。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/** 设置 / 重置技师 POS 快速解锁 PIN 码 (4-6 位纯数字) */
export const SetStaffPin = defineCommand({
  name: 'staff.setPin',
  input: z.object({
    pin: z.string().regex(/^\d{4,6}$/, 'PIN 必须是 4 到 6 位纯数字'),
    membershipId: z.string().uuid().optional(),
  }),
  output: z.object({
    membershipId: z.string().uuid(),
    hasPin: z.boolean(),
  }),
  ai: {
    description: '设置或重置技师在前台 POS 及 iPad 设备上的快速解锁数字 PIN 码。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 强制下线指定设备活跃会话 */
export const RevokeUserSession = defineCommand({
  name: 'user.revokeSession',
  input: z.object({
    sessionId: z.string().uuid(),
  }),
  output: z.object({
    sessionId: z.string().uuid(),
    revoked: z.boolean(),
  }),
  ai: {
    description: '注销并强制踢下线指定的活跃登录设备。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 保存个人针对各渠道 (应用内/短信/邮件) 的通知偏好 */
export const SaveNotificationPreferences = defineCommand({
  name: 'user.saveNotificationPreferences',
  input: z.object({
    inApp: z.record(z.boolean()).optional(),
    sms: z.record(z.boolean()).optional(),
    email: z.record(z.boolean()).optional(),
  }),
  output: z.object({
    userId: z.string().uuid(),
    saved: z.boolean(),
  }),
  ai: {
    description: '保存个人在应用内推送、短信和邮件等渠道的事件通知开关。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const PROFILE_COMMANDS = [
  UpdateUserProfile,
  SetStaffPin,
  RevokeUserSession,
  SaveNotificationPreferences,
] as const;
