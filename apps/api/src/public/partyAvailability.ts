import type {PartyAvailabilityData} from "./partyAvailabilityData";
import {dayWindows} from '@gf/scheduling';
import { loadBookingStaff } from '../queries/bookingStaff';
import type postgres from "postgres";
import { AppError, ERROR_CODES, readPublicBookingProfile, serviceGuestCount, selectionGuests } from "@gf/contracts";
import {
  businessDateOf,
  isBookableDate,
  createWallMinuteResolver,
  planPartyAt,
  readBookingPolicy,
  bookingLimits,
  type PartyItem,
} from "@gf/scheduling";
import type { PublicShopRow } from "@gf/db";

export interface PartySelection {
  guestIndex: number;
  guestIndices?: number[] | undefined;
  serviceId: string;
  addonIds: string[];
  staffId: string | null;
}
export async function loadPartyAvailability(
  tx: postgres.TransactionSql,
  shop: Pick<
    PublicShopRow,
    | "locationId"
    | "timezone"
    | "businessDayCutoff"
    | "onlineBooking"
    | "settings"
    | "businessHours"
  >,
  args: {
    date: string;
    items: PartySelection[];
    startsAt?: string;
    excludeAppointmentId?: string | null;
    trustedUnits?: Array<{ durationMin: number; priceCents: number }>;
  },
  preloaded?: PartyAvailabilityData,
) {
  const wallMinuteToInstant = preloaded?.resolveMinute ?? createWallMinuteResolver();
  if(preloaded && (preloaded.locationId!==shop.locationId || !preloaded.staffByDate[args.date] || args.excludeAppointmentId || args.trustedUnits)) throw new Error('Invalid availability snapshot scope');
  const bad = (reason: string): never => {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason } });
  };
  const today = businessDateOf(
    new Date(),
    shop.timezone,
    shop.businessDayCutoff,
  );
  if (!isBookableDate(args.date, today, shop.onlineBooking.maxDaysAhead))
    bad("date_out_of_window");
  const guests = [...new Set(args.items.flatMap(i => [...selectionGuests(i)]))].sort(
    (a, b) => a - b,
  );
  if (
    !args.items.length ||
    guests.some((g, i) => g !== i) ||
    args.items.length > 20
  )
    bad("invalid_party");
  const profile = readPublicBookingProfile(shop.settings);
  if (guests.length > profile.maxPartySize) bad("invalid_party");
  if (
    !args.trustedUnits &&
    args.items.some((i) => profile.services[i.serviceId]?.visible === false)
  )
    bad("service_not_online_bookable");
  const ids = [
    ...new Set(args.items.flatMap((i) => [i.serviceId, ...i.addonIds])),
  ];
  const publicAddonIds = Object.entries(profile.services)
    .filter(([, v]) => v.visible === true)
    .map(([id]) => id);
  const services = preloaded ? preloaded.services.filter(s=>ids.includes(s.id)) : await tx<
    {
      id: string;
      name: unknown;
      duration_min: number;
      base_price_cents: number;
      is_addon: boolean;
      buffer_before_min: number;
      buffer_after_min: number;
      staff_count: number;
    }[]
  >`
    select id, name, duration_min, base_price_cents, is_addon, buffer_before_min, buffer_after_min, staff_count
    from services where location_id = ${shop.locationId} and id = any(${ids}) and active and (${!!args.trustedUnits} or online_bookable or (is_addon and id=any(${publicAddonIds})))`;
  if (services.length !== ids.length) bad("service_not_online_bookable");
  const staff = preloaded ? preloaded.staffByDate[args.date]! : await loadBookingStaff(tx,shop.locationId,args.date);
  const directory = preloaded ? preloaded.directory : await tx<
    { id: string; name: unknown; avatar: string | null; bio: unknown }[]
  >`
    select sp.membership_id as id,sp.display_name as name,sp.photo_url as avatar,sp.bio
    from staff_profiles sp join memberships m on m.id=sp.membership_id
    where sp.location_id=${shop.locationId} and sp.is_bookable and m.status='active'
    order by sp.display_name->>'en',sp.membership_id`;
  if (
    shop.onlineBooking.allowClientPickStaff === false &&
    args.items.some((i) => i.staffId)
  )
    bad("staff_selection_disabled");
  const requirements = preloaded ? preloaded.requirements.filter(r=>ids.includes(r.service_id)) : await tx<
    { service_id: string; skill_id: string; minimum_proficiency: number }[]
  >`
    select service_id, skill_id, minimum_proficiency from service_skill_requirements
    where location_id=${shop.locationId} and service_id=any(${ids})`;
  const skills = preloaded ? preloaded.skills : directory.length
    ? await tx<
        { membership_id: string; skill_id: string; proficiency: number }[]
      >`
    select membership_id, skill_id, proficiency from staff_skills where membership_id=any(${directory.map((s) => s.id)})`
    : [];
  const items: PartyItem[] = args.items.map((i, index) => {
    const svc = services.find((s) => s.id === i.serviceId)!;
    if (
      svc.is_addon ||
      (svc.staff_count < 1 || svc.staff_count > 5) ||
      (!args.trustedUnits && new Set(i.addonIds).size !== i.addonIds.length)
    )
      bad("unsupported_service_shape");
    const covered = selectionGuests(i);
    const requiredGuests = serviceGuestCount(svc.name, svc.staff_count, profile.services[svc.id]?.guestCount);
    if (requiredGuests > svc.staff_count) bad('unsupported_service_shape');
    if (covered.length !== requiredGuests || new Set(covered).size !== covered.length || !covered.includes(i.guestIndex)
      || covered.some(g => !Number.isInteger(g) || g < 0 || g >= profile.maxPartySize)) bad('invalid_service_guests');
    const addons = i.addonIds.map((id) => services.find((s) => s.id === id)!);
    if (addons.some((a) => !a.is_addon || a.staff_count !== 1))
      bad("invalid_addon");
    const needed = requirements.filter((r) =>
      [i.serviceId, ...i.addonIds].includes(r.service_id),
    );
    return {
      ...i,
      staffCount: svc.staff_count,
      resourceTypeId: profile.services[i.serviceId]?.resourceTypeId ?? null,
      durationMin:
        (args.trustedUnits?.[index]?.durationMin ??
          [svc, ...addons].reduce((n, s) => n + s.duration_min, 0)) +
        [svc, ...addons].reduce(
          (n, s) => n + s.buffer_before_min + s.buffer_after_min,
          0,
        ),
      priceCents:
        args.trustedUnits?.[index]?.priceCents ??
        [svc, ...addons].reduce((n, s) => n + s.base_price_cents, 0),
      eligibleStaffIds: [
        ...new Set(
          directory
            .filter((s) =>
              needed.every((r) =>
                skills.some(
                  (k) =>
                    k.membership_id === s.id &&
                    k.skill_id === r.skill_id &&
                    k.proficiency >= r.minimum_proficiency,
                ),
              ),
            )
            .map((s) => s.id),
        ),
      ],
    };
  });
  const existing = preloaded ? preloaded.existing : await tx<
    {
      starts_at: string;
      ends_at: string;
      membership_id: string | null;
      group_key: string;
    }[]
  >`
    select ai.starts_at::text, ai.ends_at::text, coalesce(ai.membership_id,ai.reserved_membership_id) as membership_id,
      case when ai.details ? 'serviceExecutionGroup' then ai.id::text when a.party_size>1 then a.id::text||':'||coalesce(ai.details->>'publicGuestIndex',ai.id::text) else a.id::text end as group_key
    from appointment_items ai join appointments a on a.id=ai.appointment_id
    where ai.location_id=${shop.locationId} and ai.status in ('booked','in_service')
      ${args.excludeAppointmentId ? tx`and ai.appointment_id<>${args.excludeAppointmentId}` : tx``}
      and ai.starts_at < ${wallMinuteToInstant(args.date, shop.timezone, 2880).toISOString()}::timestamptz
      and ai.ends_at > ${wallMinuteToInstant(args.date, shop.timezone, 0).toISOString()}::timestamptz`;
  const resourceTypes = [
    ...new Set(
      items.map((i) => i.resourceTypeId).filter((id): id is string => !!id),
    ),
  ];
  const resources = preloaded ? preloaded.resources.filter(r=>resourceTypes.includes(r.resource_type_id)) : resourceTypes.length
    ? await tx<
        {
          id: string;
          resource_type_id: string;
          capacity: number;
          max_staff: number | null;
        }[]
      >`
    select id,resource_type_id,capacity,max_staff from resources
    where location_id=${shop.locationId} and resource_type_id=any(${resourceTypes}) and status='available' order by id`
    : [];
  const resourceBusy = preloaded ? preloaded.existing.filter(r=>r.resource_id && resources.some(s=>s.id===r.resource_id)) : resources.length
    ? await tx<
        {
          resource_id: string;
          membership_id: string | null;
          starts_at: string;
          ends_at: string;
          group_key: string;
        }[]
      >`
    select ai.resource_id,coalesce(ai.membership_id,ai.reserved_membership_id) as membership_id,ai.starts_at::text,ai.ends_at::text,
      case when ai.details ? 'serviceExecutionGroup' then ai.id::text when a.party_size>1 then a.id::text||':'||coalesce(ai.details->>'publicGuestIndex',ai.id::text) else a.id::text end as group_key
    from appointment_items ai join appointments a on a.id=ai.appointment_id
    where ai.location_id=${shop.locationId} and ai.resource_id=any(${resources.map((r) => r.id)}) and ai.status in ('booked','in_service')
      ${args.excludeAppointmentId ? tx`and ai.appointment_id<>${args.excludeAppointmentId}` : tx``}
      and ai.starts_at<${wallMinuteToInstant(args.date, shop.timezone, 2880).toISOString()}::timestamptz
      and ai.ends_at>${wallMinuteToInstant(args.date, shop.timezone, 0).toISOString()}::timestamptz`
    : [];
  const plans: Array<{
    startsAt: string;
    items: NonNullable<ReturnType<typeof planPartyAt>>;
  }> = [];
  const earliest = Date.now() + shop.onlineBooking.minMinutesAhead * 60000;
  const policy = readBookingPolicy(shop.settings);
  const availableStaff = staff;
  const maxDuration = Math.max(...items.map(i => i.durationMin));
  const plannedStaff = availableStaff.map(s => ({
    id: s.id,
    startsAt: wallMinuteToInstant(args.date, shop.timezone, s.startMin),
    endsAt: wallMinuteToInstant(args.date, shop.timezone, s.endMin),
  }));
  const plannedExisting = existing.map(e => ({
    startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at),
    membershipId: e.membership_id, groupKey: e.group_key,
  }));
  const plannedResources = resources.map(r => ({
    id: r.id, typeId: r.resource_type_id, capacity: r.capacity, maxStaff: r.max_staff,
    busy: resourceBusy.filter(b => b.resource_id === r.id).map(b => ({
      startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at),
      membershipId: b.membership_id, groupKey: b.group_key,
    })),
  }));
  for (const {openMin:open,closeMin:close} of dayWindows(args.date,shop.businessHours)) {
    const step = Math.max(1, shop.onlineBooking.slotIntervalMinutes ?? 15);
    const closesAt = wallMinuteToInstant(args.date, shop.timezone, close);
    for (let m = Math.ceil(open / step) * step; m < close; m += step) {
      const startsAt = wallMinuteToInstant(args.date, shop.timezone, m);
      if (
        startsAt.getTime() < earliest ||
        (args.startsAt && Date.parse(args.startsAt) !== startsAt.getTime())
      )
        continue;
      if (!availableStaff.some(s=>s.startMin<=m && s.endMin>=m+maxDuration)) continue;
      const plan = planPartyAt({
        resources: plannedResources,
        startsAt,
        closesAt,
        items,
        staff: plannedStaff,
        existing: plannedExisting,
        unassignedLimit:policy.bufferEnabled?policy.bufferExtra:0,
        allowUnassigned: (shop.settings as any).capacity?.use_recurring_staff === true && policy.bufferEnabled,
        locationLimit: bookingLimits(
          policy,
          new Set(availableStaff.filter(s=>s.startMin<=m && s.endMin>=m+maxDuration).map((s) => s.id)).size,
          false,
        ).locationLimit,
      });
      if (plan && !plans.some((p) => p.startsAt === startsAt.toISOString()))
        plans.push({ startsAt: startsAt.toISOString(), items: plan });
    }
  }
  return {
    date: args.date,
    timezone: shop.timezone,
    plans,
    items,
    staff: directory,
  };
}
