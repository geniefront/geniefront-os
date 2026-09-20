import type postgres from "postgres";
import {
  pickText,
  readPublicBookingProfile,
  type CommandContext,
} from "@gf/contracts";
import { bookingSummary } from "./bookingSummary";
import { notifyEvent } from "./dispatch";
import { staffAppointmentUrl } from "../links";
import { renderTemplatedEmailHtml } from "../email/layout";
import { formatWhen } from "../email/render";
import { tenDlcApproved } from "../sms/gate";
import { smsFrom } from "../sms/send";
import { withComplianceFooter } from "../sms/render";
import { measure, segmentsOf } from "../sms/segments";

/** Shop notices are independent of customer contact data and default OFF.
 * Staff notices retain the existing per-event/channel rules. */
export async function notifyBookingRecipients(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  args: {
    appointmentId: string;
    occurrence: string;
    event: "created" | "changed" | "cancelled";
    oldStartsAt?: string | null;
    previousStaffIds?: string[];
  },
) {
  const [row] = await tx<
    {
      name: unknown;
      email: string | null;
      phone: string | null;
      settings: Record<string, unknown>;
      timezone: string;
      starts_at: string;
      customer: unknown;
      party_size: number;
      notes: string | null;
    }[]
  >`
    select l.name,l.email,l.phone,l.settings,l.timezone,a.starts_at::text,c.display_name as customer,a.party_size,a.notes
    from appointments a join locations l on l.id=a.location_id left join customers c on c.id=a.customer_id
    where a.id=${args.appointmentId} and a.location_id=${ctx.locationId}`;
  if (!row) return;
  const summary = await bookingSummary(tx, ctx.locationId, args.appointmentId);
  const link = staffAppointmentUrl(args.appointmentId, ctx.locationId);
  const when = formatWhen(row.starts_at, row.timezone, "en-US");
  const subject = `Appointment ${args.event} · ${pickText(row.customer, "en", "Guest")} · ${when}`;
  const text = [
    subject,
    `Updated by: ${ctx.membershipId ? "Shop team" : "Customer"}`,
    `Guests: ${row.party_size}`,
    ...(args.oldStartsAt
      ? [
          `Previous time: ${formatWhen(args.oldStartsAt, row.timezone, "en-US")}`,
        ]
      : []),
    summary,
    ...(row.notes ? [`Notes: ${row.notes}`] : []),
    `Open appointment: ${link}`,
  ].join("\n\n");
  const profile = readPublicBookingProfile(row.settings);
  if (profile.shopNotifications.email && row.email) {
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
      values(${ctx.orgId},${ctx.locationId},'appointment_changed',${row.email},${subject},${renderTemplatedEmailHtml(text, { url: link, label: "Open appointment" })},${text},${`booking_shop:${args.occurrence}`},${args.appointmentId})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  if (
    profile.shopNotifications.sms &&
    row.phone &&
    (await tenDlcApproved(tx, ctx.locationId))
  ) {
    const body = withComplianceFooter(
      `${pickText(row.name, "en", "Shop")}: ${subject}. ${row.party_size} guests. ${link}`,
    );
    const suppressed = measure(body).encoding !== "GSM-7";
    await tx`insert into sms_outbox(org_id,location_id,kind,to_e164,from_e164,body,segments,entity_type,entity_id,status,last_error)
      values(${ctx.orgId},${ctx.locationId},'appointment_changed',${row.phone},${smsFrom()},${body},${segmentsOf(body)},${`booking_shop:${args.occurrence}`},${args.appointmentId},${suppressed ? "suppressed" : "pending"},${suppressed ? "non_gsm7_body" : null})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  const staff = await tx<
    { id: string; name: unknown; email: string | null; phone: string | null }[]
  >`
    select distinct sp.membership_id as id,sp.display_name as name,sp.contact_email as email,coalesce(sp.phone_e164,u.phone) as phone
    from staff_profiles sp join memberships m on m.id=sp.membership_id and m.status='active'
    left join users u on u.id=m.user_id where sp.location_id=${ctx.locationId}
      and (sp.membership_id in (select membership_id from appointment_items where appointment_id=${args.appointmentId})
        or sp.membership_id=any(${args.previousStaffIds ?? []}))`;
  for (const person of staff) {
    await notifyEvent(tx, ctx, {
      event:
        args.event === "created"
          ? "staff_assigned"
          : args.event === "cancelled"
            ? "staff_cancelled"
            : "staff_changed",
      entityType: `appointment_staff:${args.occurrence}:${person.id}`,
      entityId: args.appointmentId,
      toEmail: person.email,
      toPhone: person.phone,
      locale: "en",
      emailDetails: text,
      vars: {
        staff_name: pickText(person.name, "en", ""),
        customer_name: pickText(row.customer, "en", "Guest"),
        service_name: `${row.party_size} guest appointment`,
        when,
        old_when: args.oldStartsAt
          ? formatWhen(args.oldStartsAt, row.timezone, "en-US")
          : "",
        confirm_url: link,
      },
    });
  }
}
