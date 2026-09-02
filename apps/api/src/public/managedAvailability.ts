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
  businessDateOf, checkCapacity, wallMinuteToInstant, type Interval,
} from '@gf/scheduling';

export interface ManagedAvailItem {
  membership_id: string | null;
  starts_at: string;
  ends_at: string;
  duration_min: number;
  resource_id: string | null;
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
    if (item.resource_id) return 'shape_unsupported';
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
  shop: PublicShopRow,
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
           duration_min, resource_id
      from appointment_items
     where appointment_id = ${appointmentId} and status <> 'cancelled'
     order by starts_at, seq`;

  const shapeReason = guestRescheduleShapeReason(items);
  if (shapeReason) return empty(shapeReason, false);

  const anchorMs = Math.min(...items.map((i) => Date.parse(i.starts_at)));
  const shape = items.map((i) => ({
    membershipId: i.membership_id,
    offsetMin: Math.round((Date.parse(i.starts_at) - anchorMs) / 60_000),
    durationMin: i.duration_min,
  }));
  const spanMin = Math.max(...shape.map((s) => s.offsetMin + s.durationMin));

  const [loc] = await tx<{
    tz: string; cutoff: string;
    hours: Record<string, { open: string; close: string } | null>;
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

  const staffRows = await tx<{
    membership_id: string; name: unknown; start_min: number; end_min: number;
    max_concurrent: number;
  }[]>`
    select s.membership_id, sp.display_name as name, s.start_min, s.end_min,
           sp.max_concurrent_appointments as max_concurrent
      from shifts s
      join staff_profiles sp on sp.membership_id = s.membership_id
      join memberships m on m.id = s.membership_id and m.status = 'active'
     where s.location_id = ${shop.locationId}
       and s.business_date = ${date}
       and s.status = 'published'
       and sp.is_bookable = true
     order by sp.display_name->>'en'`;
  if (staffRows.length === 0) return empty(null, true, spanMin);

  const busyRows = await tx<{
    membership_id: string | null; starts_at: string | Date; ends_at: string | Date;
  }[]>`
    select ai.membership_id, ai.starts_at, ai.ends_at
      from appointment_items ai
      join appointments a on a.id = ai.appointment_id
     where a.location_id = ${shop.locationId}
       and a.business_date = ${date}
       and a.status <> 'cancelled'
       and a.id <> ${appointmentId}`;

  const busyBy = new Map<string, Interval[]>();
  const locationBusy: Interval[] = [];
  for (const b of busyRows) {
    const iv = { startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at) };
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
    maxConcurrent: r.max_concurrent ?? 1,
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

  const slots: ManagedSlot[] = [];
  const seen = new Set<number>();

  for (let startMin = first; startMin + spanMin <= closeMin; startMin += step) {
    const startsAt = wallMinuteToInstant(date, loc.tz, startMin);
    if (startsAt.getTime() < earliest) continue;
    if (!fitsShape(shape, startMin, date, loc.tz, staff, staffById, locationBusy, perSlot)) {
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
    : staff.map((s) => ({ id: s.membershipId, displayName: s.name, avatarUrl: null }));

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

function fitsShape(
  shape: Array<{ membershipId: string | null; offsetMin: number; durationMin: number }>,
  startMin: number,
  date: string,
  tz: string,
  staff: OccupancyStaff[],
  staffById: Map<string, OccupancyStaff>,
  locationBusy: Interval[],
  perSlot: number | null,
): boolean {
  const extraBusy = new Map<string, Interval[]>();
  const extraLocation: Interval[] = [];
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
          onDutyBookableCount: staff.length,
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
          onDutyBookableCount: staff.length,
          existing: [...locationBusy, ...extraLocation],
        },
      });
      if (issues.length > 0) return false;
    }
    extraLocation.push(proposed);
    return true;
  };

  for (const item of named) {
    const member = staffById.get(item.membershipId!)!;
    if (!tryItem(item, member)) return false;
  }
  for (const item of unassigned) {
    const iStart = startMin + item.offsetMin;
    const iEnd = iStart + item.durationMin;
    const proposed: Interval = {
      startsAt: wallMinuteToInstant(date, tz, iStart),
      endsAt: wallMinuteToInstant(date, tz, iEnd),
    };
    const free = staff.find((s) => {
      if (iStart < s.shiftStartMin || iEnd > s.shiftEndMin) return false;
      const existing = [...s.busy, ...(extraBusy.get(s.membershipId) ?? [])];
      return existing.filter((b) => overlaps(b, proposed)).length < s.maxConcurrent;
    });
    if (!free) return false;
    if (!tryItem(item, free)) return false;
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
