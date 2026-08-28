/**
 * 应用内通知中心命令处理器 (In-App Notification Center)
 */

import {
  MarkNotificationRead,
  MarkAllNotificationsRead,
  DeleteNotification,
  ClearReadNotifications,
  CreateInAppNotification,
  AppError,
  ERROR_CODES,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';


// ───────────────────────────────────────────── 1. 标记单条通知为已读
registerHandler(MarkNotificationRead, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof MarkNotificationRead.input._type>) => {
  const [row] = await tx<{ id: string }[]>`
    update in_app_notifications set
      read = true,
      read_at = coalesce(read_at, now()),
      updated_at = now()
    where id = ${input.notificationId} and location_id = ${ctx.locationId}
    returning id`;

  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'notification' } });
  }

  audit({
    entityType: 'in_app_notification',
    entityId: input.notificationId,
    after: { read: true },
  });

  return { notificationId: input.notificationId, read: true };
});

// ───────────────────────────────────────────── 2. 一键全部已读 / 按分类已读
registerHandler(MarkAllNotificationsRead, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof MarkAllNotificationsRead.input._type>) => {
  const category = input.category && input.category !== 'all' ? input.category : null;

  const rows = await tx<{ id: string }[]>`
    update in_app_notifications set
      read = true,
      read_at = coalesce(read_at, now()),
      updated_at = now()
    where location_id = ${ctx.locationId}
      and read = false
      and (${category === null} or category = ${category})
    returning id`;

  audit({
    entityType: 'in_app_notification_bulk',
    entityId: ctx.locationId,
    after: { action: 'mark_all_read', category: input.category, markedCount: rows.length },
  });

  return { markedCount: rows.length };
});

// ───────────────────────────────────────────── 3. 删除单条通知
registerHandler(DeleteNotification, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof DeleteNotification.input._type>) => {
  const [row] = await tx<{ id: string }[]>`
    delete from in_app_notifications
    where id = ${input.notificationId} and location_id = ${ctx.locationId}
    returning id`;

  audit({
    entityType: 'in_app_notification',
    entityId: input.notificationId,
    after: { deleted: true },
  });

  return { notificationId: input.notificationId, deleted: Boolean(row) };
});

// ───────────────────────────────────────────── 4. 一键清理所有已读通知
registerHandler(ClearReadNotifications, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ClearReadNotifications.input._type>) => {
  const category = input.category && input.category !== 'all' ? input.category : null;

  const rows = await tx<{ id: string }[]>`
    delete from in_app_notifications
    where location_id = ${ctx.locationId}
      and read = true
      and (${category === null} or category = ${category})
    returning id`;

  audit({
    entityType: 'in_app_notification_bulk',
    entityId: ctx.locationId,
    after: { action: 'clear_read', category: input.category, clearedCount: rows.length },
  });

  return { clearedCount: rows.length };
});

// ───────────────────────────────────────────── 5. 内部创建应用内通知
registerHandler(CreateInAppNotification, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof CreateInAppNotification.input._type>) => {
  const [row] = await tx<{ id: string }[]>`
    insert into in_app_notifications (
      org_id, location_id, recipient_user_id,
      category, level, title, title_key, message,
      action_type, action_target_id, action_url, meta,
      created_at, updated_at
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${input.recipientUserId ?? null},
      ${input.category}, ${input.level ?? 'info'}, ${input.title}, ${input.titleKey ?? null}, ${input.message},
      ${input.actionType ?? null}, ${input.actionTargetId ?? null}, ${input.actionUrl ?? null},
      ${jsonb(input.meta ?? {})}::jsonb,
      now(), now()
    )
    returning id`;

  audit({
    entityType: 'in_app_notification',
    entityId: row!.id,
    after: { title: input.title, category: input.category, level: input.level },
  });

  return { notificationId: row!.id };
});
