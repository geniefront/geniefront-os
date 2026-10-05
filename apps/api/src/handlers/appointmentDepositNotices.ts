import {randomUUID} from 'node:crypto';
import {AppError,ERROR_CODES,CommerceSendDepositNotice,depositText,depositAdjustmentText,pickText} from '@gf/contracts';
import {registerHandler} from '../bus';
import type {Tx,Ctx} from '../commerce/model';
import {guestManageLink} from '../notify/manageUrl';
import {escapeHtml,emailButton,wrapEmailHtml} from '../email/layout';

/** A payment request uses the existing protected booking link and outbox, never a confirmation. */
export async function queuePendingDepositNotice(tx:Tx,ctx:Ctx,holdId:string,resend=false,oldStartsAt?:string){
  const [h]=await tx<{appointment_id:string;amount_cents:number;currency:string;expires_at:string;policy_snapshot:Record<string,unknown>;
    starts_at:string;has_confirmed_booking:boolean;service_total_cents:number;email:string|null;locale:string|null;slug:string;name:unknown;timezone:string;order_id:string|null;wrapped:Buffer|null;digest:string|null}[]>`
    select h.appointment_id,coalesce(o.amount_cents,h.amount_cents) as amount_cents,h.currency,coalesce(r.expires_at,h.expires_at)::text as expires_at,
      coalesce(o.snapshot->'depositPolicy',h.policy_snapshot) as policy_snapshot,r.order_id,h.has_confirmed_booking,
      coalesce((o.snapshot->>'serviceTotalCents')::int,h.service_total_cents) as service_total_cents,c.email,c.locale,
      l.slug,l.name,l.timezone,a.starts_at::text,a.manage_token_wrapped as wrapped,a.manage_token_digest as digest
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id join locations l on l.id=h.location_id
    left join commerce_deposit_requests r on r.hold_id=h.id and r.state='open' left join commerce_orders o on o.id=r.order_id
    left join customers c on c.id=a.customer_id where h.id=${holdId} and h.location_id=${ctx.locationId}
      and h.waived_at is null and not h.commerce_frozen and a.status in('booked','checked_in','in_service')
      and ((r.order_id is not null and r.expires_at>now()) or (r.order_id is null and h.status='pending' and h.expires_at>now()))`;
  if(!h)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_hold_not_payable'}});
  if(!h.email)return {queued:false,reason:'customer_email_required'};
  const link=guestManageLink({shopSlug:h.slug,wrapped:h.wrapped,digest:h.digest});
  if(!link)return {queued:false,reason:'deposit_manage_link_unavailable'};
  const locale:Ctx['locale']=['en','zh-Hans','zh-Hant','ko','vi','es'].includes(h.locale??'')?h.locale as Ctx['locale']:ctx.locale;
  const t=(key:Parameters<typeof depositText>[1])=>depositText(locale,key);
  const total=new Intl.NumberFormat(locale,{style:'currency',currency:h.currency.toUpperCase()}).format(h.amount_cents/100);
  const expires=new Intl.DateTimeFormat(locale,{timeZone:h.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(h.expires_at));
  const schedule=new Intl.DateTimeFormat(locale,{timeZone:h.timezone,dateStyle:'medium',timeStyle:'short'});
  const adjusted=(key:Parameters<typeof depositAdjustmentText>[1])=>depositAdjustmentText(locale,key);
  const parts=[h.has_confirmed_booking?adjusted('supplementTitle'):oldStartsAt?t('pendingRescheduled'):t('pending'),
    `${t('appointmentTime')}: ${schedule.format(new Date(h.starts_at))}`,
    oldStartsAt?`${t('previousAppointmentTime')}: ${schedule.format(new Date(oldStartsAt))}`:'',h.has_confirmed_booking?adjusted('supplementNotice'):h.order_id?t('pendingNotice'):t('pendingContact'),
    `${adjusted('serviceTotal')}: ${new Intl.NumberFormat(locale,{style:'currency',currency:h.currency.toUpperCase()}).format(h.service_total_cents/100)}`,`${t('required')}: ${total}`,`${t('expires')}: ${expires}`,
    t('refundBefore').replace('{hours}',String(h.policy_snapshot.cancelCutoffHours)),t(h.policy_snapshot.retainAfterCutoff===true?'lateRetain':'lateReview'),
    String(h.policy_snapshot.cancellationPolicyNotice??'')].filter(Boolean);
  const heading=`${h.has_confirmed_booking?adjusted('supplementTitle'):t('pending')} · ${pickText(h.name,locale)}`;
  const html=wrapEmailHtml(parts.map(p=>`<p>${escapeHtml(p)}</p>`).join('')+emailButton(link,t('manageDeposit')),{variant:'customer',locale});
  await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
    values(${ctx.orgId},${ctx.locationId},'appointment_deposit_pending',${h.email},${heading},${html},${parts.concat(link).join('\n')},
      ${resend?`appointment_deposit_pending:${randomUUID()}`:'appointment_deposit_pending'},${h.appointment_id},${h.order_id})
    on conflict(entity_type,entity_id,kind) do nothing`;
  return {queued:true,reason:null};
}
registerHandler(CommerceSendDepositNotice,async({input,ctx,tx,audit})=>{
  if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  const result=await queuePendingDepositNotice(tx,ctx,input.holdId,true);
  if(!result.queued)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:result.reason}});
  audit({entityType:'appointment_deposit_hold',entityId:input.holdId,after:{paymentNoticeQueued:true,reason:input.reason}});
  return {queued:true};
});

/** A supplementary receipt acknowledges only the additional cash, without creating a second booking confirmation. */
export async function queueAdditionalDepositReceipt(tx:Tx,ctx:Ctx,holdId:string,orderId:string){
 const [data]=await tx<{appointment_id:string;amount_cents:number;currency:string;email:string|null;locale:string|null;slug:string;wrapped:Buffer|null;digest:string|null}[]>`
  select h.appointment_id,o.amount_cents,o.currency,c.email,c.locale,l.slug,a.manage_token_wrapped as wrapped,a.manage_token_digest as digest
  from commerce_appointment_holds h join commerce_deposit_requests r on r.hold_id=h.id join commerce_orders o on o.id=r.order_id
   join appointments a on a.id=h.appointment_id join locations l on l.id=h.location_id left join customers c on c.id=a.customer_id
  where h.id=${holdId} and r.order_id=${orderId} and r.state='paid' and r.purpose='supplement'`;
 if(!data?.email)return;
 const locale:Ctx['locale']=['en','zh-Hans','zh-Hant','ko','vi','es'].includes(data.locale??'')?data.locale as Ctx['locale']:ctx.locale;
 const heading=depositAdjustmentText(locale,'supplementPaid'),amount=new Intl.NumberFormat(locale,{style:'currency',currency:data.currency.toUpperCase()}).format(data.amount_cents/100);
 const text=`${heading}: ${amount}`,url=guestManageLink({shopSlug:data.slug,wrapped:data.wrapped,digest:data.digest});
 await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
  values(${ctx.orgId},${ctx.locationId},'platform_notice',${data.email},${heading},
   ${wrapEmailHtml(`<p>${escapeHtml(text)}</p>`+(url?emailButton(url,depositText(locale,'manageDeposit')):''),{variant:'customer',locale})},
   ${text+(url?'\n'+url:'')},${`appointment_deposit_additional_paid:${orderId}`},${data.appointment_id},${orderId}) on conflict(entity_type,entity_id,kind) do nothing`;
}
