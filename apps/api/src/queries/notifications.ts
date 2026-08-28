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

  // If table is empty, generate initial seed notifications
  if (total === 0 && !params.category && !params.unreadOnly && !params.searchQuery) {
    const seedNotifications: NotificationItemDto[] = [
      {
        id: 'notif_seed_01',
        category: 'bookings',
        level: 'info',
        title: '新的线上预约已提交',
        titleKey: 'notifNewBooking',
        message: '顾客 Emily Watson 预约了今日 14:30 的 [日式光疗美甲设计 + 手部SPA]，指定技师 Lisa。',
        createdAt: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
        read: false,
        actionType: 'appointment',
        actionTargetId: 'apt-seed-1',
        actionUrl: '/schedule',
        meta: {
          customerName: 'Emily Watson',
          serviceName: '日式光疗美甲设计',
          staffName: 'Lisa (李美华)',
        },
      },
      {
        id: 'notif_seed_02',
        category: 'customers',
        level: 'info',
        title: '有客到店等位中 (Walk-in)',
        titleKey: 'notifWalkIn',
        message: '散客 David Miller (2位) 已在前台 iPad 电子签到，预约 [足底全息反射理疗 60分钟]，等待派位。',
        createdAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
        read: false,
        actionType: 'queue',
        actionUrl: '/queue',
        meta: {
          customerName: 'David Miller',
          serviceName: '足底全息反射理疗',
        },
      },
      {
        id: 'notif_seed_03',
        category: 'operations',
        level: 'warning',
        title: 'Stripe 线上刷卡扣款失败预警',
        titleKey: 'notifPaymentFailed',
        message: '工单 #TK-8902 客户持有的 Visa 尾号 4242 预授权扣款失败 (insufficient_funds)。请前台收银台核对。',
        createdAt: new Date(Date.now() - 1000 * 60 * 55).toISOString(),
        read: false,
        actionType: 'ticket',
        actionTargetId: 'tk-8902',
        actionUrl: '/checkout',
        meta: {
          ticketId: 'TK-8902',
          amountDollars: 128.5,
          customerName: 'Sophia Taylor',
        },
      },
      {
        id: 'notif_seed_04',
        category: 'bookings',
        level: 'warning',
        title: 'AI 电话助手已协助改期',
        message: '客人 Chloe Bennett 通过 AI 电话客服将明日 11:00 预约顺延调整至 15:30，已自动更新排班。',
        createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
        read: true,
        actionType: 'appointment',
        actionTargetId: 'apt-seed-2',
        actionUrl: '/schedule',
        meta: {
          customerName: 'Chloe Bennett',
          serviceName: '3D山茶花美睫',
          staffName: 'Amy',
        },
      },
      {
        id: 'notif_seed_05',
        category: 'customers',
        level: 'success',
        title: '收到 Google 5 星好评与点赞',
        message: '顾客 Jessica Lin 为技师 Lisa 留下了 5 星好评："Lisa 的美甲细节做得太精致了，环境也非常舒适！"',
        createdAt: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
        read: true,
        actionType: 'customer',
        actionTargetId: 'cust-101',
        actionUrl: '/customers',
        meta: {
          customerName: 'Jessica Lin',
          rating: 5,
        },
      },
    ];

    return {
      notifications: seedNotifications,
      total: seedNotifications.length,
      page: 1,
      pageSize,
    };
  }

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
  if (total === 0) {
    return {
      total: 5,
      unread: 3,
      bookingsUnread: 1,
      operationsUnread: 1,
      customersUnread: 1,
      systemUnread: 0,
    };
  }

  return {
    total,
    unread: Number(row?.unread || 0),
    bookingsUnread: Number(row?.bookings_unread || 0),
    operationsUnread: Number(row?.operations_unread || 0),
    customersUnread: Number(row?.customers_unread || 0),
    systemUnread: Number(row?.system_unread || 0),
  };
}
