/** Claim inside a short transaction; validate and deliver outside it. Unknown delivery is never retried blindly. */
import { randomUUID } from 'node:crypto';
import { withTenant, emailSuppressedSet, normalizeSuppressionEmail, type TenantContext } from '@gf/db';
import type { FastifyBaseLogger } from 'fastify';
import { sendEmail, emailConfigured, fromAddressFor } from './send';
import { emailProvider } from './provider';
import { validateEmail } from './validation';
import { resolveAppointmentSender } from './sender';
import { mailerooReferenceId } from './maileroo';

export async function flushEmails(tenant: TenantContext, log?: FastifyBaseLogger): Promise<void> {
  if (!emailConfigured()) return;
  try {
    for (let i = 0; i < 10; i++) {
      const claim = randomUUID();
      const [r] = await withTenant(tenant, tx => tx<{
        id: string; to_email: string; subject: string; body_html: string; body_text: string;
        attempts: number; kind: string; from_email: string | null; unsubscribe_url: string | null;
        entity_type: string;entity_id:string;commerce_order_id:string|null;
        commerce_gift_card_id:string|null;commerce_credential_version:number|null;
      }[]>`
        with candidate as (
          select id from email_outbox where location_id=${tenant.locationId} and status='pending'
          and attempts<3 and next_attempt_at<=now() order by created_at for update skip locked limit 1
        ) update email_outbox e set status='sending',claim_id=${claim},claimed_at=now(),attempts=attempts+1
          from candidate c where e.id=c.id returning e.*`);
      if (!r) break;
      if(r.kind==='appointment_deposit_pending'){
        const [current]=await withTenant(tenant,tx=>tx`select h.id from commerce_appointment_holds h join appointments a on a.id=h.appointment_id
          where a.id=${r.entity_id} and h.waived_at is null and not h.commerce_frozen and a.status in('booked','checked_in','in_service')
            and not exists(select 1 from tickets t where t.appointment_id=a.id and t.status<>'voided' and t.service_settled_at is not null)
            and ((${r.commerce_order_id}::uuid is not null and exists(select 1 from commerce_deposit_requests dr join commerce_orders o on o.id=dr.order_id
              where dr.hold_id=h.id and dr.order_id=${r.commerce_order_id}::uuid and dr.state='open' and dr.expires_at>now() and o.status='pending'))
              or (${r.commerce_order_id}::uuid is null and h.status='pending' and h.expires_at>now() and a.deposit_status='pending'
                and not exists(select 1 from commerce_deposit_requotes q where q.hold_id=h.id)))`);
        if(!current){await withTenant(tenant,tx=>tx`update email_outbox set status='failed',last_error='deposit_request_superseded',claim_id=null
          where id=${r.id} and claim_id=${claim}`);continue;}
      }
      if(r.commerce_gift_card_id){
        const [current]=await withTenant(tenant,tx=>tx`select id from gift_cards where id=${r.commerce_gift_card_id!}
          and credential_version=${r.commerce_credential_version!} and not credential_disabled and status in ('active','depleted')
          and (expires_at is null or expires_at>now())`);
        if(!current){await withTenant(tenant,tx=>tx`update email_outbox set status='failed',last_error='gift_credential_superseded',claim_id=null where id=${r.id} and claim_id=${claim}`);continue;}
      }
      if(r.kind==='appointment_reminder') {
        const [current]=await withTenant(tenant,tx=>tx`select id from email_outbox where id=${r.id}
          and claim_id=${claim} and entity_type not like '%:superseded:%'`);
        if(!current){
          await withTenant(tenant,tx=>tx`update email_outbox set status='failed',last_error='appointment_changed',claim_id=null
            where id=${r.id} and claim_id=${claim}`);
          continue;
        }
      }

      let result: Awaited<ReturnType<typeof sendEmail>>;
      let from = fromAddressFor({ kind: r.kind });
      let replyTo: string | null = null;
      if (r.unsubscribe_url || /^(birthday_|holiday_|winback_|ticket_review)/.test(r.entity_type)) {
        result = { ok: false, permanent: true, error: 'marketing_coming_soon' };
      } else {
        const suppressed = await emailSuppressedSet([r.to_email]);
        const [accountSuppression] = await withTenant(tenant, tx => tx`
          select email from email_account_suppressions where provider_account='main'
          and email=${normalizeSuppressionEmail(r.to_email)} and scope='all'`);
        if (suppressed.size || accountSuppression) {
          result = { ok: false, permanent: true, error: 'suppressed' };
        } else {
          const validation = emailProvider() === 'elasticemail'
            ? await validateEmail(r.to_email, tenant) : null;
          if (validation?.result === 'invalid') result = { ok: false, permanent: true, error: 'invalid_recipient' };
          else {
            const sender = await resolveAppointmentSender(tenant, r.kind);
            from = sender.from || from; replyTo = sender.replyTo;
            // Save the selected identity before network IO for audit/reconciliation.
            await withTenant(tenant, tx => tx`update email_outbox set from_email=${from ?? null},reply_to=${replyTo},provider=${emailProvider()},provider_account='main',
              provider_id=${emailProvider() === 'maileroo' ? mailerooReferenceId(r.id) : null} where id=${r.id} and claim_id=${claim}`);
            result = await sendEmail({ to:r.to_email, subject:r.subject, html:r.body_html,text:r.body_text,
              kind:r.kind,from:from ?? null,replyTo,outboxId:r.id,orgId:tenant.orgId,locationId:tenant.locationId ?? undefined });
          }
        }
      }
      const status = result.ok ? result.captured ? 'captured' : 'sent'
        : result.ambiguous ? 'uncertain' : result.permanent || r.attempts>=3 ? 'failed' : 'pending';
      await withTenant(tenant, tx => tx`
        update email_outbox set status=${status},last_error=${result.error ?? null},
        provider_id=coalesce(${result.providerId ?? null},provider_id),provider_transaction_id=${result.transactionId ?? null},
        sent_at=case when ${result.ok} then now() else sent_at end,
        next_attempt_at=now()+make_interval(secs=>${Math.min(3600,60 * 2 ** r.attempts)}),claim_id=null
        where id=${r.id} and claim_id=${claim}`);
      if (!result.ok) log?.warn({outboxId:r.id,status,error:result.error},'email delivery deferred or stopped');
    }
  } catch {
    // A crash after provider acceptance is uncertain; the service sweep quarantines expired claims.
    log?.warn('email flush interrupted; claim retained for reconciliation');
  }
}
