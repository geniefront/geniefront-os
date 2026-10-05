import {AppError,ERROR_CODES,CommerceRetainAppointmentDeposit,CommerceReleaseDepositRetention,depositText,pickText,retentionReleaseText} from '@gf/contracts';
import {jsonb} from '@gf/db';
import {allocateDepositRefundByGuest} from '@gf/payroll';
import {registerHandler} from '../bus';
import {loadDepositRetentionQuote} from '../commerce/depositRetention';
import {lockBookingCapacity} from './appointment';
import {requestRefundInTransaction} from './commerce';
import {depositPaymentSources,allocateDepositSources} from '../commerce/depositSources';
import {guestManageLink} from '../notify/manageUrl';
import {escapeHtml,emailButton,wrapEmailHtml} from '../email/layout';
const invalid=(reason:string):never=>{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});};

registerHandler(CommerceReleaseDepositRetention,async(args)=>{
 const {tx,ctx,input,audit,emit}=args;
 if(!ctx.membershipId||!ctx.permissions.has('commerce.refund'))throw new AppError(ERROR_CODES.PERMISSION_DENIED);
 await lockBookingCapacity(tx,ctx.locationId);
 const [source]=await tx<{hold_id:string}[]>`select hold_id from commerce_deposit_retentions where id=${input.retentionId} and location_id=${ctx.locationId}`;
 if(!source)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [hold]=await tx<{appointment_id:string;commerce_frozen:boolean;waived_at:string|null;order_id:string;business_date:string}[]>`
  select h.*,a.business_date::text from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${source.hold_id} for update of h,a`;
 if(!hold||hold.commerce_frozen||hold.waived_at)return invalid('deposit_not_refundable');
 const [payment]=await tx<{id:string;status:string}[]>`select id,status from commerce_payments where id=(select payment_id from commerce_deposit_retentions where id=${input.retentionId}) for update`;
 if(!payment||payment.status!=='paid')return invalid('payment_not_refundable');
 const [original]=await tx<{id:string;amount_cents:number;guest_allocation:Array<{guestIndex:number;amountCents:number}>}[]>`
  select id,amount_cents,guest_allocation from commerce_deposit_retentions where id=${input.retentionId}`;
 const releases=await tx<{amount_cents:number;guest_allocation:Array<{guestIndex:number;amountCents:number}>}[]>`
  select amount_cents,guest_allocation from commerce_deposit_retention_releases where retention_id=${input.retentionId}`;
 const remaining=original!.amount_cents-releases.reduce((n,r)=>n+r.amount_cents,0);
 if(remaining!==input.expectedRemainingCents)invalid('deposit_retention_release_changed');
 if(input.amountCents>remaining)invalid('deposit_retention_release_exceeds_remaining');
 const balances=original!.guest_allocation.map(g=>({...g,amountCents:g.amountCents-releases.reduce((n,r)=>n+r.guest_allocation.filter(s=>s.guestIndex===g.guestIndex).reduce((sum,s)=>sum+s.amountCents,0),0)}));
 const allocation=allocateDepositRefundByGuest(balances,input.amountCents);
 const [release]=await tx<{id:string}[]>`insert into commerce_deposit_retention_releases(org_id,location_id,retention_id,hold_id,payment_id,amount_cents,guest_allocation,reason,recorded_by)
  values(${ctx.orgId},${ctx.locationId},${original!.id},${source.hold_id},${payment.id},${input.amountCents},${jsonb(allocation)}::jsonb,${input.reason},${ctx.membershipId}) returning id`;
 await tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,entry,amount_cents,reference,guest_allocation)
  values(${ctx.orgId},${ctx.locationId},${source.hold_id},${payment.id},'retention_released',${input.amountCents},${`release:${release!.id}`},${jsonb(allocation)}::jsonb)`;
 const refund=await requestRefundInTransaction({...args,input:{paymentId:payment.id,amountCents:input.amountCents,reason:input.reason,depositGuestIndices:allocation.map(g=>g.guestIndex)}},undefined,
  {retentionReleaseId:release!.id,depositGuestAllocation:allocation});
 await tx`update appointments set deposit_status='refund_pending' where id=${hold.appointment_id}`;
 const [customer]=await tx<{email:string|null;locale:string|null;currency:string}[]>`select c.email,c.locale,h.currency from commerce_appointment_holds h
  join appointments a on a.id=h.appointment_id left join customers c on c.id=a.customer_id where h.id=${source.hold_id}`;
 if(customer?.email){
  const locale=customer.locale??ctx.locale,heading=retentionReleaseText(locale,'pending'),money=new Intl.NumberFormat(locale,{style:'currency',currency:customer.currency}).format(input.amountCents/100);
  const body=`${heading}: ${money}\n${retentionReleaseText(locale,'notice')}`;
  await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
   values(${ctx.orgId},${ctx.locationId},'platform_notice',${customer.email},${heading},${wrapEmailHtml(`<p>${escapeHtml(body)}</p>`,{variant:'customer',locale:ctx.locale})},${body},'appointment_deposit_retention_release',${release!.id}) on conflict(entity_type,entity_id,kind) do nothing`;
 }
 audit({entityType:'appointment_deposit_retention_release',entityId:release!.id,after:{retentionId:original!.id,holdId:source.hold_id,amountCents:input.amountCents,guestAllocation:allocation,refundId:refund.refundId,reason:input.reason}});
 emit({type:'appointment.changed',entityId:hold.appointment_id,businessDate:hold.business_date});
 return {releaseId:release!.id,...refund,amountCents:input.amountCents};
});

registerHandler(CommerceRetainAppointmentDeposit,async(args)=>{
  const {input,ctx,tx,audit,emit}=args;
  if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  if(new Set(input.guestIndices).size!==input.guestIndices.length)invalid('invalid_retention_guests');
  await lockBookingCapacity(tx,ctx.locationId);
  const [h]=await tx<{id:string;order_id:string;appointment_id:string;reserved_cents:number;appointment_status:string;business_date:string}[]>`
    select h.*,a.status as appointment_status,a.business_date::text from commerce_appointment_holds h join appointments a on a.id=h.appointment_id
    where h.id=${input.holdId} and h.location_id=${ctx.locationId} for update of h,a`;
  if(!h)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'deposit_hold'}});
  const quote=await loadDepositRetentionQuote(tx,ctx,h.id);
  if(!quote.enabled)invalid(quote.reason!);
  if(input.guestIndices.some(i=>!quote.guests.some(g=>g.guestIndex===i)))invalid('deposit_retention_guest_not_eligible');
  const expected=input.expectedGuestBalances;
  if(expected.length!==input.guestIndices.length||new Set(expected.map(g=>g.guestIndex)).size!==expected.length
    ||expected.some(g=>!input.guestIndices.includes(g.guestIndex)||quote.guests.find(q=>q.guestIndex===g.guestIndex)?.availableCents!==g.availableCents))
    invalid('deposit_retention_quote_changed');
  const shares=(()=>{try{return allocateDepositRefundByGuest(quote.guests.map(g=>({guestIndex:g.guestIndex,amountCents:g.availableCents})),input.amountCents,input.guestIndices);}
    catch{return invalid('deposit_retention_exceeds_eligible_balance');}})();
  const reviews=await tx<{id:string;payment_id:string;amount_cents:number;guest_cancellation_id:string;deposit_guest_allocation:Array<{guestIndex:number;amountCents:number}>}[]>`
    select f.* from commerce_refunds f join commerce_payments p on p.id=f.payment_id join commerce_deposit_requests dr on dr.order_id=p.order_id
    where dr.hold_id=${h.id} and f.status='review' and f.review_required and f.approved_at is null and f.stripe_refund_id is null
    order by f.created_at,f.id for update of f`;
  const sourceBalances=(await depositPaymentSources(tx,ctx,h.id)).map(source=>{
    const pending=reviews.filter(r=>r.payment_id===source.paymentId);
    return {...source,availableCents:source.availableCents+pending.reduce((n,r)=>n+r.amount_cents,0),
      guests:source.guests?.map(g=>({...g,availableCents:g.availableCents+pending.reduce((n,r)=>n+r.deposit_guest_allocation.filter(s=>s.guestIndex===g.guestIndex).reduce((sum,s)=>sum+s.amountCents,0),0)}))??null};
  });
  const plan=allocateDepositSources(sourceBalances,input.amountCents,input.guestIndices,shares),retentions:Array<{id:string;amountCents:number;paymentId:string}>=[],declinedIds:string[]=[];
  let totalReleased=0;
  for(const part of plan){
    const affected=reviews.filter(r=>r.payment_id===part.paymentId&&r.deposit_guest_allocation?.some(s=>part.guestAllocation!.some(g=>g.guestIndex===s.guestIndex)));
    const [retention]=await tx<{id:string}[]>`insert into commerce_deposit_retentions(org_id,location_id,hold_id,payment_id,amount_cents,guest_allocation,policy_version,reason,recorded_by)
      values(${ctx.orgId},${ctx.locationId},${h.id},${part.paymentId},${part.amountCents},${jsonb(part.guestAllocation)}::jsonb,${quote.policyVersion!},${input.reason},${ctx.membershipId}) returning id`;
    retentions.push({id:retention!.id,amountCents:part.amountCents,paymentId:part.paymentId});
    let released=0;
    for(const r of affected){
      await tx`update commerce_refunds set status='declined',declined_at=now(),declined_by=${ctx.membershipId},decline_reason=${input.reason},retention_id=${retention!.id} where id=${r.id}`;
      released+=r.amount_cents;declinedIds.push(r.id);
    }
    totalReleased+=released;if(totalReleased>h.reserved_cents)invalid('deposit_retention_reservation_inconsistent');
    await tx`update commerce_appointment_holds set reserved_cents=reserved_cents-${released} where id=${h.id}`;
    await tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,entry,amount_cents,reference,guest_allocation)
      values(${ctx.orgId},${ctx.locationId},${h.id},${part.paymentId},'retained',${-part.amountCents},${`retain:${retention!.id}`},${jsonb(part.guestAllocation)}::jsonb)`;
    const unassigned=new Map(part.guestAllocation!.map(g=>[g.guestIndex,g.amountCents]));
    for(const r of affected){
      const remainder=r.deposit_guest_allocation.map(g=>{const retained=Math.min(g.amountCents,unassigned.get(g.guestIndex)??0);
        unassigned.set(g.guestIndex,(unassigned.get(g.guestIndex)??0)-retained);return {...g,amountCents:g.amountCents-retained};}).filter(g=>g.amountCents>0);
      if(remainder.length)await requestRefundInTransaction({...args,input:{paymentId:part.paymentId,amountCents:remainder.reduce((n,g)=>n+g.amountCents,0),
        depositGuestIndices:remainder.map(g=>g.guestIndex),reason:`Unretained remainder of reviewed refund ${r.id}`}},undefined,
        {guestCancellationId:r.guest_cancellation_id,requireReview:true});
    }
  }
  const retention=retentions[0]!;
  const [balance]=await tx<{balance:number;reserved:number}[]>`select reserved_cents as reserved,
    (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance from commerce_appointment_holds h where id=${h.id}`;
  if(balance!.balance<balance!.reserved)invalid('deposit_retention_reservation_inconsistent');
  const status=balance!.reserved>0?'refund_pending':['cancelled','no_show'].includes(h.appointment_status)?
    (balance!.balance===0?'retained':'review'):'paid';
  await tx`update commerce_appointment_holds set status=${status},updated_at=now() where id=${h.id}`;
  await tx`update appointments set deposit_status=${status} where id=${h.appointment_id}`;
  const [customer]=await tx<{email:string|null;locale:string|null;name:unknown;slug:string;currency:string;wrapped:Buffer|null;digest:string|null;policy:Record<string,unknown>}[]>`
    select c.email,c.locale,l.name,l.slug,h.currency,a.manage_token_wrapped as wrapped,a.manage_token_digest as digest,h.policy_snapshot as policy
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id join locations l on l.id=a.location_id
    left join customers c on c.id=a.customer_id where a.id=${h.appointment_id}`;
  if(customer?.email){
    const locale=['en','zh-Hans','zh-Hant','es','ko','vi'].includes(customer.locale??'')?customer.locale!:ctx.locale;
    const heading=`${depositText(locale,'retained')} · ${pickText(customer.name,locale)}`;
    const money=new Intl.NumberFormat(locale,{style:'currency',currency:customer.currency.toUpperCase()}).format(input.amountCents/100);
    const parts=[`${depositText(locale,'retained')}: ${money}`,depositText(locale,'refundBefore').replace('{hours}',String(customer.policy.cancelCutoffHours)),
      depositText(locale,'lateRetain'),String(customer.policy.cancellationPolicyNotice??'')].filter(Boolean);
    const url=guestManageLink({shopSlug:customer.slug,wrapped:customer.wrapped,digest:customer.digest});
    const html=wrapEmailHtml(parts.map(t=>`<p>${escapeHtml(t)}</p>`).join('')+(url?emailButton(url,depositText(locale,'manageDeposit')):''),
      {variant:'customer',locale:locale as typeof ctx.locale});
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
      values(${ctx.orgId},${ctx.locationId},'appointment_deposit_retained',${customer.email},${heading},${html},${parts.concat(url??'').join('\n')},
        'appointment_deposit_retention',${retention.id}) on conflict(entity_type,entity_id,kind) do nothing`;
  }
  audit({entityType:'appointment_deposit_retention',entityId:retention.id,after:{holdId:h.id,amountCents:input.amountCents,guestAllocation:shares,
    policyVersion:quote.policyVersion,reason:input.reason,declinedRefundIds:declinedIds,paymentSources:retentions}});
  emit({type:'appointment.changed',entityId:h.appointment_id,businessDate:h.business_date});
  return {retentionId:retention.id,...(retentions.length>1?{retentionIds:retentions.map(r=>r.id)}:{}),amountCents:input.amountCents,status};
});
