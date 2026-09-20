import {dayWindows} from '@gf/scheduling';
import { loadBookingStaff, enforceScheduledBooking } from '../queries/bookingStaff';
/**
 * Token-scoped reschedule availability.
 *
 * Public GET /availability is a new booking: one service, optional staff.
 * Guest reschedule is `appointment.reschedule`: shift every item by the same
 * delta, keep each item's specialist. Showing first-item slots would offer
 * times the atomic mutation cannot keep.
 */

import type postgres from 'postgres';
import type { PublicShopRow } from '@gf/db';
import {
  bookingLimits, readBookingPolicy, businessDateOf, checkCapacity, overlappingOccupancy, wallMinuteToInstant, type Interval,
} from '@gf/scheduling';

export interface ManagedAvailItem {
  membership_id: string | null;
  starts_at: string;
  ends_at: string;
  duration_min: number;
  resource_id: string | null;
  details?: Record<string,unknown>;
}

export interface ManagedSlot {
  startsAt: string;
  staff: { id: string; displayName: string } | null;
}

export interface ManagedAvailability {
  date: string;
  timezone: string;
  durationMin: number;
  canReschedule: boolean;
  reason: string | null;
  slots: ManagedSlot[];
  staff: Array<{ id: string; displayName: string; avatarUrl: null }>;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const hhmmToMin = (v: string): number => {
  const [h = '0', m = '0'] = v.split(':');
  return Number(h) * 60 + Number(m);
};

const overlaps = (a: Interval, b: Interval) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * Shapes we will not self-serve. Resource holds are a hard DB constraint we
 * do not re-search here; empty/invalid items cannot be shifted safely.
 */
export function guestRescheduleShapeReason(items: readonly ManagedAvailItem[]): string | null {
  if (items.length === 0) return 'shape_unsupported';
  for (const item of items) {
    if (!Number.isFinite(item.duration_min) || item.duration_min <= 0) return 'shape_unsupported';
    if (!Number.isFinite(Date.parse(item.starts_at)) || !Number.isFinite(Date.parse(item.ends_at))) {
      return 'shape_unsupported';
    }
    if (item.resource_id && (!item.membership_id || !Number.isInteger(item.details?.['publicGuestIndex']))) return 'shape_unsupported';
  }
  return null;
}

interface OccupancyStaff {
  membershipId: string;
  name: string;
  shiftStartMin: number;
  shiftEndMin: number;
  busy: Interval[];
  maxConcurrent: number;
}

export async function loadManagedAvailability(
  tx: postgres.TransactionSql,
  shop: Pick<PublicShopRow,'locationId'|'timezone'|'businessDayCutoff'|'onlineBooking'>,
  appointmentId: string,
  date: string,
): Promise<ManagedAvailability> {
  const empty = (
    reason: string | null, canReschedule: boolean, durationMin = 0,
  ): ManagedAvailability => ({
    date, timezone: shop.timezone, durationMin, canReschedule, reason, slots: [], staff: [],
  });

  const items = await tx<ManagedAvailItem[]>`
    select membership_id, starts_at::text as starts_at, ends_at::text as ends_at,
           duration_min, resource_id, details
      from appointment_items
     where appointment_id = ${appointmentId} and status <> 'cancelled'
     order by starts_at, seq`;

  const shapeReason = guestRescheduleShapeReason(items);
  if (shapeReason) return empty(shapeReason, false);

  // 整单一起挪时，这些项目属于同一位客人，互相之间不算占位冲突。
  // party_size > 1 的单例外（母女同来 = 两位客人），退回按项目各算各的。
  const [party] = await tx<{ n: number }[]>`
    select party_size as n from appointments where id = ${appointmentId}`;
  const shapeGroupKey = (party?.n ?? 1) > 1 ? null : appointmentId;

  const anchorMs = Math.min(...items.map((i) => Date.parse(i.starts_at)));
  const shape = items.map((i) => ({
    membershipId: i.membership_id,
    offsetMin: Math.round((Date.parse(i.starts_at) - anchorMs) / 60_000),
    durationMin: i.duration_min,
  }));
  const spanMin = Math.max(...shape.map((s) => s.offsetMin + s.durationMin));

  const [loc] = await tx<{
    tz: string; cutoff: string;
    hours: Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>;
    settings: Record<string, unknown>;
  }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff,
           business_hours as hours, settings
      from locations where id = ${shop.locationId}`;
  if (!loc) return empty('shape_unsupported', false, spanMin);

  const weekday = DAY_KEYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
  const today = loc.hours?.[weekday];
  if (!today) return empty(null, true, spanMin);

  const openMin = hhmmToMin(today.open);
  const rawClose = hhmmToMin(today.close);
  const closeMin = rawClose <= openMin ? rawClose + 24 * 60 : rawClose;

  const windows=await loadBookingStaff(tx,shop.locationId,date);
  const profiles=await tx<{membership_id:string;display_name:unknown;max_concurrent_appointments:number}[]>`select membership_id,display_name,max_concurrent_appointments from staff_profiles where location_id=${shop.locationId}`;
  const staffRows=windows.map(w=>({membership_id:w.id,start_min:w.startMin,end_min:w.endMin,name:profiles.find(p=>p.membership_id===w.id)?.display_name,max_concurrent:(loc.settings as any).capacity?.strict_staff?1:profiles.find(p=>p.membership_id===w.id)?.max_concurrent_appointments??1}));
  if (staffRows.length === 0) return empty(null, true, spanMin);

  const busyRows = await tx<{
    group_key: string; membership_id: string | null;
    starts_at: string | Date; ends_at: string | Date;
  }[]>`
    select case when a.party_size > 1 then ai.id::text else ai.appointment_id::text end as group_key,
           ai.membership_id, ai.starts_at, ai.ends_at
      from appointment_items ai
      join appointments a on a.id = ai.appointment_id
     where a.location_id = ${shop.locationId}
       and a.business_date = ${date}
       -- Same occupancy as appointment.reschedule / sql/0008: only live items.
       -- Cancelled items on a still-booked appointment (partial cancel) and
       -- completed / no-show rows must not block a future slot.
       and ai.status in ('booked', 'in_service')
       and a.status not in ('cancelled', 'completed', 'no_show')
       and a.id <> ${appointmentId}`;

  const busyBy = new Map<string, Interval[]>();
  const locationBusy: Interval[] = [];
  for (const b of busyRows) {
    // 同一位客人的多个项目合并成一个占位（见 packages/scheduling/capacity.ts）
    const iv = {
      startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at), groupKey: b.group_key,
    };
    locationBusy.push(iv);
    if (!b.membership_id) continue;
    const list = busyBy.get(b.membership_id) ?? [];
    list.push(iv);
    busyBy.set(b.membership_id, list);
  }

  const staff: OccupancyStaff[] = staffRows.map((r) => ({
    membershipId: r.membership_id,
    name: pickName(r.name),
    shiftStartMin: r.start_min,
    shiftEndMin: r.end_min,
    busy: busyBy.get(r.membership_id) ?? [],
    maxConcurrent: items.every(i=>Number.isInteger(i.details?.['publicGuestIndex'])) ? 1 : r.max_concurrent ?? 1,
  }));
  const staffById = new Map(staff.map((s) => [s.membershipId, s]));

  const namedIds = [...new Set(shape.map((s) => s.membershipId).filter((id): id is string => Boolean(id)))];
  for (const id of namedIds) {
    if (!staffById.has(id)) return empty(null, true, spanMin);
  }

  const capacity = (loc.settings as {
    capacity?: { slot_minutes?: number; max_concurrent_per_slot?: number | null };
  })?.capacity;
  const slotMinutes = Number(capacity?.slot_minutes ?? 15);
  const step = Number.isFinite(slotMinutes) && slotMinutes > 0 ? slotMinutes : 15;
  const perSlot = typeof capacity?.max_concurrent_per_slot === 'number'
    ? capacity.max_concurrent_per_slot : null;

  const todayHere = businessDateOf(new Date(), loc.tz, loc.cutoff);
  const nowMin = todayHere === date ? minutesNowIn(loc.tz) : undefined;
  const earliest = Date.now() + shop.onlineBooking.minMinutesAhead * 60_000;
  const from = Math.max(openMin, nowMin ?? openMin);
  const first = Math.ceil(from / step) * step;

  const resourceIds=[...new Set(items.map(i=>i.resource_id).filter((id):id is string=>!!id))];
  const resources=resourceIds.length?await tx<{id:string;capacity:number;max_staff:number|null}[]>`
    select id,capacity,max_staff from resources where location_id=${shop.locationId} and id=any(${resourceIds}) and status='available'`:[];
  if(resources.length!==resourceIds.length)return empty(null,true,spanMin);
  const resourceBusy=resourceIds.length?await tx<{resource_id:string;membership_id:string|null;starts_at:string;ends_at:string;group_key:string}[]>`
    select ai.resource_id,ai.membership_id,ai.starts_at::text,ai.ends_at::text,
      case when a.party_size>1 then a.id::text||':'||coalesce(ai.details->>'publicGuestIndex',ai.id::text) else a.id::text end as group_key
    from appointment_items ai join appointments a on a.id=ai.appointment_id
    where ai.location_id=${shop.locationId} and ai.resource_id=any(${resourceIds}) and ai.appointment_id<>${appointmentId}
      and ai.status in ('booked','in_service')
      and ai.starts_at<${wallMinuteToInstant(date,loc.tz,2880).toISOString()}::timestamptz
      and ai.ends_at>${wallMinuteToInstant(date,loc.tz,0).toISOString()}::timestamptz`:[];
  const fitsResources=(anchor:Date)=>{
    const proposed=items.map(i=>({resourceId:i.resource_id,staffId:i.membership_id,
      start:anchor.getTime()+Date.parse(i.starts_at)-anchorMs,end:anchor.getTime()+Date.parse(i.ends_at)-anchorMs,
      group:`current:${i.details?.['publicGuestIndex']??0}`}));
    return proposed.every(i=>{
      if(!i.resourceId)return true;
      const resource=resources.find(r=>r.id===i.resourceId)!;
      const existing=resourceBusy.filter(b=>b.resource_id===i.resourceId && Date.parse(b.starts_at)<i.end && i.start<Date.parse(b.ends_at));
      const peers=proposed.filter(p=>p.resourceId===i.resourceId && p.start<i.end && i.start<p.end);
      const groups=new Set([...existing.map(b=>b.group_key),...peers.map(p=>p.group)]);
      const people=new Set([...existing.map(b=>b.membership_id),...peers.map(p=>p.staffId)].filter(Boolean));
      return groups.size<=resource.capacity && (resource.max_staff===null || people.size<=resource.max_staff);
    });
  };

  const slots: ManagedSlot[] = [];
  const seen = new Set<number>();

  for (let startMin = first; startMin + spanMin <= closeMin; startMin += step) {
    if(!dayWindows(date,loc.hours).some(w=>startMin>=w.openMin && startMin+spanMin<=w.closeMin))continue;
    const startsAt = wallMinuteToInstant(date, loc.tz, startMin);
    if (startsAt.getTime() < earliest || !fitsResources(startsAt)) continue;
    if ((loc.settings as any).capacity?.use_recurring_staff) {
      let valid=true;
      for(const item of shape) {
        try { await enforceScheduledBooking(tx,shop.locationId,date,loc.settings,{membershipId:item.membershipId,startsAt:new Date(startsAt.getTime()+item.offsetMin*60000),endsAt:new Date(startsAt.getTime()+(item.offsetMin+item.durationMin)*60000)},busyRows.map(b=>({membershipId:b.membership_id,startsAt:new Date(b.starts_at),endsAt:new Date(b.ends_at),groupKey:b.group_key})),windows); }
        catch {valid=false;break;}
      }
      if(!valid)continue;
    }
    if (!fitsShape(shape, startMin, date, loc.tz, staff, staffById, locationBusy, (loc.settings as any).capacity?.use_recurring_staff ? bookingLimits(readBookingPolicy(loc.settings),new Set(windows.filter(w=>w.startMin<=startMin&&w.endMin>=startMin+spanMin).map(w=>w.id)).size,false).locationLimit : perSlot,
                   shapeGroupKey, (loc.settings as any).capacity?.use_recurring_staff===true)) {
      continue;
    }
    if (seen.has(startMin)) continue;
    seen.add(startMin);
    const primary = namedIds[0] ? staffById.get(namedIds[0]) : null;
    slots.push({
      startsAt: startsAt.toISOString(),
      staff: primary ? { id: primary.membershipId, displayName: primary.name } : null,
    });
    if (slots.length >= 400) break;
  }

  const staffOut = namedIds.length > 0
    ? namedIds.map((id) => {
      const s = staffById.get(id)!;
      return { id: s.membershipId, displayName: s.name, avatarUrl: null };
    })
    : [...staffById.values()].map((s) => ({ id: s.membershipId, displayName: s.name, avatarUrl: null }));

  return {
    date,
    timezone: loc.tz,
    durationMin: spanMin,
    canReschedule: true,
    reason: null,
    slots,
    staff: staffOut,
  };
}

export type ManagedSlotCheck =
  | { ok: true }
  | { ok: false; kind: 'permission' | 'validation'; reason: string };

/**
 * Guest reschedule must land on a slot the token-scoped availability
 * would display. Do not trust the client `startsAt`.
 */
export async function checkManagedRescheduleSlot(
  tx: postgres.TransactionSql,
  shop: Pick<PublicShopRow,'locationId'|'timezone'|'businessDayCutoff'|'onlineBooking'>,
  appointmentId: string,
  startsAt: Date,
): Promise<ManagedSlotCheck> {
  const items = await tx<ManagedAvailItem[]>`
    select membership_id, starts_at::text as starts_at, ends_at::text as ends_at,
           duration_min, resource_id, details
      from appointment_items
     where appointment_id = ${appointmentId} and status <> 'cancelled'
     order by starts_at, seq`;
  const shapeReason = guestRescheduleShapeReason(items);
  if (shapeReason) return { ok: false, kind: 'permission', reason: shapeReason };

  const date = businessDateOf(startsAt, shop.timezone, shop.businessDayCutoff);
  const avail = await loadManagedAvailability(tx, shop, appointmentId, date);
  if (!avail.canReschedule) {
    return { ok: false, kind: 'permission', reason: avail.reason ?? 'shape_unsupported' };
  }
  const want = startsAt.getTime();
  if (!avail.slots.some((s) => Date.parse(s.startsAt) === want)) {
    return { ok: false, kind: 'validation', reason: 'slot_unavailable' };
  }
  return { ok: true };
}

export function fitsShape(
  shape: Array<{ membershipId: string | null; offsetMin: number; durationMin: number }>,
  startMin: number,
  date: string,
  tz: string,
  staff: OccupancyStaff[],
  staffById: Map<string, OccupancyStaff>,
  locationBusy: Interval[],
  perSlot: number | null,
  /**
   * ⭐ 被改期的这张预约的 id。整组项目共用它作 groupKey ——
   * 少了这一条，一张两项的单在自己身上撞车：第一项排进 `extraBusy` 之后，
   * 第二项（同一位技师）就被自己顶成了超并发，客人永远改不了期。
   *
   * 传 null = 这张单代表多位客人（party_size > 1），项目之间照常互相计入。
   */
  groupKey: string | null,
  allowUnassigned=false,
): boolean {
  const extraBusy = new Map<string, Interval[]>();
  const extraLocation: Interval[] = [];
  let itemSeq = 0;
  const named = shape.filter((s) => s.membershipId);
  const unassigned = shape.filter((s) => !s.membershipId);

  const tryItem = (
    item: { membershipId: string | null; offsetMin: number; durationMin: number },
    member: OccupancyStaff | null,
  ): boolean => {
    const iStart = startMin + item.offsetMin;
    const iEnd = iStart + item.durationMin;
    const proposed: Interval = {
      startsAt: wallMinuteToInstant(date, tz, iStart),
      endsAt: wallMinuteToInstant(date, tz, iEnd),
      groupKey: groupKey ?? `managed-item:${itemSeq += 1}`,
    };
    if (member) {
      if (iStart < member.shiftStartMin || iEnd > member.shiftEndMin) return false;
      const existing = [
        ...member.busy,
        ...(extraBusy.get(member.membershipId) ?? []),
      ];
      const issues = checkCapacity({
        proposed,
        staff: {
          membershipId: member.membershipId,
          maxConcurrent: member.maxConcurrent,
          isBookable: true,
          existing,
        },
        location: {
          maxConcurrentPerSlot: perSlot,
          onDutyBookableCount: new Set(staff.filter(s=>s.shiftStartMin<=iStart && s.shiftEndMin>=iEnd).map(s=>s.membershipId)).size,
          existing: [...locationBusy, ...extraLocation],
        },
      });
      if (issues.length > 0) return false;
      const list = extraBusy.get(member.membershipId) ?? [];
      list.push(proposed);
      extraBusy.set(member.membershipId, list);
    } else {
      const issues = checkCapacity({
        proposed,
        staff: null,
        location: {
          maxConcurrentPerSlot: perSlot,
          onDutyBookableCount: new Set(staff.filter(s=>s.shiftStartMin<=iStart && s.shiftEndMin>=iEnd).map(s=>s.membershipId)).size,
          existing: [...locationBusy, ...extraLocation],
        },
      });
      if (issues.length > 0) return false;
    }
    extraLocation.push(proposed);
    return true;
  };

  for (const item of named) {
    const itemStart=startMin+item.offsetMin;
    const member = staff.find(s=>s.membershipId===item.membershipId && s.shiftStartMin<=itemStart && s.shiftEndMin>=itemStart+item.durationMin);
    if (!member || !tryItem(item, member)) return false;
  }
  for (const item of unassigned) {
    const iStart = startMin + item.offsetMin;
    const iEnd = iStart + item.durationMin;
    const proposed: Interval = {
      startsAt: wallMinuteToInstant(date, tz, iStart),
      endsAt: wallMinuteToInstant(date, tz, iEnd),
      groupKey: groupKey ?? `managed-item:${itemSeq += 1}`,
    };
    const free = staff.find((s) => {
      if (iStart < s.shiftStartMin || iEnd > s.shiftEndMin) return false;
      const existing = [...s.busy, ...(extraBusy.get(s.membershipId) ?? [])];
      // 按客人数算，与 checkCapacity 同一口径
      return overlappingOccupancy(existing, proposed) < s.maxConcurrent;
    });
    if (!free && !allowUnassigned) return false;
    if (!tryItem(item, allowUnassigned ? null : free!)) return false;
  }
  return true;
}

function pickName(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = (v ?? {}) as Record<string, string>;
  return o['en'] ?? o['zh-Hans'] ?? Object.values(o)[0] ?? 'Specialist';
}

function minutesNowIn(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}
