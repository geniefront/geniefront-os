import { ownerLocaleOf } from './locale';
import { notificationCopy } from '../notify/copy';
import { bookingSummary } from '../notify/bookingSummary';
import { formatWhen } from './render';
import { renderTemplatedEmailHtml } from './layout';
import { staffBookingShortUrl } from '../links';
/** Legacy copy switch now sends a localized shop receipt, independently of the customer email. */
import type postgres from 'postgres';
import { pickText, readPublicBookingProfile } from '@gf/contracts';

type Tx = postgres.TransactionSql;

export interface ShopCopyArgs {
  orgId: string;
  locationId: string;
  /** outbox 的 kind，与顾客那一封保持一致 */
  kind: string;
  /** 顾客那一封用的 entity_type。本函数会加 `_shop` 后缀 */
  entityType: string;
  entityId: string;
  subject: string;
  html: string;
  text: string;
  /** 顾客的收件地址，用于判重 */
  customerEmail: string;
}

/** 返回是否真的入队了一封抄送。 */
export async function enqueueShopCopy(tx: Tx, args: ShopCopyArgs): Promise<boolean> {
  const [loc] = await tx<{ email: string | null; copy: boolean; settings: Record<string,unknown>; default_locale: string | null; timezone: string }[]>`
    select l.email, l.settings, l.appointment_email_copy_to_shop as copy, o.default_locale, l.timezone
    from locations l join organizations o on o.id=l.org_id where l.id = ${args.locationId}`;

  // Dedicated shop notices replace legacy customer copies.
  if (loc && readPublicBookingProfile(loc.settings).shopNotifications.email) return false;
  const to = loc?.email?.trim();
  if (!loc?.copy || !to) return false;
  if (to.toLowerCase() === args.customerEmail.trim().toLowerCase()) return false;

  /*
   * ⚠️ 抄送**不带退订地址**：它不是商业邮件，收件人是门店自己，
   * 而且这封信的开关就在他自己的设置页里。
   */
  const [appointment] = await tx<{customer:unknown; starts_at:string; status:string; staff_link_code:string}[]>`
    select c.display_name as customer,a.starts_at::text,a.status,a.staff_link_code
    from appointments a left join customers c on c.id=a.customer_id
    where a.id=${args.entityId} and a.location_id=${args.locationId}`;
  if (!appointment) return false;
  const locale = ownerLocaleOf(loc.default_locale), c = notificationCopy(locale);
  const title = appointment.status === 'cancelled' ? c.cancelled
    : args.kind === 'appointment_confirm' ? c.created : args.kind === 'appointment_reminder' ? c.reminder : c.changed;
  const subject = `${title} · ${pickText(appointment.customer,locale,c.guest)} · ${formatWhen(appointment.starts_at,loc.timezone,locale)}`;
  const link = staffBookingShortUrl(appointment.staff_link_code);
  const text = [subject,await bookingSummary(tx,args.locationId,args.entityId,{locale,includePrices:false}),`${c.open}: ${link}`].join('\n\n');
  const html = renderTemplatedEmailHtml(text,{url:link,label:c.open},{locale});
  const inserted = await tx<{ id: string }[]>`
    insert into email_outbox
      (org_id, location_id, kind, to_email, subject, body_html, body_text,
       entity_type, entity_id)
    values (${args.orgId}, ${args.locationId}, ${args.kind}, ${to},
            ${subject}, ${html}, ${text},
            ${`${args.entityType}_shop`}, ${args.entityId})
    on conflict (entity_type, entity_id, kind) do nothing
    returning id`;

  return inserted.length > 0;
}
