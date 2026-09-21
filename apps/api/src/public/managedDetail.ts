/**
 * Guest management-detail payload. Only what the manage page needs.
 * Never includes customer phone/email, staff legal name, notes, or tenant ids.
 */

import { pickText } from '@gf/contracts';
import type { PublicShopRow } from '@gf/db';
import type postgres from 'postgres';
import { guestRescheduleShapeReason } from './managedAvailability';

export interface GuestActions {
  canReschedule: boolean;
  canCancel: boolean;
  canRebook: boolean;
  reason: string | null;
  rescheduleCountLeft: number | null;
}

export interface GuestPolicyArgs {
  status: string;
  startsAt: string;
  now?: Date;
  cancelCutoffHours: number;
  rescheduleEnabled: boolean;
  rescheduleCutoffHours: number;
  selfRescheduleMax: number;
  selfRescheduleCount: number;
  /** When set, guest self-reschedule cannot evaluate this appointment safely. */
  shapeReason?: string | null;
}

/**
 * Shared guest-cancel rule used by both the detail `actions` payload and the
 * public cancel route.
 *
 * `cancelled` returns null so the route can stay idempotent. The detail UI
 * still hides cancel because `guestActions` requires status `booked`.
 */
export function guestCancelBlockReason(args: GuestPolicyArgs): string | null {
  if (args.status === 'cancelled') return null;
  if (args.status !== 'booked') return 'not_mutable';
  const now = (args.now ?? new Date()).getTime();
  const start = new Date(args.startsAt).getTime();
  if (start - now < args.cancelCutoffHours * 3600_000) return 'cancel_cutoff_passed';
  return null;
}

/** Shared guest-reschedule rule. Detail flags and the mutation route agree. */
export function guestRescheduleBlockReason(args: GuestPolicyArgs): string | null {
  if (args.status === 'cancelled') return 'already_cancelled';
  if (args.status !== 'booked') return 'not_mutable';
  if (args.shapeReason) return args.shapeReason;
  if (!args.rescheduleEnabled) return 'reschedule_disabled';
  const underLimit = args.selfRescheduleMax === 0
    || args.selfRescheduleCount < args.selfRescheduleMax;
  if (!underLimit) return 'reschedule_limit_reached';
  const now = (args.now ?? new Date()).getTime();
  const start = new Date(args.startsAt).getTime();
  if (start - now < args.rescheduleCutoffHours * 3600_000) {
    return 'reschedule_cutoff_passed';
  }
  return null;
}

export function guestActions(args: GuestPolicyArgs): GuestActions {
  const cancelBlock = guestCancelBlockReason(args);
  const rescheduleBlock = guestRescheduleBlockReason(args);
  const booked = args.status === 'booked';
  const canCancel = booked && cancelBlock === null;
  const canReschedule = rescheduleBlock === null;

  let reason: string | null = null;
  if (!booked) reason = 'not_mutable';
  else if (!args.rescheduleEnabled && !canCancel) reason = 'reschedule_disabled';
  else if (rescheduleBlock === 'reschedule_limit_reached' && !canCancel) {
    reason = 'reschedule_limit_reached';
  } else if (!canReschedule && !canCancel) reason = 'cutoff_passed';
  else if (!canCancel) reason = 'cancel_cutoff_passed';
  else if (rescheduleBlock === 'shape_unsupported') reason = 'shape_unsupported';
  else if (rescheduleBlock === 'reschedule_disabled') reason = 'reschedule_disabled';
  else if (rescheduleBlock === 'reschedule_limit_reached') reason = 'reschedule_limit_reached';
  else if (rescheduleBlock) reason = 'reschedule_cutoff_passed';

  return {
    canReschedule,
    canCancel,
    canRebook: true,
    reason,
    rescheduleCountLeft: args.selfRescheduleMax > 0
      ? Math.max(0, args.selfRescheduleMax - args.selfRescheduleCount)
      : null,
  };
}

/**
 * Top-level booking window comes from `appointments.starts_at/ends_at`.
 * Item sequence is not a time order (simultaneous party items, or seq that
 * does not match end time). Never substitute the current clock.
 */
export function bookingWindow(appt: { starts_at: string; ends_at: string }): {
  startsAt: string;
  endsAt: string;
  durationMin: number;
} {
  const startMs = Date.parse(appt.starts_at);
  const endMs = Date.parse(appt.ends_at);
  const durationMin = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 60_000))
    : 0;
  return { startsAt: appt.starts_at, endsAt: appt.ends_at, durationMin };
}

export async function loadManagedBookingDetail(
  tx: postgres.TransactionSql,
  shop: PublicShopRow,
  appointmentId: string,
  locale: string,
): Promise<Record<string, unknown> | null> {
  const [appt] = await tx<{
    id: string; status: string;
    self_reschedule_count: number;
    starts_at: string; ends_at: string;
  }[]>`
    select id, status, self_reschedule_count,
           starts_at::text as starts_at, ends_at::text as ends_at
      from appointments
     where id = ${appointmentId} and location_id = ${shop.locationId}`;
  if (!appt) return null;

  const items = await tx<{
    service_id: string; name: unknown; addon_ids: string[]; details: Record<string, unknown>;
    starts_at: string; ends_at: string;
    duration_min: number; price_cents_snapshot: number;
    specialist: unknown;
    membership_id: string | null;
    resource_id: string | null;
  }[]>`
    select s.id as service_id, s.name, ai.addon_ids, ai.details,
           ai.starts_at::text as starts_at, ai.ends_at::text as ends_at,
           ai.duration_min, ai.price_cents_snapshot,
           case when ai.is_request then sp.display_name else null end as specialist,
           coalesce(ai.membership_id,ai.reserved_membership_id) as membership_id, ai.resource_id
      from appointment_items ai
      join services s on s.id = ai.service_id
      left join staff_profiles sp on sp.membership_id = ai.membership_id
     where ai.appointment_id = ${appt.id}
     order by ai.seq`;

  const addonIds = [...new Set(items.flatMap((i) => i.addon_ids ?? []))];
  const addonRows = addonIds.length === 0 ? [] : await tx<{ id: string; name: unknown }[]>`
    select id, name from services where id = any(${addonIds})`;
  const addonName = new Map(addonRows.map((r) => [r.id, pickText(r.name, locale)]));

  const { startsAt, endsAt, durationMin } = bookingWindow(appt);
  const priceCents = items.reduce((n, i) => n + i.price_cents_snapshot, 0);
  const cfg = shop.onlineBooking;
  const actions = guestActions({
    status: appt.status,
    startsAt,
    cancelCutoffHours: cfg.cancelCutoffHours,
    rescheduleEnabled: cfg.rescheduleEnabled,
    rescheduleCutoffHours: cfg.rescheduleCutoffHours,
    selfRescheduleMax: cfg.selfRescheduleMax,
    selfRescheduleCount: appt.self_reschedule_count,
    shapeReason: guestRescheduleShapeReason(items),
  });

  // A multi-specialist execution is one purchased service, with one total price.
  const displayGroups = new Map<string, Array<(typeof items)[number]>>();
  items.forEach((item, index) => {
    const key = typeof item.details?.serviceExecutionGroup === 'string' ? item.details.serviceExecutionGroup : `item:${index}`;
    displayGroups.set(key, [...(displayGroups.get(key) ?? []), item]);
  });
  const displayItems = [...displayGroups.values()].map(group => {
    const first = group[0]!;
    const guests = first.details?.publicGuestIndices;
    const addonIds = [...new Set(group.flatMap(item => item.addon_ids ?? []))];
    return {
      serviceId: first.service_id,
      guestIndex: Array.isArray(guests) ? Math.min(...guests) : Number(first.details?.publicGuestIndex ?? 0),
      ...(Array.isArray(guests) ? { guestIndices: guests } : {}),
      name: pickText(first.name, locale), addonIds,
      addonNames: addonIds.map(id => addonName.get(id)).filter(Boolean),
      startsAt: first.starts_at, endsAt: first.ends_at, durationMin: first.duration_min,
      priceCents: group.reduce((total, item) => total + item.price_cents_snapshot, 0),
      specialistName: group.map(item => item.specialist ? pickText(item.specialist, locale) : '').filter(Boolean).join(' + ') || null,
    };
  });
  return {
    bookingId: appt.id,
    status: appt.status,
    startsAt,
    endsAt,
    timezone: shop.timezone,
    durationMin,
    priceCents,
    specialistName: items[0]?.specialist ? pickText(items[0].specialist, locale) : null,
    items: displayItems,
    policy: {
      cancelCutoffHours: cfg.cancelCutoffHours,
      rescheduleEnabled: cfg.rescheduleEnabled,
      rescheduleCutoffHours: cfg.rescheduleCutoffHours,
      selfRescheduleMax: cfg.selfRescheduleMax,
    },
    actions,
  };
}
