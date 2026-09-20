import type postgres from "postgres";
import { pickText } from "@gf/contracts";
import { formatWhen } from "../email/render";

/** Rendered inside the booking transaction: every message keeps its own snapshot. */
export async function bookingSummary(
  tx: postgres.TransactionSql,
  locationId: string,
  appointmentId: string,
): Promise<string> {
  const [loc] = await tx<
    {
      currency: string;
      timezone: string;
      address: unknown;
      settings: Record<string, unknown>;
      cancel_reason: string | null;
      status: string;
    }[]
  >`
    select l.currency,l.timezone,l.address,l.settings,a.cancel_reason,a.status from locations l
    join appointments a on a.location_id=l.id where l.id=${locationId} and a.id=${appointmentId}`;
  if (!loc) return "";
  const rows = await tx<
    {
      name: unknown;
      staff: unknown;
      starts_at: string;
      ends_at: string;
      price: number;
      details: Record<string, unknown>;
      addon_ids: string[];
    }[]
  >`
    select s.name,sp.display_name as staff,ai.starts_at::text,ai.ends_at::text,
      ai.price_cents_snapshot as price,ai.details,ai.addon_ids
    from appointment_items ai join services s on s.id=ai.service_id
    left join staff_profiles sp on sp.membership_id=ai.membership_id
    where ai.appointment_id=${appointmentId} and ai.location_id=${locationId} order by ai.seq`;
  const addonIds = [...new Set(rows.flatMap((r) => r.addon_ids ?? []))];
  const addons = addonIds.length
    ? await tx<
        { id: string; name: unknown }[]
      >`select id,name from services where location_id=${locationId} and id=any(${addonIds})`
    : [];
  const money = (c: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: loc.currency,
    }).format(c / 100);
  const address =
    typeof loc.address === "string"
      ? loc.address
      : Object.values((loc.address ?? {}) as Record<string, unknown>)
          .filter((v) => typeof v === "string")
          .join(", ");
  const booking = (loc.settings["online_booking"] ?? {}) as Record<
    string,
    unknown
  >;
  const cancellationReasons:Record<string,string>={guest_changed_mind:'Cancelled at the customer’s request.',duplicate_booking:'A duplicate booking was cancelled.',input_error:'The booking details needed correction.',no_show:'The appointment was marked as a no-show.',walk_out:'The guest left before service.',other:'The shop cancelled this appointment. Please contact the shop for details.'};
  return [
    ...(loc.status==='cancelled'?[cancellationReasons[loc.cancel_reason??'other']??cancellationReasons.other!]:[]),
    ...rows.map((r) =>
      [
        `Guest ${Number(r.details?.["publicGuestIndex"] ?? 0) + 1}: ${pickText(r.name, "en", "Service")}`,
        ...(r.addon_ids ?? []).map((id) =>
          pickText(addons.find((a) => a.id === id)?.name, "en", "Add-on"),
        ),
        `${formatWhen(r.starts_at, loc.timezone, "en-US")} – ${new Intl.DateTimeFormat("en-US", { timeZone: loc.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(r.ends_at))}`,
        r.staff
          ? pickText(r.staff, "en", "Specialist")
          : "Specialist assigned by shop",
        money(r.price),
      ].join(" · "),
    ),
    `Total: ${money(rows.reduce((n, r) => n + r.price, 0))}`,
    `Timezone: ${loc.timezone}`,
    ...(address ? [`Address: ${address}`] : []),
    `Cancel at least ${booking["cancel_cutoff_hours"] ?? 4} hours before the appointment.`,
    ...(booking["cancellation_policy_notice"]
      ? [String(booking["cancellation_policy_notice"])]
      : []),
  ].join("\n");
}
