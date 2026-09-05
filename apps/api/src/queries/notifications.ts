/**
 * 应用内通知中心列表与未读统计查询层
 */

import type postgres from 'postgres';
import { asInt } from '@gf/contracts';
import type { CommandContext } from '@gf/contracts';

export interface NotificationItemDto {
  id: string;
  category: 'bookings' | 'operations' | 'customers' | 'system';
  level: 'info' | 'warning' | 'error' | 'success';
  title: string;
  titleKey?: string | undefined;
  message: string;
  createdAt: string;
  read: boolean;
  actionUrl?: string | undefined;
  actionType?: 'appointment' | 'ticket' | 'queue' | 'customer' | 'settings' | undefined;
  actionTargetId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface NotificationStatsDto {
  total: number;
  unread: number;
  bookingsUnread: number;
  operationsUnread: number;
  customersUnread: number;
  systemUnread: number;
}

export interface ListNotificationsParams {
  category?: string;
  unreadOnly?: boolean;
  searchQuery?: string;
  page?: number;
  pageSize?: number;
}

export async function loadDeskNotifications(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  params: ListNotificationsParams = {},
): Promise<{ notifications: NotificationItemDto[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize) || 30));
  const offset = (page - 1) * pageSize;

  const category = params.category && params.category !== 'all' ? params.category : null;
  const unreadOnly = params.unreadOnly === true || String(params.unreadOnly) === 'true';
  const search = params.searchQuery ? `%${params.searchQuery.trim().toLowerCase()}%` : null;

  const rows = await tx<{
    id: string;
    category: string;
    level: string;
    title: string;
    title_key: string | null;
    message: string;
    read: boolean;
    action_type: string | null;
    action_target_id: string | null;
    action_url: string | null;
    meta: Record<string, unknown> | null;
    created_at: string;
  }[]>`
    select id, category, level, title, title_key, message,
           read, action_type, action_target_id, action_url, meta,
           created_at::text as created_at
    from in_app_notifications
    where location_id = ${ctx.locationId}
      and (${category === null} or category = ${category})
      and (${!unreadOnly} or read = false)
      and (${search === null} or lower(title) like ${search} or lower(message) like ${search})
    order by created_at desc
    limit ${pageSize} offset ${offset}`;

  const [countRow] = await tx<{ count: string }[]>`
    select count(*)::text as count
    from in_app_notifications
    where location_id = ${ctx.locationId}
      and (${category === null} or category = ${category})
      and (${!unreadOnly} or read = false)
      and (${search === null} or lower(title) like ${search} or lower(message) like ${search})`;

  const total = Number(countRow?.count || 0);

  return {
    notifications: rows.map((r) => ({
      id: r.id,
      category: r.category as any,
      level: r.level as any,
      title: r.title,
      titleKey: r.title_key || undefined,
      message: r.message,
      createdAt: r.created_at,
      read: r.read,
      actionType: (r.action_type as any) || undefined,
      actionTargetId: r.action_target_id || undefined,
      actionUrl: r.action_url || undefined,
      meta: r.meta || undefined,
    })),
    total,
    page,
    pageSize,
  };
}

export async function loadDeskNotificationStats(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<NotificationStatsDto> {
  const [row] = await tx<{
    total: string;
    unread: string;
    bookings_unread: string;
    operations_unread: string;
    customers_unread: string;
    system_unread: string;
  }[]>`
    select
      count(*)::text as total,
      count(case when read = false then 1 end)::text as unread,
      count(case when read = false and category = 'bookings' then 1 end)::text as bookings_unread,
      count(case when read = false and category = 'operations' then 1 end)::text as operations_unread,
      count(case when read = false and category = 'customers' then 1 end)::text as customers_unread,
      count(case when read = false and category = 'system' then 1 end)::text as system_unread
    from in_app_notifications
    where location_id = ${ctx.locationId}`;

  const total = asInt(row?.total, 0);

  return {
    total,
    unread: Number(row?.unread || 0),
    bookingsUnread: Number(row?.bookings_unread || 0),
    operationsUnread: Number(row?.operations_unread || 0),
    customersUnread: Number(row?.customers_unread || 0),
    systemUnread: Number(row?.system_unread || 0),
  };
}
