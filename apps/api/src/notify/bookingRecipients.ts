import { loadBookingSmsServices, renderSmsServices } from './bookingSmsDetails';
import { ownerLocaleOf } from '../email/locale';
import { notificationCopy } from './copy';
import { shopCompactWhen, shopBookingSms } from "../sms/booking";
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
import { segmentsOf } from "../sms/segments";

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
      default_locale: string | null;
      name: unknown;
      email: string | null;
      phone: string | null;
      settings: Record<string, unknown>;
      timezone: string;
      starts_at: string;
      customer: unknown;
      customer_phone: string | null;
      party_size: number;
      notes: string | null;
      staff_link_code: string;
      owner_email: string | null;
      preferred_staff: unknown;
    }[]
  >`
    select o.default_locale,l.name,l.email,l.phone,l.settings,l.timezone,a.starts_at::text,c.display_name as customer,c.phone_e164 as customer_phone,a.party_size,a.notes,a.staff_link_code,
      coalesce((select u.email from memberships m join users u on u.id=m.user_id join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=l.id and m.status='active' and r.key='owner' order by m.id limit 1),(select u.email from organizations o join users u on u.id=o.owner_user_id where o.id=l.org_id)) as owner_email,
      (select sp.display_name from appointment_items ai join staff_profiles sp on sp.membership_id=ai.membership_id where ai.appointment_id=a.id and ai.is_request order by ai.seq limit 1) as preferred_staff
    from appointments a join locations l on l.id=a.location_id join organizations o on o.id=l.org_id left join customers c on c.id=a.customer_id
    where a.id=${args.appointmentId} and a.location_id=${ctx.locationId}`;
  if (!row) return;
  const locale = ownerLocaleOf(row.default_locale), c = notificationCopy(locale);
  const summary = await bookingSummary(tx, ctx.locationId, args.appointmentId, {
    includePrices: false, locale,
  });
  const smsServices=await loadBookingSmsServices(tx,ctx.locationId,args.appointmentId);
  const servicesText=renderSmsServices(smsServices.rows,smsServices.addons,locale,row.party_size);
  const link = staffBookingShortUrl(row.staff_link_code);
  const when = formatWhen(row.starts_at, row.timezone, locale);
  const subject = `${c[args.event]} · ${pickText(row.customer, locale, c.guest)} · ${when}`;
  const text = [
    subject,
    `${c.updatedBy}: ${ctx.membershipId ? c.team : c.customer}`,
    `${c.guests}: ${row.party_size}`,
    ...(args.oldStartsAt
      ? [
          `${c.previous}: ${formatWhen(args.oldStartsAt, row.timezone, locale)}`,
        ]
      : []),
    summary,
    ...(row.notes ? [`${c.notes}: ${row.notes}`] : []),
    `${c.open}: ${link}`,
  ].join("\n\n");
  const profile = readPublicBookingProfile(row.settings);
  const targets = voiceNotificationTargets(row.settings, {
    email: row.email || row.owner_email,
    phone: row.phone,
  });
  if (profile.shopNotifications.email && targets.email) {
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
      values(${ctx.orgId},${ctx.locationId},'appointment_changed',${targets.email},${subject},${renderTemplatedEmailHtml(text, { url: link, label: c.open }, { locale })},${text},${`booking_shop:${args.occurrence}`},${args.appointmentId})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  if (profile.shopNotifications.sms && targets.phone) {
    const body = shopBookingSms({
      event: args.event,
      customer: pickText(row.customer, locale, c.guest),
      phone: row.customer_phone,
      services: servicesText,
      when: shopCompactWhen(row.starts_at, row.timezone, locale),
      oldWhen: args.oldStartsAt
        ? shopCompactWhen(args.oldStartsAt, row.timezone, locale)
        : undefined,
      guests: row.party_size,
      preferredStaff: row.preferred_staff
        ? pickText(row.preferred_staff, locale, "")
        : undefined,
      locale,
    });
    await tx`insert into sms_outbox(org_id,location_id,kind,to_e164,from_e164,body,segments,entity_type,entity_id,status,last_error)
      values(${ctx.orgId},${ctx.locationId},'appointment_changed',${targets.phone},${smsFrom()},${body},${segmentsOf(body)},${`booking_shop:${args.occurrence}`},${args.appointmentId},'pending',null)
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
      locale,
      emailDetails: text,
      vars: {
        staff_name: pickText(person.name, locale, ""),
        customer_name: pickText(row.customer, locale, c.guest),
        service_name: `${c.guests}: ${row.party_size}`,
        when,
        sms_when: shopCompactWhen(row.starts_at, row.timezone, locale),
        sms_old_when: args.oldStartsAt ? shopCompactWhen(args.oldStartsAt, row.timezone, locale) : "",
        customer_phone: row.customer_phone,
        sms_services: renderSmsServices(smsServices.rows,smsServices.addons,locale,row.party_size,person.id) || servicesText,
        old_when: args.oldStartsAt
          ? formatWhen(args.oldStartsAt, row.timezone, locale)
          : "",
        confirm_url: link,
      },
    });
  }
}
