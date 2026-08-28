/**
 * 应用内通知中心相关命令 (In-App Notification Center)
 */

import { z } from 'zod';
import { defineCommand } from '../command';

const categorySchema = z.enum(['all', 'bookings', 'operations', 'customers', 'system']);
const levelSchema = z.enum(['info', 'warning', 'error', 'success']);
const actionTypeSchema = z.enum(['appointment', 'ticket', 'queue', 'customer', 'settings']);

/** 标记单条通知为已读 */
export const MarkNotificationRead = defineCommand({
  name: 'notification.markRead',
  input: z.object({
    notificationId: z.string().uuid(),
  }),
  output: z.object({
    notificationId: z.string().uuid(),
    read: z.boolean(),
  }),
  ai: {
    description: '将指定的应用内通知标记为已读。',
    confirm: 'never',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 一键全部已读 / 按分类标记全部已读 */
export const MarkAllNotificationsRead = defineCommand({
  name: 'notification.markAllRead',
  input: z.object({
    category: categorySchema.optional(),
  }),
  output: z.object({
    markedCount: z.number().int(),
  }),
  ai: {
    description: '一键将全部或特定分类下的未读应用内通知标记为已读。',
    confirm: 'never',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 删除单条通知 */
export const DeleteNotification = defineCommand({
  name: 'notification.delete',
  input: z.object({
    notificationId: z.string().uuid(),
  }),
  output: z.object({
    notificationId: z.string().uuid(),
    deleted: z.boolean(),
  }),
  ai: {
    description: '删除指定的应用内通知消息。',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 一键清理已读通知 */
export const ClearReadNotifications = defineCommand({
  name: 'notification.clearRead',
  input: z.object({
    category: categorySchema.optional(),
  }),
  output: z.object({
    clearedCount: z.number().int(),
  }),
  ai: {
    description: '一键批量清理删除已读的应用内通知。',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 内部 / 系统触发创建应用内通知 */
export const CreateInAppNotification = defineCommand({
  name: 'notification.create',
  input: z.object({
    category: z.enum(['bookings', 'operations', 'customers', 'system']),
    level: levelSchema.optional(),
    title: z.string().trim().min(1).max(200),
    titleKey: z.string().max(100).optional(),
    message: z.string().trim().min(1).max(1000),
    recipientUserId: z.string().uuid().optional(), // 空表示全店广播
    actionType: actionTypeSchema.optional(),
    actionTargetId: z.string().optional(),
    actionUrl: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    notificationId: z.string().uuid(),
  }),
  ai: {
    description: '向门店前台与员工派发新的应用内通知消息。',
    confirm: 'never',
  },
  reversible: false,
  idempotency: 'optional',
});

export const NOTIFICATION_COMMANDS = [
  MarkNotificationRead,
  MarkAllNotificationsRead,
  DeleteNotification,
  ClearReadNotifications,
  CreateInAppNotification,
] as const;
