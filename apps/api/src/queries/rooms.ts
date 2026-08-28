/**
 * 房间与工位实时看板查询（Rooms.tsx，P0 房态看板）
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';

export interface RoomSession {
  appointmentId: string;
  ticketId: string | null;
  customerName: string;
  staffNames: string[];
  serviceName: string;
  startedAt: string;
  estimatedEndAt: string;
  progressMinutes: number;
  totalMinutes: number;
}

export interface UpcomingSession {
  appointmentId: string;
  customerName: string;
  staffName: string;
  serviceName: string;
  startsAt: string;
  startsInMinutes: number;
  durationMin: number;
}

export interface TimelineSlot {
  id: string;
  appointmentId: string;
  customerName: string;
  staffName: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

export interface RoomMetrics {
  total: number;
  available: number;
  inService: number;
  cleaning: number;
  maintenance: number;
  occupancyRate: number;
}

export interface RoomDto {
  id: string;
  name: string;
  type: string;
  typeKey: string;
  capacity: number;
  maxStaff: number | null;
  status: 'available' | 'in_service' | 'cleaning' | 'maintenance';
  currentSession?: RoomSession | undefined;
  upcomingSession?: UpcomingSession | undefined;
  todaySlots: TimelineSlot[];
}

export async function loadRooms(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ rooms: RoomDto[]; metrics: RoomMetrics }> {
  // 1. 查询所有资源与类型
  const resRows = await tx<{
    id: string; name: string; status: string; capacity: number; max_staff: number | null;
    type_key: string; type_name: unknown;
  }[]>`
    select r.id, r.name, r.status, r.capacity, r.max_staff,
           coalesce(rt.key, 'room') as type_key,
           rt.name as type_name
    from resources r
    left join resource_types rt on rt.id = r.resource_type_id
    where r.location_id = ${ctx.locationId}
    order by r.name`;

  if (resRows.length === 0) {
    return {
      rooms: [],
      metrics: {
        total: 0,
        available: 0,
        inService: 0,
        cleaning: 0,
        maintenance: 0,
        occupancyRate: 0,
      },
    };
  }

  // 2. 查询今日关联该门店房间的所有预约项
  const todayItems = await tx<{
    item_id: string; resource_id: string; appointment_id: string;
    starts_at: string; ends_at: string; duration_min: number; status: string;
    customer_name: string | null; walk_in_name: string | null;
    staff_display_name: unknown; user_full_name: string | null; service_name: unknown;
  }[]>`
    select ai.id as item_id, ai.resource_id, ai.appointment_id,
           ai.starts_at::text as starts_at, ai.ends_at::text as ends_at,
           ai.duration_min, ai.status,
           c.display_name as customer_name,
           a.walk_in_name,
           sp.display_name as staff_display_name,
           u.full_name as user_full_name,
           s.name as service_name
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    left join customers c on c.id = a.customer_id
    left join memberships m on m.id = ai.membership_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join users u on u.id = m.user_id
    left join services s on s.id = ai.service_id
    where ai.location_id = ${ctx.locationId}
      and ai.resource_id is not null
      and ai.status not in ('cancelled', 'no_show')
      and ai.starts_at >= current_date - interval '2 hours'
      and ai.starts_at < current_date + interval '1 day' + interval '4 hours'
    order by ai.starts_at asc`;

  const nowMs = Date.now();
  type TodayItem = (typeof todayItems)[number];
  const itemsByResource = new Map<string, TodayItem[]>();
  for (const item of todayItems) {
    if (item.resource_id) {
      const list = itemsByResource.get(item.resource_id) ?? [];
      list.push(item);
      itemsByResource.set(item.resource_id, list);
    }
  }

  let totalCount = resRows.length;
  let availableCount = 0;
  let inServiceCount = 0;
  let cleaningCount = 0;
  let maintenanceCount = 0;

  const rooms: RoomDto[] = resRows.map((r) => {
    const list = itemsByResource.get(r.id) ?? [];

    // 当前活跃项目（进行中的）
    const activeItem = list.find((item) => {
      const startMs = new Date(item.starts_at).getTime();
      const endMs = new Date(item.ends_at).getTime();
      return (
        item.status !== 'completed' &&
        startMs <= nowMs + 5 * 60 * 1000 &&
        endMs >= nowMs - 5 * 60 * 1000
      );
    });

    let currentSession: RoomSession | undefined;
    if (activeItem) {
      const startMs = new Date(activeItem.starts_at).getTime();
      const endMs = new Date(activeItem.ends_at).getTime();
      const totalMin = Math.max(1, Math.round((endMs - startMs) / 60000));
      const elapsedMin = Math.max(0, Math.round((nowMs - startMs) / 60000));
      const staffName = activeItem.staff_display_name
        ? pickText(activeItem.staff_display_name, ctx.locale, activeItem.user_full_name ?? '技师')
        : (activeItem.user_full_name ?? '技师');

      currentSession = {
        appointmentId: activeItem.appointment_id,
        ticketId: null,
        customerName: activeItem.customer_name ?? activeItem.walk_in_name ?? '客人',
        staffNames: staffName ? [staffName] : [],
        serviceName: pickText(activeItem.service_name, ctx.locale, '项目服务'),
        startedAt: activeItem.starts_at,
        estimatedEndAt: activeItem.ends_at,
        progressMinutes: elapsedMin,
        totalMinutes: totalMin,
      };
    }

    // 下一场预约（未来的）
    const nextItem = list.find((item) => {
      const startMs = new Date(item.starts_at).getTime();
      return startMs > nowMs && item.status !== 'completed' && item.item_id !== activeItem?.item_id;
    });

    let upcomingSession: UpcomingSession | undefined;
    if (nextItem) {
      const startMs = new Date(nextItem.starts_at).getTime();
      const diffMin = Math.max(0, Math.round((startMs - nowMs) / 60000));
      const staffName = nextItem.staff_display_name
        ? pickText(nextItem.staff_display_name, ctx.locale, nextItem.user_full_name ?? '技师')
        : (nextItem.user_full_name ?? '技师');

      upcomingSession = {
        appointmentId: nextItem.appointment_id,
        customerName: nextItem.customer_name ?? nextItem.walk_in_name ?? '客人',
        staffName: staffName || '待指派',
        serviceName: pickText(nextItem.service_name, ctx.locale, '项目服务'),
        startsAt: nextItem.starts_at,
        startsInMinutes: diffMin,
        durationMin: nextItem.duration_min,
      };
    }

    // 今日所有预约时间片段
    const todaySlots: TimelineSlot[] = list.map((item) => {
      const staffName = item.staff_display_name
        ? pickText(item.staff_display_name, ctx.locale, item.user_full_name ?? '技师')
        : (item.user_full_name ?? '技师');

      return {
        id: item.item_id,
        appointmentId: item.appointment_id,
        customerName: item.customer_name ?? item.walk_in_name ?? '客人',
        staffName: staffName || '技师',
        serviceName: pickText(item.service_name, ctx.locale, '服务'),
        startsAt: item.starts_at,
        endsAt: item.ends_at,
        status: item.status,
      };
    });

    // 如果有活跃 session，且状态为 available，可推导为 in_service
    let effectiveStatus = r.status as RoomDto['status'];
    if (currentSession && effectiveStatus === 'available') {
      effectiveStatus = 'in_service';
    }

    if (effectiveStatus === 'available') availableCount++;
    else if (effectiveStatus === 'in_service') inServiceCount++;
    else if (effectiveStatus === 'cleaning') cleaningCount++;
    else if (effectiveStatus === 'maintenance') maintenanceCount++;

    const typeLabel = pickText(r.type_name, ctx.locale, r.type_key);

    return {
      id: r.id,
      name: r.name,
      type: typeLabel,
      typeKey: r.type_key,
      capacity: r.capacity,
      maxStaff: r.max_staff,
      status: effectiveStatus,
      currentSession,
      upcomingSession,
      todaySlots,
    };
  });

  const occupancyRate =
    totalCount > 0 ? Math.round((inServiceCount / totalCount) * 100) : 0;

  return {
    rooms,
    metrics: {
      total: totalCount,
      available: availableCount,
      inService: inServiceCount,
      cleaning: cleaningCount,
      maintenance: maintenanceCount,
      occupancyRate,
    },
  };
}
