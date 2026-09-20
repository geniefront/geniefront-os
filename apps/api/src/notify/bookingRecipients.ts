import { compactWhen, shopBookingSms } from "../sms/booking";
import { voiceNotificationTargets } from "@gf/contracts";
import type postgres from "postgres";
import {
  pickText,
  readPublicBookingProfile,
  type CommandContext,
} from "@gf/contracts";
import { bookingSummary } from "./bookingSummary";
import { notifyEvent } from "./dispatch";
import { staffBookingShortUrl } from "../links";
import { renderTemplatedEmailHtml } from "../email/layout";
import { formatWhen } from "../email/render";
import { smsFrom } from "../sms/send";
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
      staff_link_code: string;
      owner_email: string | null;
      preferred_staff: unknown;
    }[]
  >`
    select l.name,l.email,l.phone,l.settings,l.timezone,a.starts_at::text,c.display_name as customer,a.party_size,a.notes,a.staff_link_code,
      coalesce((select u.email from memberships m join users u on u.id=m.user_id join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=l.id and m.status='active' and r.key='owner' order by m.id limit 1),(select u.email from organizations o join users u on u.id=o.owner_user_id where o.id=l.org_id)) as owner_email,
      (select sp.display_name from appointment_items ai join staff_profiles sp on sp.membership_id=ai.membership_id where ai.appointment_id=a.id and ai.is_request order by ai.seq limit 1) as preferred_staff
    from appointments a join locations l on l.id=a.location_id left join customers c on c.id=a.customer_id
    where a.id=${args.appointmentId} and a.location_id=${ctx.locationId}`;
  if (!row) return;
  const summary = await bookingSummary(tx, ctx.locationId, args.appointmentId, {
    includePrices: false,
  });
  const link = staffBookingShortUrl(row.staff_link_code);
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
  const targets = voiceNotificationTargets(row.settings, {
    email: row.email || row.owner_email,
    phone: row.phone,
  });
  if (profile.shopNotifications.email && targets.email) {
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
      values(${ctx.orgId},${ctx.locationId},'appointment_changed',${targets.email},${subject},${renderTemplatedEmailHtml(text, { url: link, label: "Open appointment" })},${text},${`booking_shop:${args.occurrence}`},${args.appointmentId})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  if (profile.shopNotifications.sms && targets.phone) {
    const body = shopBookingSms({
      event: args.event,
      customer: pickText(row.customer, "en", "Guest"),
      when: compactWhen(row.starts_at, row.timezone),
      oldWhen: args.oldStartsAt
        ? compactWhen(args.oldStartsAt, row.timezone)
        : undefined,
      guests: row.party_size,
      preferredStaff: row.preferred_staff
        ? pickText(row.preferred_staff, "en", "")
        : undefined,
      link,
    });
    const suppressed = measure(body).encoding !== "GSM-7";
    await tx`insert into sms_outbox(org_id,location_id,kind,to_e164,from_e164,body,segments,entity_type,entity_id,status,last_error)
      values(${ctx.orgId},${ctx.locationId},'appointment_changed',${targets.phone},${smsFrom()},${body},${segmentsOf(body)},${`booking_shop:${args.occurrence}`},${args.appointmentId},${suppressed ? "suppressed" : "pending"},${suppressed ? "non_gsm7_body" : null})
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
      toEmail:
        profile.shopNotifications.email &&
        person.email?.toLowerCase() === targets.email?.toLowerCase()
          ? null
          : person.email,
      toPhone:
        profile.shopNotifications.sms && person.phone === targets.phone
          ? null
          : person.phone,
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
