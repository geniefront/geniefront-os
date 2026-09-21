import {dayWindows} from '@gf/scheduling';
import { loadBookingStaff } from '../queries/bookingStaff';
import type postgres from "postgres";
import { AppError, ERROR_CODES, readPublicBookingProfile } from "@gf/contracts";
import {
  businessDateOf,
  isBookableDate,
  wallMinuteToInstant,
  planPartyAt,
  readBookingPolicy,
  bookingLimits,
  type PartyItem,
} from "@gf/scheduling";
import type { PublicShopRow } from "@gf/db";

export interface PartySelection {
  guestIndex: number;
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
) {
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
  const guests = [...new Set(args.items.map((i) => i.guestIndex))].sort(
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
  const services = await tx<
    {
      id: string;
      duration_min: number;
      base_price_cents: number;
      is_addon: boolean;
      buffer_before_min: number;
      buffer_after_min: number;
      staff_count: number;
    }[]
  >`
    select id, duration_min, base_price_cents, is_addon, buffer_before_min, buffer_after_min, staff_count
    from services where location_id = ${shop.locationId} and id = any(${ids}) and active and (${!!args.trustedUnits} or online_bookable or (is_addon and id=any(${publicAddonIds})))`;
  if (services.length !== ids.length) bad("service_not_online_bookable");
  const staff = await loadBookingStaff(tx,shop.locationId,args.date);
  const directory = await tx<
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
  const requirements = await tx<
    { service_id: string; skill_id: string; minimum_proficiency: number }[]
  >`
    select service_id, skill_id, minimum_proficiency from service_skill_requirements
    where location_id=${shop.locationId} and service_id=any(${ids})`;
  const skills = directory.length
    ? await tx<
        { membership_id: string; skill_id: string; proficiency: number }[]
      >`
    select membership_id, skill_id, proficiency from staff_skills where membership_id=any(${directory.map((s) => s.id)})`
    : [];
  const items: PartyItem[] = args.items.map((i, index) => {
    const svc = services.find((s) => s.id === i.serviceId)!;
    if (
      svc.is_addon ||
      svc.staff_count !== 1 ||
      (!args.trustedUnits && new Set(i.addonIds).size !== i.addonIds.length)
    )
      bad("unsupported_service_shape");
    const addons = i.addonIds.map((id) => services.find((s) => s.id === id)!);
    if (addons.some((a) => !a.is_addon || a.staff_count !== 1))
      bad("invalid_addon");
    const needed = requirements.filter((r) =>
      [i.serviceId, ...i.addonIds].includes(r.service_id),
    );
    return {
      ...i,
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
  const existing = await tx<
    {
      starts_at: string;
      ends_at: string;
      membership_id: string | null;
      group_key: string;
    }[]
  >`
    select ai.starts_at::text, ai.ends_at::text, ai.membership_id,
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
  const resources = resourceTypes.length
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
  const resourceBusy = resources.length
    ? await tx<
        {
          resource_id: string;
          membership_id: string | null;
          starts_at: string;
          ends_at: string;
          group_key: string;
        }[]
      >`
    select ai.resource_id,ai.membership_id,ai.starts_at::text,ai.ends_at::text,
      case when ai.details ? 'serviceExecutionGroup' then ai.id::text when a.party_size>1 then a.id::text||':'||coalesce(ai.details->>'publicGuestIndex',ai.id::text) else a.id::text end as group_key
    from appointment_items ai join appointments a on a.id=ai.appointment_id
    where ai.location_id=${shop.locationId} and ai.resource_id=any(${resources.map((r) => r.id)}) and ai.status in ('booked','in_service')
      ${args.excludeAppointmentId ? tx`and ai.appointment_id<>${args.excludeAppointmentId}` : tx``}
      and ai.starts_at<${wallMinuteToInstant(args.date, shop.timezone, 2880).toISOString()}::timestamptz
      and ai.ends_at>${wallMinuteToInstant(args.date, shop.timezone, 0).toISOString()}::timestamptz`
    : [];
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
    new Date(`${args.date}T12:00:00Z`).getUTCDay()
  ]!;
  const hours = shop.businessHours[day];
  const minutes = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    return h! * 60 + m!;
  };
  const plans: Array<{
    startsAt: string;
    items: NonNullable<ReturnType<typeof planPartyAt>>;
  }> = [];
  for (const {openMin:open,closeMin:close} of dayWindows(args.date,shop.businessHours)) {
    const step = Math.max(1, shop.onlineBooking.slotIntervalMinutes ?? 15);
    const earliest = Date.now() + shop.onlineBooking.minMinutesAhead * 60000;
    const policy = readBookingPolicy(shop.settings);
    const availableStaff = staff;
    for (let m = Math.ceil(open / step) * step; m < close; m += step) {
      const startsAt = wallMinuteToInstant(args.date, shop.timezone, m);
      if (
        startsAt.getTime() < earliest ||
        (args.startsAt && Date.parse(args.startsAt) !== startsAt.getTime())
      )
        continue;
      if (!availableStaff.some(s=>s.startMin<=m && s.endMin>=m+Math.max(...items.map(i=>i.durationMin)))) continue;
      const plan = planPartyAt({
        resources: resources.map((r) => ({
          id: r.id,
          typeId: r.resource_type_id,
          capacity: r.capacity,
          maxStaff: r.max_staff,
          busy: resourceBusy
            .filter((b) => b.resource_id === r.id)
            .map((b) => ({
              startsAt: new Date(b.starts_at),
              endsAt: new Date(b.ends_at),
              membershipId: b.membership_id,
              groupKey: b.group_key,
            })),
        })),
        startsAt,
        closesAt: wallMinuteToInstant(args.date, shop.timezone, close),
        items,
        staff: availableStaff.map((s) => ({
          id: s.id,
          startsAt: wallMinuteToInstant(args.date, shop.timezone, s.startMin),
          endsAt: wallMinuteToInstant(args.date, shop.timezone, s.endMin),
        })),
        existing: existing.map((e) => ({
          startsAt: new Date(e.starts_at),
          endsAt: new Date(e.ends_at),
          membershipId: e.membership_id,
          groupKey: e.group_key,
        })),
        unassignedLimit:policy.bufferEnabled?policy.bufferExtra:0,
        allowUnassigned: (shop.settings as any).capacity?.use_recurring_staff === true && policy.bufferEnabled,
        locationLimit: bookingLimits(
          policy,
          new Set(availableStaff.filter(s=>s.startMin<=m && s.endMin>=m+Math.max(...items.map(i=>i.durationMin))).map((s) => s.id)).size,
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
