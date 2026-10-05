import {AppError,ERROR_CODES,CommerceRequoteAppointmentDeposit,CommerceExpireDepositRequest,CommerceRefundExcessDeposit,type depositAdjustmentConsent} from '@gf/contracts';
import {jsonb} from '@gf/db';
import type {z} from 'zod';
import {registerHandler,type HandlerArgs} from '../bus';
import {lockBookingCapacity,confirmPaidDepositBooking} from './appointment';
import {queueTask,requestRefundInTransaction} from './commerce';
import {queuePendingDepositNotice} from './appointmentDepositNotices';
import {loadDepositAdjustmentQuote,depositAdjustmentInvalid as invalid} from '../commerce/depositAdjustmentQuote';
import {allocateDepositSources} from '../commerce/depositSources';
import {assertCommerceEnabled,commerceLiveMode} from '../commerce/config';
import type {PurchaseSnapshot,Tx,Ctx} from '../commerce/model';

/** Stop unpaid requests under the appointment capacity lock. Late successful charges remain recoverable by their original request. */
export async function closeDepositRequests(tx:Tx,ctx:Ctx,holdId:string,state:'expired'|'superseded'|'cancelled'){
 const requests=await tx<{order_id:string;provider:string}[]>`select r.order_id,p.provider from commerce_deposit_requests r
  join commerce_orders o on o.id=r.order_id join commerce_payments p on p.order_id=r.order_id
  where r.hold_id=${holdId} and r.state in('open','expired') and o.asset_id is null order by r.order_id for update of r`;
 for(const request of requests){
  await tx`update commerce_deposit_requests set state=${state} where order_id=${request.order_id}`;
  await tx`update commerce_orders set status='canceled',updated_at=now() where id=${request.order_id} and status='pending'`;
  await tx`update commerce_payments set status='failed' where order_id=${request.order_id} and status='pending'`;
  if(request.provider==='stripe')await queueTask(tx,ctx,'expire_checkout',request.order_id);
 }
 return requests;
}

export async function requoteAppointmentDeposit(args:HandlerArgs<unknown>,holdId:string,consent:z.infer<typeof depositAdjustmentConsent>|undefined,
 options:{channel?:'online'|'offline'|undefined;reason?:string|undefined}={}){
 const {tx,ctx,audit,emit}=args;
 await lockBookingCapacity(tx,ctx.locationId);await tx`select id from commerce_appointment_holds where id=${holdId} for update`;
 const data=await loadDepositAdjustmentQuote(tx,ctx,holdId),{hold,quote,snapshot,guestAllocation,nextRevision}=data;
 if(hold.waived_at)return null;
 if(hold.store_currency.toLowerCase()!==hold.currency)invalid('deposit_currency_mismatch');
 if(!ctx.permissions.has('commerce.sell')&&!ctx.verifiedManagedBooking)throw new AppError(ERROR_CODES.PERMISSION_DENIED,{details:{need:'commerce.sell'}});
 if(hold.commerce_frozen||hold.reserved_cents>0)invalid('deposit_adjustment_requires_review');
 if(hold.ticket_exists||!['booked','checked_in'].includes(hold.appointment_status))invalid('appointment_not_editable');
 if(!hold.has_confirmed_booking&&(hold.due||hold.status!=='pending'))invalid('deposit_hold_not_payable');
 if(!snapshot.services.length)invalid('appointment_requires_service');
 if(!consent?.accepted||consent.quoteHash!==quote.quoteHash)invalid('deposit_quote_reconfirmation_required',{depositQuote:quote,notApplied:true});
 const [originalPayment]=await tx<{provider:string}[]>`select p.provider from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id
  where r.hold_id=${holdId} order by r.created_at desc,r.order_id desc limit 1`;
 const channel=options.channel??(originalPayment?.provider==='stripe'?'online':'offline');
 let account:{id:string;stripe_account_id:string}|undefined;
 if(quote.requestCents>0&&channel==='online'){
  assertCommerceEnabled();
  const [loc]=await tx<{settings:Record<string,unknown>}[]>`select settings from locations where id=${ctx.locationId}`;
  if(!(loc?.settings.commerce as {depositsEnabled?:boolean}|undefined)?.depositsEnabled)invalid('new_deposits_disabled');
  [account]=await tx<{id:string;stripe_account_id:string}[]>`select id,stripe_account_id from commerce_accounts where location_id=${ctx.locationId}
    and livemode=${commerceLiveMode()} and charges_enabled and not disconnected and capabilities->>'card_payments'='active'`;
  if(!account)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'merchant_payments_unavailable'}});
 }
 await closeDepositRequests(tx,ctx,hold.id,'superseded');
 const [clock]=await tx<{now:string;expires:string}[]>`select now()::text as now,(now()+interval '15 minutes')::text as expires`;
 const accepted={accepted:true,at:clock!.now,locale:ctx.locale,method:ctx.membershipId?'staff_confirmation':'customer_confirmation',reason:options.reason??'appointment_services_changed'};
 const [saved]=await tx<{id:string}[]>`insert into commerce_deposit_requotes(org_id,location_id,hold_id,revision,service_total_cents,required_cents,available_cents,request_cents,excess_cents,
   currency,policy_version,quote_hash,snapshot,consent,created_by)
  values(${ctx.orgId},${ctx.locationId},${hold.id},${nextRevision},${quote.serviceTotalCents},${quote.requiredCents},${quote.availableCents},${quote.requestCents},${quote.excessCents},
   ${hold.currency},${hold.policy_snapshot.version},${quote.quoteHash},${jsonb(snapshot)}::jsonb,${jsonb(accepted)}::jsonb,${ctx.membershipId}) returning id`;
 let orderId:string|null=null;
 if(quote.requestCents>0){
  const expires=hold.has_confirmed_booking?clock!.expires:hold.expires_at;
  const purchase:PurchaseSnapshot={version:1,kind:'deposit',name:hold.has_confirmed_booking?'Additional appointment deposit':'Updated appointment deposit',templateId:null,
   amountCents:quote.requestCents,currency:hold.currency,faceValueCents:0,sessions:0,serviceIds:[],scope:'location',validDays:null,coverageMode:'bundle',commissionBasis:'zero',
   recipientName:null,recipientNote:null,recipientEmail:null,consentVersion:hold.policy_snapshot.version,consentAt:clock!.now,depositHoldId:hold.id,depositQuoteId:saved!.id,
   appointmentId:hold.appointment_id,serviceTotalCents:quote.serviceTotalCents,depositPolicy:{...hold.policy_snapshot,guestAllocation,consent:accepted}};
  const [order]=await tx<{id:string}[]>`insert into commerce_orders(org_id,location_id,customer_id,account_id,kind,channel,status,amount_cents,currency,snapshot,idem_key,request_hash)
   values(${ctx.orgId},${ctx.locationId},${hold.customer_id},${account?.id??null},'deposit',${channel},'pending',${quote.requestCents},${hold.currency},${jsonb(purchase)}::jsonb,
    ${`deposit-requote:${saved!.id}`},${quote.quoteHash}) returning id`;
  orderId=order!.id;
  await tx`insert into commerce_payments(org_id,location_id,order_id,provider,method,amount_cents,currency,stripe_account_id,livemode)
   values(${ctx.orgId},${ctx.locationId},${orderId},${channel==='online'?'stripe':'offline'},${channel==='online'?'card':'external'},${quote.requestCents},${hold.currency},${account?.stripe_account_id??null},${channel==='online'&&commerceLiveMode()})`;
  await tx`insert into commerce_deposit_requests(order_id,org_id,location_id,hold_id,quote_id,purpose,expires_at)
   values(${orderId},${ctx.orgId},${ctx.locationId},${hold.id},${saved!.id},${hold.has_confirmed_booking?'supplement':'replacement'},${expires}::timestamptz)`;
  if(channel==='online'){await queueTask(tx,ctx,'checkout',orderId);await queueTask(tx,ctx,'reconcile',orderId,30);}
  await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at)
   values(${ctx.orgId},${ctx.locationId},'expire_deposit_request',${orderId},${expires}::timestamptz)`;
 }
 await tx`update email_outbox set status='failed',last_error='deposit_quote_changed'
  where entity_id=${hold.appointment_id} and kind='appointment_deposit_pending' and status='pending'`;
 if(orderId)await queuePendingDepositNotice(tx,ctx,hold.id,true);
 if(!hold.has_confirmed_booking&&quote.requiredCents===0){
  await tx`update commerce_appointment_holds set has_confirmed_booking=true,status='not_required',updated_at=now() where id=${hold.id}`;
  await tx`update appointments set deposit_status='not_required' where id=${hold.appointment_id}`;
  await confirmPaidDepositBooking(tx,ctx,hold.appointment_id);
 }
 const [appt]=await tx<{business_date:string}[]>`select business_date::text from appointments where id=${hold.appointment_id}`;
 audit({entityType:'appointment_deposit_requote',entityId:saved!.id,after:{holdId:hold.id,revision:nextRevision,serviceTotalCents:quote.serviceTotalCents,
  requiredCents:quote.requiredCents,requestCents:quote.requestCents,excessCents:quote.excessCents,orderId,reason:accepted.reason}});
 emit({type:'appointment.changed',entityId:hold.appointment_id,businessDate:appt!.business_date});
 return {quoteId:saved!.id,orderId,revision:nextRevision,requestCents:quote.requestCents,excessCents:quote.excessCents};
}
registerHandler(CommerceRequoteAppointmentDeposit,async args=>{
 const result=await requoteAppointmentDeposit(args,args.input.holdId,args.input.depositAdjustment,{channel:args.input.channel,reason:args.input.reason});
 if(!result)return invalid('deposit_is_waived');return result;
});
registerHandler(CommerceExpireDepositRequest,async({tx,ctx,input,audit})=>{
 await lockBookingCapacity(tx,ctx.locationId);
 const [request]=await tx<{hold_id:string;state:string;due:boolean;provider:string}[]>`select r.hold_id,r.state,r.expires_at<=now() as due,p.provider
  from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id where r.order_id=${input.orderId} and r.location_id=${ctx.locationId} for update of r`;
 if(!request)throw new AppError(ERROR_CODES.NOT_FOUND);
 const expired=request.state==='open'&&request.due;
 if(expired){
  await tx`update commerce_deposit_requests set state='expired' where order_id=${input.orderId}`;
  await tx`update commerce_orders set status='canceled',updated_at=now() where id=${input.orderId} and status='pending'`;
  await tx`update commerce_payments set status='failed' where order_id=${input.orderId} and status='pending'`;
  if(request.provider==='stripe')await queueTask(tx,ctx,'expire_checkout',input.orderId);
 }
 audit({entityType:'appointment_deposit_request',entityId:input.orderId,after:{expired}});return {expired};
});
registerHandler(CommerceRefundExcessDeposit,async args=>{
 const {tx,ctx,input}=args;await lockBookingCapacity(tx,ctx.locationId);await tx`select id from commerce_appointment_holds where id=${input.holdId} for update`;
 const {hold,quote,sources}=await loadDepositAdjustmentQuote(tx,ctx,input.holdId);
 if(hold.waived_at||hold.commerce_frozen||hold.ticket_exists)invalid('deposit_adjustment_requires_review');
 if(quote.quoteHash!==input.quoteHash||input.amountCents>quote.excessCents)invalid('deposit_excess_quote_changed',{depositQuote:quote,notApplied:true});
 const plan=allocateDepositSources([...sources].reverse(),input.amountCents),refunds=[];
 for(const part of plan){const result=await requestRefundInTransaction({...args,input:{paymentId:part.paymentId,amountCents:part.amountCents,reason:input.reason}});
  refunds.push({...result,amountCents:part.amountCents});}
 return {refunds};
});
