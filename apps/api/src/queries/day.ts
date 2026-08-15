/**
 * 当日现场快照 —— 日程表、开单页、（以后）AI 副驾都吃这一份。
 *
 * 一次给全，不让前端拼十个接口：门店网络差，一次往返比十次可靠得多。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import { pickText, type CommandContext } from '@gf/contracts';

export interface DayStaff {
  membershipId: string;
  name: string;
  isBookable: boolean;
  inRotation: boolean;
  maxConcurrent: number;
  color: string | null;
}

export interface DayItem {
  itemId: string;
  appointmentId: string;
  membershipId: string | null;
  customerName: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  status: string;
  isRequest: boolean;
  overbooked: boolean;
  overbookReason: string | null;
  resourceId: string | null;
}

export interface DayService {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
}

export interface DaySnapshot {
  businessDate: string;
  timezone: string;
  openMin: number;   // 当天营业起止，用分钟表示（本地墙上时间）
  closeMin: number;
  staff: DayStaff[];
  services: DayService[];
  resources: Array<{ id: string; name: string }>;
  items: DayItem[];
}


export async function loadDay(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  businessDate: string,
): Promise<DaySnapshot> {
  const [loc] = await tx<{ timezone: string; business_hours: unknown }[]>`
    select timezone, business_hours from locations where id = ${ctx.locationId}`;

  const staffRows = await tx<{
    membership_id: string; display_name: unknown; is_bookable: boolean;
    max_concurrent: number; color: string | null; in_rotation: boolean | null;
  }[]>`
    select sp.membership_id, sp.display_name, sp.is_bookable,
           sp.max_concurrent_appointments as max_concurrent, sp.color,
           rp.in_rotation
    from staff_profiles sp
    left join rotation_participants rp
      on rp.membership_id = sp.membership_id and rp.business_date = ${businessDate}
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.location_id = ${ctx.locationId}
    order by sp.is_bookable desc, sp.display_name->>'en'`;

  const serviceRows = await tx<{
    id: string; name: unknown; duration_min: number; base_price_cents: number;
  }[]>`
    select id, name, duration_min, base_price_cents from services
    where location_id = ${ctx.locationId} and active = true
    order by sort, name->>'en'`;

  const resourceRows = await tx<{ id: string; name: string }[]>`
    select id, name from resources
    where location_id = ${ctx.locationId} and status <> 'out_of_service'
    order by name`;

  const itemRows = await tx<{
    item_id: string; appointment_id: string; membership_id: string | null;
    customer_name: string | null; walk_in_name: string | null; service_name: unknown;
    starts_at: string; ends_at: string; duration_min: number; status: string;
    is_request: boolean; overbooked: boolean; overbook_reason: string | null;
    resource_id: string | null;
  }[]>`
    select ai.id as item_id, ai.appointment_id, ai.membership_id,
           c.display_name as customer_name, a.walk_in_name,
           s.name as service_name,
           ai.starts_at, ai.ends_at, ai.duration_min, ai.status,
           ai.is_request, ai.overbooked, ai.overbook_reason, ai.resource_id
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join services s on s.id = ai.service_id
    left join customers c on c.id = a.customer_id
    where ai.location_id = ${ctx.locationId}
      and a.business_date = ${businessDate}
      and ai.status <> 'cancelled'
    order by ai.starts_at`;

  // 营业时间：按星期取；没配就给一个安全的默认，别让日程表整个空掉
  const dow = new Date(`${businessDate}T12:00:00Z`).getUTCDay();
  const hours = (loc?.business_hours ?? {}) as Record<string, { open?: string; close?: string }>;
  const today = hours[String(dow)] ?? hours[['sun','mon','tue','wed','thu','fri','sat'][dow]!] ?? {};
  const toMin = (hhmm: string | undefined, dflt: number): number => {
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
  };

  return {
    businessDate,
    timezone: loc?.timezone ?? 'America/New_York',
    openMin: toMin(today.open, 9 * 60),
    closeMin: toMin(today.close, 20 * 60),
    staff: staffRows.map((s) => ({
      membershipId: s.membership_id,
      name: pickText(s.display_name, ctx.locale),
      isBookable: s.is_bookable,
      // rotation_participants 没有当天记录时，默认「可接客的人参与轮牌」
      inRotation: s.in_rotation ?? s.is_bookable,
      maxConcurrent: s.max_concurrent,
      color: s.color,
    })),
    services: serviceRows.map((s) => ({
      id: s.id,
      name: pickText(s.name, ctx.locale),
      durationMin: s.duration_min,
      priceCents: s.base_price_cents,
    })),
    resources: resourceRows,
    items: itemRows.map((r) => ({
      itemId: r.item_id,
      appointmentId: r.appointment_id,
      membershipId: r.membership_id,
      customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
      serviceName: pickText(r.service_name, ctx.locale),
      startsAt: parseTs(r.starts_at).toISOString(),
      endsAt: parseTs(r.ends_at).toISOString(),
      durationMin: r.duration_min,
      status: r.status,
      isRequest: r.is_request,
      overbooked: r.overbooked,
      overbookReason: r.overbook_reason,
      resourceId: r.resource_id,
    })),
  };
}
