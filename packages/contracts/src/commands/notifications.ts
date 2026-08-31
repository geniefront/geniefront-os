/**
 * 应用内通知中心相关命令 (In-App Notification Center)
 */

import { z } from 'zod';
import { defineCommand } from '../command';

const categorySchema = z.enum(['all', 'bookings', 'operations', 'customers', 'system']);
const levelSchema = z.enum(['info', 'warning', 'error', 'success']);
const actionTypeSchema = z.enum(['appointment', 'ticket', 'queue', 'customer', 'settings']);

/**
 * 标记单条通知为已读。
 *
 * ⚠️ 权限用 `appointment.read`（AUD-06）—— 这是每一个角色预设都有的
 * 那一条，实际含义是「你是这家店的员工」。加它不是为了限制谁能已读，
 * 是为了让这条命令**有一个权限**：原来它一条都没声明，
 * 而总线的 `if (def.permission && …)` 对没声明的命令直接放行。
 */
export const MarkNotificationRead = defineCommand({
  name: 'notification.markRead',
  input: z.object({
    notificationId: z.string().uuid(),
  }),
  output: z.object({
    notificationId: z.string().uuid(),
    read: z.boolean(),
  }),
  permission: 'appointment.read',
  ai: {
    description: '将指定的应用内通知标记为已读。',
    confirm: 'never',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 一键全部已读 / 按分类标记全部已读。已读不是破坏性操作，员工级权限即可。 */
export const MarkAllNotificationsRead = defineCommand({
  name: 'notification.markAllRead',
  input: z.object({
    category: categorySchema.optional(),
  }),
  output: z.object({
    markedCount: z.number().int(),
  }),
  permission: 'appointment.read',
  ai: {
    description: '一键将全部或特定分类下的未读应用内通知标记为已读。',
    confirm: 'never',
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 删除单条通知。
 *
 * ⭐ 权限是 `settings.manage`（AUD-06）。理由是**广播通知是共享行**：
 * `recipient_user_id is null` 的那些，RLS 允许店里每一个人读写。
 * 原来这条命令没有任何权限，于是任意一名技师都能把全店的通知
 * （含「扣款失败」「客诉」这类）一条条删干净，而且删掉就没了。
 */
export const DeleteNotification = defineCommand({
  name: 'notification.delete',
  input: z.object({
    notificationId: z.string().uuid(),
  }),
  output: z.object({
    notificationId: z.string().uuid(),
    deleted: z.boolean(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '删除指定的应用内通知消息。',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

/** 一键清理已读通知。同 `notification.delete`：破坏性且作用于共享行。 */
export const ClearReadNotifications = defineCommand({
  name: 'notification.clearRead',
  input: z.object({
    category: categorySchema.optional(),
  }),
  output: z.object({
    clearedCount: z.number().int(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '一键批量清理删除已读的应用内通知。',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 创建应用内通知。
 *
 * ⭐ **系统自有 + `settings.manage`**（AUD-06）。
 *
 * 原来它一条权限都没有，而 `recipientUserId` 留空就是**全店广播**。
 * 于是任何一个登录的技师都能发一条 `level: 'error'`、标题随便写的
 * 「系统通知」给全店看 —— 冒充平台说话，成本为零。
 * `ai.confirm` 原来还是 `'never'`，连副驾都能不经确认地发。
 *
 * 浏览器从来没有调用过它（前端只调 markRead / markAllRead / delete /
 * clearRead），所以关掉这个入口不影响任何现有功能。
 */
export const CreateInAppNotification = defineCommand({
  name: 'notification.create',
  system: true,
  input: z.object({
    category: z.enum(['bookings', 'operations', 'customers', 'system']),
    level: levelSchema.optional(),
    title: z.string().trim().min(1).max(200),
    titleKey: z.string().max(100).optional(),
    message: z.string().trim().min(1).max(1000),
    recipientUserId: z.string().uuid().optional(), // 空表示全店广播
    actionType: actionTypeSchema.optional(),
    actionTargetId: z.string().optional(),
    /**
     * ⚠️ 只允许站内相对路径（AUD-06）。
     *
     * 前端拿它直接喂给 react-router 的 `navigate()`。router 会把
     * 绝对 URL 归一成站内路由，所以这不是开放重定向 —— 但把它约束成
     * 相对路径能让「这个字段到底会被怎么用」在契约上就说死，
     * 而不是依赖 router 当前版本的归一化行为。
     */
    actionUrl: z.string().max(500).regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/, {
      message: 'actionUrl 只能是站内相对路径（以 / 开头）',
    }).optional(),
    meta: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    notificationId: z.string().uuid(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '（内部）向门店前台与员工派发应用内通知消息。',
    confirm: 'always',
    exposed: false,
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
