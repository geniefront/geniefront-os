import type postgres from "postgres";
import type { PublicShopRow } from "@gf/db";
import { readPublicBookingProfile } from "@gf/contracts";
import { createWallMinuteResolver } from "@gf/scheduling";
import {
  recurringWindows,
  type loadBookingStaff,
} from "../queries/bookingStaff";

export interface PartyAvailabilityData {
  // Scoped to this calculation; never persisted in the public snapshot.
  resolveMinute?: ReturnType<typeof createWallMinuteResolver>;
  locationId: string;
  services: Array<{
    id: string;
    name: unknown;
    duration_min: number;
    base_price_cents: number;
    is_addon: boolean;
    buffer_before_min: number;
    buffer_after_min: number;
    staff_count: number;
  }>;
  directory: Array<{
    id: string;
    name: unknown;
    avatar: string | null;
    bio: unknown;
  }>;
  requirements: Array<{
    service_id: string;
    skill_id: string;
    minimum_proficiency: number;
  }>;
  skills: Array<{
    membership_id: string;
    skill_id: string;
    proficiency: number;
  }>;
  staffByDate: Record<string, Awaited<ReturnType<typeof loadBookingStaff>>>;
  existing: Array<{
    starts_at: string;
    ends_at: string;
    membership_id: string | null;
    group_key: string;
    resource_id: string | null;
  }>;
  resources: Array<{
    id: string;
    resource_type_id: string;
    capacity: number;
    max_staff: number | null;
  }>;
}
/** One bounded set of seven reads for every date/service in a snapshot.
 * The caller must keep this object inside its read transaction, never use it for booking writes. */
export async function loadPartyAvailabilityData(
  tx: postgres.TransactionSql,
  shop: Pick<
    PublicShopRow,
    "locationId" | "timezone" | "settings" | "businessHours"
  >,
  dates: string[],
): Promise<PartyAvailabilityData> {
  if (!dates.length) throw new Error("Snapshot dates required");
  const wallMinuteToInstant = createWallMinuteResolver();
  const sorted = [...dates].sort(),
    first = sorted[0]!,
    last = sorted[sorted.length - 1]!;
  const profile = readPublicBookingProfile(shop.settings);
  const addonIds = Object.entries(profile.services)
    .filter(([, v]) => v.visible === true)
    .map(([id]) => id);
  const [
    services,
    directory,
    requirements,
    skills,
    shifts,
    existing,
    resources,
  ] = await Promise.all([
    tx<
      PartyAvailabilityData["services"]
    >`select id,name,duration_min,base_price_cents,is_addon,buffer_before_min,buffer_after_min,staff_count
      from services where location_id=${shop.locationId} and active and (online_bookable or (is_addon and id=any(${addonIds})))`,
    tx<
      PartyAvailabilityData["directory"]
    >`select sp.membership_id as id,sp.display_name as name,sp.photo_url as avatar,sp.bio
      from staff_profiles sp join memberships m on m.id=sp.membership_id where sp.location_id=${shop.locationId} and sp.is_bookable and m.status='active'
      order by sp.display_name->>'en',sp.membership_id`,
    tx<
      PartyAvailabilityData["requirements"]
    >`select service_id,skill_id,minimum_proficiency from service_skill_requirements where location_id=${shop.locationId}`,
    tx<
      PartyAvailabilityData["skills"]
    >`select k.membership_id,k.skill_id,k.proficiency from staff_skills k join memberships m on m.id=k.membership_id where m.location_id=${shop.locationId}`,
    tx<
      Array<{
        business_date: string;
        membership_id: string;
        start_min: number;
        end_min: number;
        status: string;
      }>
    >`select business_date::text,membership_id,start_min,end_min,status from shifts where location_id=${shop.locationId} and business_date>=${first}::date and business_date<=${last}::date`,
    tx<
      PartyAvailabilityData["existing"]
    >`select ai.starts_at::text,ai.ends_at::text,coalesce(ai.membership_id,ai.reserved_membership_id) as membership_id,ai.resource_id,
      case when ai.details ? 'serviceExecutionGroup' then ai.id::text when a.party_size>1 then a.id::text||':'||coalesce(ai.details->>'publicGuestIndex',ai.id::text) else a.id::text end as group_key
      from appointment_items ai join appointments a on a.id=ai.appointment_id where ai.location_id=${shop.locationId} and ai.status in ('booked','in_service')
      and ai.starts_at<${wallMinuteToInstant(last, shop.timezone, 2880).toISOString()}::timestamptz and ai.ends_at>${wallMinuteToInstant(first, shop.timezone, 0).toISOString()}::timestamptz`,
    tx<
      PartyAvailabilityData["resources"]
    >`select id,resource_type_id,capacity,max_staff from resources where location_id=${shop.locationId} and status='available' order by id`,
  ]);
  const staffByDate: PartyAvailabilityData["staffByDate"] = {};
  for (const date of dates)
    staffByDate[date] = recurringWindows(
      shop.settings,
      shop.businessHours,
      date,
      directory.map((s) => s.id),
      shifts.filter((s) => s.business_date === date),
    ).map((w) => ({
      ...w,
      startsAt: wallMinuteToInstant(date, shop.timezone, w.startMin),
      endsAt: wallMinuteToInstant(date, shop.timezone, w.endMin),
    }));
  return {
    resolveMinute: wallMinuteToInstant,
    locationId: shop.locationId,
    services,
    directory,
    requirements,
    skills,
    staffByDate,
    existing,
    resources,
  };
}
