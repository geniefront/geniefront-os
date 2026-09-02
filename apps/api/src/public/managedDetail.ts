/**
 * Guest management-detail payload. Only what the manage page needs.
 * Never includes customer phone/email, staff legal name, notes, or tenant ids.
 */

import { pickText } from '@gf/contracts';
import type { PublicShopRow } from '@gf/db';
import type postgres from 'postgres';

export interface GuestActions {
  canReschedule: boolean;
  canCancel: boolean;
  canRebook: boolean;
  reason: string | null;
  rescheduleCountLeft: number | null;
}

export function guestActions(args: {
  status: string;
  startsAt: string;
  now?: Date;
  cancelCutoffHours: number;
  rescheduleEnabled: boolean;
  rescheduleCutoffHours: number;
  selfRescheduleMax: number;
  selfRescheduleCount: number;
}): GuestActions {
  const now = (args.now ?? new Date()).getTime();
  const start = new Date(args.startsAt).getTime();
  const booked = args.status === 'booked';
  const cancelOk = booked && start - now >= args.cancelCutoffHours * 3600_000;
  const underLimit = args.selfRescheduleMax === 0
    || args.selfRescheduleCount < args.selfRescheduleMax;
  const rescheduleOk = booked
    && args.rescheduleEnabled
    && underLimit
    && start - now >= args.rescheduleCutoffHours * 3600_000;

  let reason: string | null = null;
  if (!booked) reason = 'not_mutable';
  else if (!args.rescheduleEnabled && !cancelOk) reason = 'reschedule_disabled';
  else if (!underLimit && !cancelOk) reason = 'reschedule_limit_reached';
  else if (!rescheduleOk && !cancelOk) reason = 'cutoff_passed';
  else if (!cancelOk) reason = 'cancel_cutoff_passed';
  else if (!args.rescheduleEnabled) reason = 'reschedule_disabled';
  else if (!underLimit) reason = 'reschedule_limit_reached';
  else if (!rescheduleOk) reason = 'reschedule_cutoff_passed';

  return {
    canReschedule: rescheduleOk,
    canCancel: cancelOk,
    canRebook: true,
    reason,
    rescheduleCountLeft: args.selfRescheduleMax > 0
      ? Math.max(0, args.selfRescheduleMax - args.selfRescheduleCount)
      : null,
  };
}

export async function loadManagedBookingDetail(
  tx: postgres.TransactionSql,
  shop: PublicShopRow,
  appointmentId: string,
  locale: string,
): Promise<Record<string, unknown> | null> {
  const [appt] = await tx<{
    id: string; status: string; confirmation_code: string | null;
    self_reschedule_count: number;
  }[]>`
    select id, status, confirmation_code, self_reschedule_count
      from appointments
     where id = ${appointmentId} and location_id = ${shop.locationId}`;
  if (!appt) return null;

  const items = await tx<{
    name: unknown; addon_ids: string[];
    starts_at: string; ends_at: string;
    duration_min: number; price_cents_snapshot: number;
    specialist: unknown;
  }[]>`
    select s.name, ai.addon_ids,
           ai.starts_at::text as starts_at, ai.ends_at::text as ends_at,
           ai.duration_min, ai.price_cents_snapshot,
           sp.display_name as specialist
      from appointment_items ai
      join services s on s.id = ai.service_id
      left join staff_profiles sp on sp.membership_id = ai.membership_id
     where ai.appointment_id = ${appt.id}
     order by ai.seq`;

  const addonIds = [...new Set(items.flatMap((i) => i.addon_ids ?? []))];
  const addonRows = addonIds.length === 0 ? [] : await tx<{ id: string; name: unknown }[]>`
    select id, name from services where id = any(${addonIds})`;
  const addonName = new Map(addonRows.map((r) => [r.id, pickText(r.name, locale)]));

  const first = items[0];
  const startsAt = first?.starts_at ?? new Date().toISOString();
  const endsAt = items.at(-1)?.ends_at ?? startsAt;
  const durationMin = items.reduce((n, i) => n + i.duration_min, 0);
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
  });

  return {
    bookingId: appt.id,
    confirmationCode: appt.confirmation_code,
    status: appt.status,
    startsAt,
    endsAt,
    timezone: shop.timezone,
    durationMin,
    priceCents,
    specialistName: first?.specialist ? pickText(first.specialist, locale) : null,
    items: items.map((i) => ({
      name: pickText(i.name, locale),
      addonNames: (i.addon_ids ?? []).map((id) => addonName.get(id)).filter(Boolean),
      startsAt: i.starts_at,
      endsAt: i.ends_at,
      durationMin: i.duration_min,
      priceCents: i.price_cents_snapshot,
      specialistName: i.specialist ? pickText(i.specialist, locale) : null,
    })),
    policy: {
      cancelCutoffHours: cfg.cancelCutoffHours,
      rescheduleEnabled: cfg.rescheduleEnabled,
      rescheduleCutoffHours: cfg.rescheduleCutoffHours,
      selfRescheduleMax: cfg.selfRescheduleMax,
    },
    actions,
  };
}
