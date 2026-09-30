import type postgres from "postgres";
import {
  AppError,
  ERROR_CODES,
  pickText,
  readPublicBookingProfile,
  serviceGuestCount,
} from "@gf/contracts";
import { readOnlineBooking, type PublicShopRow } from "@gf/db";
import { businessDateOf } from "@gf/scheduling";

export async function voiceCatalog(
  tx: postgres.TransactionSql,
  locationId: string,
) {
  const [loc] =
    await tx`select name,timezone,address,phone,business_hours,settings,business_day_cutoff::text as cutoff,
    holiday_calendar,status from locations where id=${locationId}`;
  if (!loc || ["closed", "suspended"].includes(loc.status))
    throw new AppError(ERROR_CODES.NOT_FOUND);
  const profile = readPublicBookingProfile(loc.settings);
  const rows =
    await tx`select id,name,duration_min,base_price_cents,is_addon,staff_count,online_bookable,
    buffer_before_min,buffer_after_min from services where location_id=${locationId} and active order by id`;
  const services = rows
    .filter(
      (s) =>
        profile.services[s.id]?.visible !== false &&
        (s.online_bookable ||
          (s.is_addon && profile.services[s.id]?.visible === true)),
    )
    .map((s, index) => ({
      serviceKey: `s${index + 1}`,
      serviceId: s.id as string,
      name: pickText(s.name, "en"),
      durationMin: s.duration_min as number,
      priceCents: s.base_price_cents as number,
      isAddon: s.is_addon as boolean,
      staffCount: s.staff_count as number,
      guestCount: serviceGuestCount(
        s.name,
        s.staff_count,
        profile.services[s.id]?.guestCount,
      ),
      bufferMinutes: (s.buffer_before_min + s.buffer_after_min) as number,
    }));
  const staff =
    await tx`select sp.membership_id,sp.display_name from staff_profiles sp join memberships m on m.id=sp.membership_id
    where sp.location_id=${locationId} and sp.is_bookable and m.status='active' order by sp.membership_id`;
  const requirements =
    await tx`select service_id,skill_id,minimum_proficiency from service_skill_requirements where location_id=${locationId}`;
  const skills = staff.length
    ? await tx`select membership_id,skill_id,proficiency from staff_skills where membership_id=any(${staff.map((s) => s.membership_id)})`
    : [];
  const now = new Date();
  const timezone = loc.timezone as string;
  const today = businessDateOf(now, timezone, "00:00");
  const shop = {
    locationId,
    timezone,
    businessDayCutoff: loc.cutoff as string,
    businessHours: loc.business_hours as PublicShopRow["businessHours"],
    settings: loc.settings as Record<string, unknown>,
    onlineBooking: readOnlineBooking(loc.settings),
  };
  return {
    shop,
    holidays: loc.holiday_calendar as unknown[],
    services,
    context: {
      shop: {
        name: pickText(loc.name, "en"),
        timezone,
        address: loc.address,
        phone: loc.phone,
        businessHours: loc.business_hours,
        currentTime: now.toISOString(),
        today,
      },
      services,
      staff: staff.map((s) => ({
        membershipId: s.membership_id,
        name: pickText(s.display_name, "en"),
        serviceIds: services
          .filter((v) =>
            requirements
              .filter((r) => r.service_id === v.serviceId)
              .every((r) =>
                skills.some(
                  (k) =>
                    k.membership_id === s.membership_id &&
                    k.skill_id === r.skill_id &&
                    k.proficiency >= r.minimum_proficiency,
                ),
              ),
          )
          .map((v) => v.serviceId),
      })),
      rules: {
        maxPartySize: profile.maxPartySize,
        maxDaysAhead: shop.onlineBooking.maxDaysAhead,
        minMinutesAhead: shop.onlineBooking.minMinutesAhead,
        slotIntervalMinutes: shop.onlineBooking.slotIntervalMinutes ?? 30,
        allowClientPickStaff: shop.onlineBooking.allowClientPickStaff,
      },
    },
  };
}
