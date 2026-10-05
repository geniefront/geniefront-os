import {depositRequestDetails} from '../commerce/depositRequestDetails';
import {depositPaymentSources} from '../commerce/depositSources';
/**
 * Guest management-detail payload. Only what the manage page needs.
 * Never includes customer phone/email, staff legal name, notes, or tenant ids.
 */

import { pickText } from '@gf/contracts';
import type { PublicShopRow } from '@gf/db';
import type postgres from 'postgres';
import { guestRescheduleShapeReason } from './managedAvailability';
import {depositGuestBalances} from '../commerce/depositGuests';
import {loadGuestCancellationDetails} from '../commerce/guestCancellationDetails';

export interface GuestActions {
  canReschedule: boolean;
  canCancel: boolean;
  canRebook: boolean;
  reason: string | null;
  rescheduleCountLeft: number | null;
}

/** A purchased deposit keeps its agreed cancellation deadline when the store changes settings. */
export function depositCancellationCutoff(policy:Record<string,unknown>|null|undefined,fallback:number):number{
  const value=policy?.cancelCutoffHours;
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:fallback;
}

export interface GuestPolicyArgs {
  status: string;
  startsAt: string;
  /** Original booking creation time; edits never restart this window. */
  createdAt?: string;
  now?: Date;
  cancelCutoffHours: number;
  rescheduleEnabled: boolean;
  rescheduleCutoffHours: number;
  selfRescheduleMax: number;
  selfRescheduleCount: number;
  /** When set, guest self-reschedule cannot evaluate this appointment safely. */
  shapeReason?: string | null;
}

/** A short correction window only waives the advance-notice cutoff. */
export function withinBookingCorrectionWindow(args: Pick<GuestPolicyArgs, 'createdAt' | 'startsAt' | 'now'>): boolean {
  const now = (args.now ?? new Date()).getTime();
  const created = Date.parse(args.createdAt ?? '');
  return Number.isFinite(created) && created <= now && now - created <= 15 * 60_000
    && Date.parse(args.startsAt) > now;
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
  if (start - now < args.cancelCutoffHours * 3600_000 && !withinBookingCorrectionWindow(args)) return 'cancel_cutoff_passed';
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
  if (start - now < args.rescheduleCutoffHours * 3600_000 && !withinBookingCorrectionWindow(args)) {
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
    id: string; status: string;party_size:number;deposit_status:string;
    self_reschedule_count: number;
    starts_at: string; ends_at: string; created_at: string;
  }[]>`
    select id, status, party_size,deposit_status,self_reschedule_count, created_at::text,
           starts_at::text as starts_at, ends_at::text as ends_at
      from appointments
     where id = ${appointmentId} and location_id = ${shop.locationId}`;
  if (!appt) return null;

  const [held]=await tx<{id:string;status:string;amount_cents:number;currency:string;expires_at:string;reserved_cents:number;balance:number;
    current_required:number;commerce_frozen:boolean;policy_snapshot:Record<string,unknown>;checkout_url:string|null;payable:boolean;applied:number;refunded:number;retained:number;service_settled:boolean;waived_at:string|null;order_id:string|null}[]>`
    select h.id,h.status,h.amount_cents,h.currency,h.expires_at::text,h.reserved_cents,h.commerce_frozen,
      coalesce((select required_cents from commerce_deposit_requotes where hold_id=h.id order by revision desc limit 1),h.amount_cents) as current_required,h.policy_snapshot,h.waived_at::text,h.order_id,p.checkout_url,
      h.status='pending' and h.expires_at>now() as payable,
      (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance,
      (select -coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id and entry in('applied','restored')) as applied,
      (select -coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id and entry='refund') as refunded,
      (select -coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id and entry in('retained','retention_released')) as retained,
      exists(select 1 from tickets t where t.appointment_id=h.appointment_id and t.status<>'voided' and t.service_settled_at is not null) as service_settled
    from commerce_appointment_holds h left join commerce_payments p on p.order_id=h.order_id where h.appointment_id=${appt.id}`;

  const items = await tx<{
    service_id: string; name: unknown; addon_ids: string[]; details: Record<string, unknown>;
    starts_at: string; ends_at: string; created_at: string;
    duration_min: number; price_cents_snapshot: number;
    specialist: unknown;
    membership_id: string | null;
    resource_id: string | null;status:string;
  }[]>`
    select s.id as service_id,s.name,ai.addon_ids,ai.details,ai.status,
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
  const originalPriceCents=items.reduce((n,i)=>n+i.price_cents_snapshot,0);
  const priceCents = items.filter(i=>i.status!=='cancelled').reduce((n, i) => n + i.price_cents_snapshot, 0);
  const cfg = shop.onlineBooking;
  const cancelCutoffHours=depositCancellationCutoff(held?.policy_snapshot,cfg.cancelCutoffHours);
  const actions = guestActions({
    status: appt.status,
    startsAt,
    createdAt: appt.created_at,
    cancelCutoffHours,
    rescheduleEnabled: cfg.rescheduleEnabled,
    rescheduleCutoffHours: cfg.rescheduleCutoffHours,
    selfRescheduleMax: cfg.selfRescheduleMax,
    selfRescheduleCount: appt.self_reschedule_count,
    shapeReason: guestRescheduleShapeReason(items.filter(i=>i.status!=='cancelled')),
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
      status:first.status,
      ...(Array.isArray(guests) ? { guestIndices: guests } : {}),
      name: pickText(first.name, locale), addonIds,
      addonNames: addonIds.map(id => addonName.get(id)).filter(Boolean),
      startsAt: first.starts_at, endsAt: first.ends_at, durationMin: first.duration_min,
      priceCents: group.reduce((total, item) => total + item.price_cents_snapshot, 0),
      specialistName: group.map(item => item.specialist ? pickText(item.specialist, locale) : '').filter(Boolean).join(' + ') || null,
    };
  });
  const cancellations=await tx<{guest_index:number}[]>`select guest_index from appointment_guest_cancellations where appointment_id=${appt.id}`;
  const request=held?await depositRequestDetails(tx,{locationId:shop.locationId},held.id):null;
  const paymentSources=held?await depositPaymentSources(tx,{locationId:shop.locationId},held.id):[];
  const available=held?.commerce_frozen||held?.waived_at?0:paymentSources.reduce((n,p)=>n+p.availableCents,0);
  const guestBalances=held?await depositGuestBalances(tx,{locationId:shop.locationId},held.id):null;
  const originalAllocation=held?.policy_snapshot.guestAllocation as {method:string;guests:Array<{guestIndex:number;serviceTotalCents:number;amountCents:number}>}|undefined;
  const guestAllocation=originalAllocation&&Array.isArray(originalAllocation.guests)?{...originalAllocation,guests:originalAllocation.guests.map(g=>({...g,
    cancelled:cancellations.some(c=>c.guest_index===g.guestIndex),refundStatus:guestBalances?.find(b=>b.guestIndex===g.guestIndex)?.refundStatus??null}))}:null;
  const [ticket]=await tx`select id from tickets where appointment_id=${appt.id} and status<>'voided' limit 1`;
  const cancellationDetails=await loadGuestCancellationDetails(tx,shop.locationId,appt.id,
    {partySize:appt.party_size,status:appt.status,depositStatus:appt.deposit_status},
    items.map((item,index)=>({groupKey:typeof item.details.serviceExecutionGroup==='string'?item.details.serviceExecutionGroup:`item:${index}`,
      priceCents:item.price_cents_snapshot,status:item.status,details:item.details})),{moneyVisible:true,ticketExists:!!ticket});
  if(cancellationDetails.guestCancellation&&!actions.canCancel){cancellationDetails.guestCancellation.enabled=false;
    cancellationDetails.guestCancellation.reason??=actions.reason??'appointment_not_editable';}
  return {
    bookingId: appt.id,
    status: appt.status,
    ...cancellationDetails,
    ...(held?{deposit:{status:held.waived_at?'waived':held.commerce_frozen?'review':held.status,financialStatus:held.status,amountCents:request?.amountCents??held.amount_cents,currency:held.currency.toUpperCase(),
      availableCents:available,excessCents:held.service_settled?available:Math.max(0,available-Math.max(0,held.current_required-held.applied)),appliedCents:held.applied,refundedCents:held.refunded,retainedCents:held.retained,expiresAt:request?.expiresAt??held.expires_at,
      serviceRemainingCents:held.service_settled||['cancelled','no_show'].includes(appt.status)?0:
        Math.max(0,priceCents-(held.waived_at?0:held.status==='pending'?(request?.amountCents??held.amount_cents):available+held.applied)),
      checkoutUrl:request?.checkoutUrl??null,paymentMethod:request?.channel==='online'?'online':'frontdesk',
      ...(!held.service_settled&&!['cancelled','no_show','done'].includes(appt.status)&&request?.purpose==='supplement'&&['open','expired'].includes(request.state)?{additionalPayment:{amountCents:request.amountCents,expiresAt:request.expiresAt,state:request.state,checkoutUrl:request.checkoutUrl,paymentMethod:request.channel==='online'?'online':'frontdesk'}}:{}),
      policy:{cancelCutoffHours:held.policy_snapshot.cancelCutoffHours,
        notice:held.policy_snapshot.cancellationPolicyNotice??'',retainAfterCutoff:held.policy_snapshot.retainAfterCutoff===true},
      ...(guestAllocation?{guestAllocation}:{})}}:{ }),
    startsAt,
    endsAt,
    timezone: shop.timezone,
    durationMin,
    priceCents,
    originalPriceCents,
    specialistName: items[0]?.specialist ? pickText(items[0].specialist, locale) : null,
    items: displayItems,
    policy: {
      cancelCutoffHours,
      rescheduleEnabled: cfg.rescheduleEnabled,
      rescheduleCutoffHours: cfg.rescheduleCutoffHours,
      selfRescheduleMax: cfg.selfRescheduleMax,
    },
    actions,
  };
}
