import {randomUUID,createHash} from 'node:crypto';
import {AppError,ERROR_CODES,CommerceTerminateMembership,CommerceRefundMembership,CommerceCompleteMembershipTermination,membershipText,pickText,type CommandContext} from '@gf/contracts';
import {commerceFingerprint,parsePackageUnitRanges,packageRangeCount,packageRangeValue} from '@gf/payroll';
import {businessDateOf} from '@gf/scheduling';
import {jsonb} from '@gf/db';
import {registerHandler} from '../bus';
import {queueTask} from './commerce';
import {saveMembershipState,type PaidMembershipRow} from './customerMembership';
import type {Tx} from '../commerce/model';
import {escapeHtml} from '../email/layout';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
type Cycle={id:string;invoice_id:string;status:string;quantity:number;value_cents:number;available_units:string;starts_at:string;ends_at:string;current:boolean;available:number};
type Invoice={id:string;payment_id:string;order_id:string;amount_cents:number;currency:string;status:string;period_start:string;period_end:string;paid_at:string;reserved:number;refunded:number;held:number;risk:boolean;refundable:number;keep_current_refundable:number};
type Termination={id:string;membership_id:string;unused_benefits:'revoke_all'|'keep_current_paid';status:string;provider_canceled_at:string|null};
async function member(tx:Tx,id:string,lock=false){const rows=lock?await tx<PaidMembershipRow[]>`select * from customer_paid_memberships where id=${id} for update`:await tx<PaidMembershipRow[]>`select * from customer_paid_memberships where id=${id}`;
 const m=rows[0];if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);return m;}
async function date(tx:Tx,ctx:CommandContext){const [l]=await tx<{timezone:string;cutoff:string}[]>`select timezone,business_day_cutoff::text as cutoff from locations where id=${ctx.locationId}`;
 if(!l)throw new AppError(ERROR_CODES.NOT_FOUND);return businessDateOf(new Date(),l.timezone,l.cutoff);}
export async function membershipTerminationReview(tx:Tx,ctx:CommandContext,id:string,lock=false){
 const m=await member(tx,id,lock);
 const [termination]=await tx<Termination[]>`select * from customer_membership_terminations where membership_id=${m.id}`;
 const cycles=await tx<Cycle[]>`select id,invoice_id,status,quantity,value_cents,available_units::text,starts_at::text,ends_at::text,
  status='issued' and starts_at<=now() and ends_at>now() as current,
  (select coalesce(sum(upper(r)-lower(r)),0)::int from unnest(c.available_units)r) as available
  from customer_membership_cycles c where membership_id=${m.id} order by starts_at,id`;
 const invoices=await tx<Invoice[]>`select i.id,i.payment_id,i.order_id,p.amount_cents,p.currency,p.status,i.period_start::text,i.period_end::text,i.paid_at::text,
  (select coalesce(sum(r.amount_cents),0)::int from commerce_refunds r where r.payment_id=p.id and r.status in('pending','succeeded','review')) as reserved,
  (select coalesce(sum(r.amount_cents),0)::int from commerce_refunds r where r.payment_id=p.id and r.status='succeeded') as refunded,
  case when ${termination?.unused_benefits??'revoke_all'}='keep_current_paid' then
   (select coalesce(sum(c.value_cents),0)::int from customer_membership_termination_cycles d join customer_membership_cycles c on c.id=d.cycle_id
    where d.termination_id=${termination?.id??null}::uuid and not d.stop_benefits and c.invoice_id=i.id and c.ends_at>now()) else 0 end as held,
  exists(select 1 from commerce_review_items r where r.payment_id=p.id and r.status in('open','lost','review')) as risk,
  0 as refundable,0 as keep_current_refundable from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=${m.id} order by i.period_start,i.id`;
 for(const invoice of invoices){
  invoice.refundable=invoice.status==='paid'&&!invoice.risk?Math.max(0,invoice.amount_cents-invoice.reserved-invoice.held):0;
  const currentValue=termination?invoice.held:cycles.filter(c=>c.invoice_id===invoice.id&&c.current).reduce((sum,c)=>sum+c.value_cents,0);
  invoice.keep_current_refundable=invoice.status==='paid'&&!invoice.risk?Math.max(0,invoice.amount_cents-invoice.reserved-currentValue):0;
 }
 const ledger=await tx<{redeemed:number;restored:number}[]>`select -coalesce(sum(l.quantity) filter(where entry='redeem'),0)::int as redeemed,
  coalesce(sum(l.quantity) filter(where entry='restore'),0)::int as restored from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${m.id}`;
 const requests=await tx`select r.id,r.amount_cents,r.status,r.created_at from commerce_refunds r join customer_membership_refund_requests q on q.id=r.membership_refund_request_id
  where q.membership_id=${m.id} order by r.created_at,r.id`;
 const snapshot={membershipId:m.id,providerStatus:m.provider_status,frozen:m.commerce_frozen,terminatedAt:m.terminated_at,terminationId:termination?.id??null,terminationStatus:termination?.status??null,
  cycles,invoices,redeemed:ledger[0]!.redeemed,restored:ledger[0]!.restored};
 return {m,termination,cycles,invoices,requests,snapshot,reviewHash:createHash('sha256').update(commerceFingerprint(snapshot)).digest('hex'),
  summary:{paidCents:invoices.reduce((s,i)=>s+i.amount_cents,0),refundedCents:invoices.reduce((s,i)=>s+i.refunded,0),reservedCents:invoices.reduce((s,i)=>s+i.reserved-i.refunded,0),
   currentAvailable:cycles.filter(c=>c.current).reduce((s,c)=>s+c.available,0),futurePlanned:cycles.filter(c=>c.status==='planned').reduce((s,c)=>s+c.quantity,0),
   usedServices:Math.max(0,ledger[0]!.redeemed-ledger[0]!.restored)}};
}
async function refundRequest(tx:Tx,ctx:CommandContext,review:Awaited<ReturnType<typeof membershipTerminationReview>>,termination:Termination,
 refunds:readonly {invoiceId:string;amountCents:number}[],reason:string,businessDate:string,queue:boolean){
 if(new Set(refunds.map(r=>r.invoiceId)).size!==refunds.length)invalid('duplicate_membership_refund_invoice');
 for(const r of refunds){const i=review.invoices.find(i=>i.id===r.invoiceId);
  const held=termination.unused_benefits==='keep_current_paid'&&!review.termination
   ?review.cycles.filter(c=>c.invoice_id===i?.id&&c.current).reduce((s,c)=>s+c.value_cents,0):i?.held??0;
  if(!i||i.status!=='paid'||i.risk||r.amountCents>i.amount_cents-i.reserved-held)invalid('membership_refund_exceeds_original_payment');
 }
 if(!refunds.length)return {requestId:null,refundIds:[]};
 const [request]=await tx<{id:string}[]>`insert into customer_membership_refund_requests(org_id,location_id,membership_id,termination_id,reason,review_snapshot,requested_by,business_date)
  values(${ctx.orgId},${ctx.locationId},${review.m.id},${termination.id},${reason},${jsonb(review.snapshot)}::jsonb,${ctx.membershipId},${businessDate}) returning id`;
 const ids=[];
 for(const r of [...refunds].sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId))){const i=review.invoices.find(i=>i.id===r.invoiceId)!;
  await tx`select id from commerce_orders where id=${i.order_id} for update`;await tx`select id from commerce_payments where id=${i.payment_id} for update`;
  const [refund]=await tx<{id:string}[]>`insert into commerce_refunds(org_id,location_id,payment_id,amount_cents,asset_quantity,reason,recorded_by,membership_refund_request_id)
   values(${ctx.orgId},${ctx.locationId},${i.payment_id},${r.amountCents},0,${reason},${ctx.membershipId},${request!.id}) returning id`;
  ids.push(refund!.id);if(queue)await queueTask(tx,ctx,'refund',refund!.id);
 }return {requestId:request!.id,refundIds:ids};
}
/** Late paid invoices remain cash history; a confirmed termination stops any newly discovered cycles. */
export async function stopMembershipCycles(tx:Tx,ctx:CommandContext,m:PaidMembershipRow){
 const [t]=await tx<Termination[]>`select * from customer_membership_terminations where membership_id=${m.id}`;
 if(!t||t.status==='pending')return 0;
 const cycles=await tx<(Cycle&{stop_benefits:boolean|null})[]>`select c.*,d.stop_benefits from customer_membership_cycles c
  left join customer_membership_termination_cycles d on d.cycle_id=c.id where c.membership_id=${m.id} and c.status in('planned','issued') order by c.starts_at,c.id for update of c`;
 const day=await date(tx,ctx);let stopped=0;
 for(const c of cycles){
  if(c.stop_benefits===false)continue;
  if(c.stop_benefits===null)await tx`insert into customer_membership_termination_cycles(org_id,location_id,termination_id,cycle_id,stop_benefits,reviewed_state)
   values(${ctx.orgId},${ctx.locationId},${t.id},${c.id},true,${jsonb({latePaidCycle:true,status:c.status})}::jsonb)`;
  const units=parsePackageUnitRanges(c.available_units,c.quantity),quantity=packageRangeCount(units),value=packageRangeValue(c.value_cents,c.quantity,units),planned=c.status==='planned';
  await tx`insert into customer_membership_ledger(org_id,location_id,cycle_id,entry,quantity,value_cents,unit_ranges,reference,business_date,termination_id,meta)
   values(${ctx.orgId},${ctx.locationId},${c.id},${planned?'stop':'revoke'},${planned?0:-quantity},${planned?0:-value},${planned?'{}':c.available_units}::int4multirange,
    ${`terminate:${t.id}:${c.id}`},${day},${t.id},${jsonb({plannedQuantity:c.quantity,neverIssued:planned})}::jsonb)`;
  await tx`update customer_membership_cycles set status='stopped',available_units='{}'::int4multirange where id=${c.id}`;stopped++;
 }return stopped;
}
export async function syncMembershipTermination(tx:Tx,terminationId:string){
 const [counts]=await tx<{pending:boolean;failed:boolean}[]>`select coalesce(bool_or(r.status in('pending','review')),false) as pending,coalesce(bool_or(r.status='failed'),false) as failed
  from commerce_refunds r join customer_membership_refund_requests q on q.id=r.membership_refund_request_id where q.termination_id=${terminationId}`;
 await tx`update customer_membership_terminations set status=${counts!.failed?'review':counts!.pending?'provider_canceled':'complete'},updated_at=now()
  where id=${terminationId} and status<>'pending'`;
}
async function queueMembershipReconciliation(tx:Tx,ctx:CommandContext,orderId:string){
 await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at) values(${ctx.orgId},${ctx.locationId},'reconcile',${orderId},now())
  on conflict(kind,subject_id) do update set status=case when commerce_tasks.status='processing' then 'processing' else 'pending' end,retry_at=least(commerce_tasks.retry_at,excluded.retry_at),attempts=0`;
}
registerHandler(CommerceTerminateMembership,async({tx,ctx,input,audit})=>{
 if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
 const review=await membershipTerminationReview(tx,ctx,input.membershipId,true);
 if(review.termination)invalid('membership_termination_already_requested');
 if(!review.m.stripe_subscription_id||!review.invoices.length)invalid('membership_termination_requires_paid_subscription');
 if(review.reviewHash!==input.expectedReviewHash)invalid('membership_termination_review_changed');
 const day=await date(tx,ctx),id=randomUUID();
 await tx`insert into customer_membership_terminations(id,org_id,location_id,membership_id,unused_benefits,reason,requested_by,business_date,review_snapshot)
  values(${id},${ctx.orgId},${ctx.locationId},${review.m.id},${input.unusedBenefits},${input.reason},${ctx.membershipId},${day},${jsonb(review.snapshot)}::jsonb)`;
 for(const c of review.cycles)await tx`insert into customer_membership_termination_cycles(org_id,location_id,termination_id,cycle_id,stop_benefits,reviewed_state)
  values(${ctx.orgId},${ctx.locationId},${id},${c.id},${input.unusedBenefits==='revoke_all'||!c.current},${jsonb(c)}::jsonb)`;
 await refundRequest(tx,ctx,review,{id,membership_id:review.m.id,unused_benefits:input.unusedBenefits,status:'pending',provider_canceled_at:null},input.refunds,input.reason,day,false);
 await tx`update customer_paid_memberships set commerce_frozen=true,termination_id=${id},updated_at=now() where id=${review.m.id}`;
 await queueTask(tx,ctx,'subscription_update',id);audit({entityType:'customer_paid_membership',entityId:review.m.id,after:{terminationRequested:true,unusedBenefits:input.unusedBenefits}});
 return {terminationId:id,status:'pending'};
});
registerHandler(CommerceRefundMembership,async({tx,ctx,input,audit})=>{
 if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
 const review=await membershipTerminationReview(tx,ctx,input.membershipId,true),t=review.termination;
 if(!t||t.id!==input.terminationId||t.status==='pending')invalid('membership_cancellation_not_confirmed');
 if(review.reviewHash!==input.expectedReviewHash)invalid('membership_termination_review_changed');
 const result=await refundRequest(tx,ctx,review,t,input.refunds,input.reason,await date(tx,ctx),true);
 await queueMembershipReconciliation(tx,ctx,review.m.original_order_id);
 await syncMembershipTermination(tx,t.id);audit({entityType:'customer_paid_membership',entityId:review.m.id,after:{refundRequested:true}});
 return {requestId:result.requestId!,refundIds:result.refundIds};
});
registerHandler(CommerceCompleteMembershipTermination,async({tx,ctx,input,audit})=>{
 const m=await member(tx,input.membershipId,true),[t]=await tx<Termination[]>`select * from customer_membership_terminations where id=${input.terminationId} and membership_id=${m.id} for update`;
 if(!t)throw new AppError(ERROR_CODES.NOT_FOUND);
 const saved=await saveMembershipState(tx,m,input);
 if(!saved&&m.provider_status!=='canceled')invalid('membership_cancellation_observation_stale');
 if(t.status==='pending'){
  await tx`update customer_membership_terminations set status='provider_canceled',provider_canceled_at=${input.providerCanceledAt}::timestamptz,updated_at=now() where id=${t.id}`;
  await stopMembershipCycles(tx,ctx,m);
  const [risk]=await tx<{frozen:boolean}[]>`select exists(select 1 from commerce_review_items r join customer_membership_invoices i on i.payment_id=r.payment_id
   where i.membership_id=${m.id} and r.status in('open','lost','review')) as frozen`;
  await tx`update customer_paid_memberships set commerce_frozen=${risk!.frozen},terminated_at=case when ${t.unused_benefits==='revoke_all'} then coalesce(terminated_at,now()) else terminated_at end,
   updated_at=now() where id=${m.id}`;
  const refunds=await tx<{id:string}[]>`select r.id from commerce_refunds r join customer_membership_refund_requests q on q.id=r.membership_refund_request_id where q.termination_id=${t.id} and r.status='pending'`;
  for(const r of refunds)await queueTask(tx,ctx,'refund',r.id);await syncMembershipTermination(tx,t.id);
  if(refunds.length)await queueMembershipReconciliation(tx,ctx,m.original_order_id);
  const [customer]=await tx<{email:string|null;locale:string|null}[]>`select email,locale from customers where id=${m.customer_id}`;
  if(customer?.email){const locale=customer.locale??'en',body=[pickText(m.snapshot.terms.name,locale),membershipText(locale,t.unused_benefits==='revoke_all'?'terminationRevoked':'terminationKept')].join('\n');
   await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
    values(${ctx.orgId},${ctx.locationId},'platform_notice',${customer.email},${membershipText(locale,'title')},${`<p>${escapeHtml(body)}</p>`},${body},
    'customer_membership_termination',${t.id},${m.original_order_id}) on conflict(entity_type,entity_id,kind) do nothing`;
  }
 }
 const [state]=await tx<{status:string}[]>`select status from customer_membership_terminations where id=${t.id}`;
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{providerCancellationVerified:true,terminationId:t.id}});return {terminationId:t.id,status:state!.status};
});
