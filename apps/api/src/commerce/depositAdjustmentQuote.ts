import {createHash} from 'node:crypto';
import {AppError,ERROR_CODES,type DepositAdjustmentQuote} from '@gf/contracts';
import {allocateAppointmentDepositByGuest,allocateDepositRefundByGuest,quoteAppointmentDeposit,commerceFingerprint} from '@gf/payroll';
import {appointmentItemGuestIndices} from './depositGuests';
import {depositPaymentSources} from './depositSources';
import type {Tx,Ctx} from './model';
export const depositAdjustmentInvalid=(reason:string,details:Record<string,unknown>={}):never=>{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason,...details}});};
export async function loadDepositAdjustmentQuote(tx:Tx,ctx:Pick<Ctx,'locationId'>,holdId:string){
 const [hold]=await tx<{id:string;appointment_id:string;order_id:string|null;status:string;currency:string;service_total_cents:number;amount_cents:number;
  has_confirmed_booking:boolean;waived_at:string|null;commerce_frozen:boolean;reserved_cents:number;expires_at:string;due:boolean;
  policy_snapshot:{version:string;method:string;fixedAmountCents?:number;percentBps?:number;guestAllocation?:unknown};
  appointment_status:string;store_currency:string;party_size:number;original_size:number;customer_id:string|null;ticket_exists:boolean}[]>`
  select h.*,h.expires_at::text,h.expires_at<=now() as due,a.status as appointment_status,a.party_size,a.customer_id,l.currency as store_currency,
   coalesce((select max(original_party_size) from appointment_guest_cancellations where appointment_id=a.id),a.party_size)::int as original_size,
   exists(select 1 from tickets t where t.appointment_id=a.id and t.status<>'voided') as ticket_exists
  from commerce_appointment_holds h join appointments a on a.id=h.appointment_id join locations l on l.id=h.location_id where h.id=${holdId} and h.location_id=${ctx.locationId}`;
 if(!hold)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment_deposit_hold'}});
 const items=await tx<{service_id:string;starts_at:string;ends_at:string;price_cents_snapshot:number;details:Record<string,unknown>;
  seq:number;membership_id:string|null;resource_id:string|null;group_id:string;bundle_instance_id:string|null}[]>`
  select service_id,starts_at::text,ends_at::text,price_cents_snapshot,details,seq,coalesce(membership_id,reserved_membership_id) as membership_id,
   resource_id,coalesce(details->>'serviceExecutionGroup',id::text) as group_id,bundle_instance_id
  from appointment_items where appointment_id=${hold.appointment_id} and status<>'cancelled' order by seq,id`;
 if(hold.original_size>1&&items.some(i=>!appointmentItemGuestIndices(i.details)))return depositAdjustmentInvalid('deposit_guest_allocation_requires_review');
 const serviceTotalCents=items.reduce((n,i)=>n+i.price_cents_snapshot,0);
 let requiredCents:number;
 try{requiredCents=quoteAppointmentDeposit(serviceTotalCents,hold.policy_snapshot.method==='percentage'
  ?{percentBps:hold.policy_snapshot.percentBps!}:{fixedAmountCents:hold.policy_snapshot.fixedAmountCents!});}
 catch{return depositAdjustmentInvalid('invalid_deposit_policy');}
 const sources=await depositPaymentSources(tx,ctx,hold.id);
 const availableCents=sources.reduce((n,s)=>n+s.availableCents,0),requestCents=Math.max(0,requiredCents-availableCents),excessCents=Math.max(0,availableCents-requiredCents);
 const [latest]=await tx<{revision:number;service_total_cents:number}[]>`select revision,service_total_cents from commerce_deposit_requotes where hold_id=${hold.id} order by revision desc limit 1`;
 let allocation:ReturnType<typeof allocateAppointmentDepositByGuest>;
 try{allocation=allocateAppointmentDepositByGuest(hold.original_size,items.map(i=>({groupKey:i.group_id,priceCents:i.price_cents_snapshot,
  ...(appointmentItemGuestIndices(i.details)?{guestIndices:appointmentItemGuestIndices(i.details)!}:hold.original_size===1?{guestIndices:[0]}:{})})),requiredCents);}
 catch{return depositAdjustmentInvalid('deposit_guest_allocation_requires_review');}
 const current=allocation.guests.map(g=>({...g,paidCents:sources.filter(s=>s.requestState==='paid').reduce((n,s)=>n+(s.guests?.find(p=>p.guestIndex===g.guestIndex)?.availableCents??0),0)}));
 const shortfalls=current.map(g=>({guestIndex:g.guestIndex,amountCents:Math.max(0,g.amountCents-g.paidCents)}));
 const requested=requestCents?allocateDepositRefundByGuest(shortfalls,requestCents):[];
 const guestAllocation={method:allocation.method,guests:allocation.guests.map(g=>({...g,amountCents:requested.find(r=>r.guestIndex===g.guestIndex)?.amountCents??0}))};
 // New service row UUIDs differ after a rolled-back preview. Hash stable service content, never those temporary IDs.
 const snapshot={version:1,holdId:hold.id,previousRevision:latest?.revision??0,policy:hold.policy_snapshot,
  services:items.map(i=>({serviceId:i.service_id,startsAt:new Date(i.starts_at).toISOString(),endsAt:new Date(i.ends_at).toISOString(),priceCents:i.price_cents_snapshot,
   seq:i.seq,membershipId:i.membership_id,resourceId:i.resource_id,bundleId:i.bundle_instance_id,guestIndices:appointmentItemGuestIndices(i.details)??(hold.original_size===1?[0]:null)})),
  sources:sources.map(s=>({paymentId:s.paymentId,state:s.requestState,status:s.status,availableCents:s.availableCents,reservedCents:s.reservedCents,
   guests:s.guests?.map(g=>({guestIndex:g.guestIndex,availableCents:g.availableCents}))??null})),
  serviceTotalCents,requiredCents,availableCents,requestCents,excessCents,currency:hold.currency,guestAllocation};
 const quoteHash=createHash('sha256').update(commerceFingerprint(snapshot)).digest('hex');
 const quote:DepositAdjustmentQuote={quoteHash,currency:hold.currency.toUpperCase(),serviceTotalCents,requiredCents,availableCents,requestCents,excessCents,
  previousServiceTotalCents:latest?.service_total_cents??hold.service_total_cents,hasConfirmedBooking:hold.has_confirmed_booking,
  expiresAt:hold.has_confirmed_booking?null:new Date(hold.expires_at).toISOString(),purpose:requestCents?(hold.has_confirmed_booking?'supplement':'replacement'):'none'};
 return {hold,sources,quote,snapshot:{...snapshot,quoteHash},guestAllocation,nextRevision:(latest?.revision??0)+1};
}
