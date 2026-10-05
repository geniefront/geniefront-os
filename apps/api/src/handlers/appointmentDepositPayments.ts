import type {CheckoutPlanningBalances} from './checkoutPlanning';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {jsonb} from '@gf/db';
import {allocateDepositRefundByGuest} from '@gf/payroll';
import {depositPaymentSources,allocateDepositSources} from '../commerce/depositSources';
import {refreshDepositFinancialState} from './appointmentDepositState';
import {queueAdditionalDepositReceipt} from './appointmentDepositNotices';
import type {HandlerArgs} from '../bus';
import type {Tx,Ctx,OrderRow} from '../commerce/model';
import {lockBookingCapacity,confirmPaidDepositBooking,restoreDepositBookingCapacity} from './appointment';

export async function lockDepositOrder(tx:Tx,ctx:Ctx,orderId:string):Promise<void>{
  const [o]=await tx<{kind:string}[]>`select kind from commerce_orders where id=${orderId} and location_id=${ctx.locationId}`;
  if(o?.kind==='deposit')await lockBookingCapacity(tx,ctx.locationId);
}

/** A deposit is already-paid service money. It never discounts the commission base or becomes a new cash receipt. */
export async function applyDepositToTicket(tx:Tx,ctx:Ctx,input:{holdId:string;amountCents:number},ticket:{id:string;appointmentId:string|null},
  serviceDueCents:number,stage:'service'|'tip'|'combined',persist=true,balances?:CheckoutPlanningBalances):Promise<number>{
  if(stage==='tip'||input.amountCents>serviceDueCents)throw new AppError(ERROR_CODES.PAYMENT_MISMATCH,{details:{reason:'deposit_cannot_pay_tip_or_exceed_service_due'}});
  await lockBookingCapacity(tx,ctx.locationId);
  const [h]=await tx<{id:string;appointment_id:string;order_id:string;currency:string;status:string;reserved_cents:number;commerce_frozen:boolean;waived_at:string|null}[]>`
    select * from commerce_appointment_holds where id=${input.holdId} and location_id=${ctx.locationId} for update`;
  if(!h||!ticket.appointmentId||h.appointment_id!==ticket.appointmentId||h.commerce_frozen||h.waived_at||!['paid','refund_pending'].includes(h.status))
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_not_available_for_ticket'}});
  const [loc]=await tx<{currency:string}[]>`select currency from locations where id=${ctx.locationId}`;
  if(h.currency!==loc?.currency.toLowerCase())throw new AppError(ERROR_CODES.PAYMENT_MISMATCH,{details:{reason:'deposit_currency_mismatch'}});
  const sources=await depositPaymentSources(tx,ctx,h.id);
  const spent=balances?.depositPayments??new Map<string,number>();
  const guestSpent=balances?.depositPaymentGuests??new Map<string,Map<number,number>>();
  const plan=allocateDepositSources(sources.map(source=>({...source,availableCents:Math.max(0,source.availableCents-(spent.get(source.paymentId)??0)),
    guests:source.guests?.map(g=>({...g,availableCents:Math.max(0,g.availableCents-(guestSpent.get(source.paymentId)?.get(g.guestIndex)??0))}))??null})),input.amountCents);
  if(balances){balances.deposits.set(h.id,(balances.deposits.get(h.id)??0)+input.amountCents);
    for(const part of plan){spent.set(part.paymentId,(spent.get(part.paymentId)??0)+part.amountCents);const guests=guestSpent.get(part.paymentId)??new Map<number,number>();
      for(const share of part.guestAllocation??[])guests.set(share.guestIndex,(guests.get(share.guestIndex)??0)+share.amountCents);guestSpent.set(part.paymentId,guests);}}
  if(persist)for(const part of plan){
    await tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,ticket_id,entry,amount_cents,reference,guest_allocation)
      values(${ctx.orgId},${ctx.locationId},${h.id},${part.paymentId},${ticket.id},'applied',${-part.amountCents},${`apply:${ticket.id}:${stage}:${part.paymentId}`},${part.guestAllocation?jsonb(part.guestAllocation):null}::jsonb)`;
    await tx`insert into payments(org_id,location_id,ticket_id,method,amount_cents,tip_cents,taken_by,stage,deposit_hold_id,deposit_commerce_payment_id)
      values(${ctx.orgId},${ctx.locationId},${ticket.id},'deposit',${part.amountCents},0,${ctx.membershipId},${stage},${h.id},${part.paymentId})`;
  }
  return input.amountCents;
}

export async function restoreTicketDeposit(tx:Tx,ctx:Ctx,ticketId:string,refundId:string,amountCents:number,
  originalPayments?:Array<{paymentId:string;amountCents:number}>):Promise<void>{
  await lockBookingCapacity(tx,ctx.locationId);
  const payments=await tx<{id:string;deposit_hold_id:string;deposit_commerce_payment_id:string}[]>`
    select id,deposit_hold_id,deposit_commerce_payment_id from payments where ticket_id=${ticketId} and method='deposit' order by id`;
  const plan=originalPayments??(payments.length===1?[{paymentId:payments[0]!.id,amountCents}]:null);
  if(!plan||plan.reduce((n,p)=>n+p.amountCents,0)!==amountCents||new Set(plan.map(p=>p.paymentId)).size!==plan.length)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_refund_source_requires_review'}});
  for(const part of plan){
    const source=payments.find(p=>p.id===part.paymentId);
    if(!source?.deposit_commerce_payment_id||part.amountCents<=0)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_refund_source_requires_review'}});
    await tx`select id from commerce_appointment_holds where id=${source.deposit_hold_id} for update`;
    const uses=await tx<{entry:string;amount_cents:number;guest_allocation:Array<{guestIndex:number;amountCents:number}>|null}[]>`
      select entry,amount_cents,guest_allocation from commerce_deposit_ledger where hold_id=${source.deposit_hold_id}
       and payment_id=${source.deposit_commerce_payment_id} and ticket_id=${ticketId} and entry in('applied','restored')`;
    if(part.amountCents>-uses.reduce((n,u)=>n+u.amount_cents,0))throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_refund_exceeds_original_application'}});
    const original=(await depositPaymentSources(tx,ctx,source.deposit_hold_id)).find(p=>p.paymentId===source.deposit_commerce_payment_id);
    const remaining=new Map<number,number>();let known=true;
    for(const use of uses){const shares=use.guest_allocation??(original?.guests?.length===1?[{guestIndex:original.guests[0]!.guestIndex,amountCents:Math.abs(use.amount_cents)}]:null);
      if(!shares){known=false;break;}for(const share of shares)remaining.set(share.guestIndex,(remaining.get(share.guestIndex)??0)+(use.entry==='applied'?share.amountCents:-share.amountCents));}
    const shares=known?allocateDepositRefundByGuest([...remaining].map(([guestIndex,amountCents])=>({guestIndex,amountCents})),part.amountCents):null;
    await tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,ticket_id,ticket_refund_id,entry,amount_cents,reference,guest_allocation)
      values(${ctx.orgId},${ctx.locationId},${source.deposit_hold_id},${source.deposit_commerce_payment_id},${ticketId},${refundId},'restored',${part.amountCents},${`service-refund:${refundId}:${part.paymentId}`},${shares?jsonb(shares):null}::jsonb)`;
    await refreshDepositFinancialState(tx,source.deposit_hold_id);
  }
}
/** Preserve the verified cash fact even when the original reservation can no longer be fulfilled. */
export async function fulfillAppointmentDeposit(args:HandlerArgs<unknown>,order:OrderRow):Promise<{assetId:string;status:'fulfilled'|'refund_pending'}>{
  const {tx,ctx,emit}=args;
  const [hold]=await tx<{id:string;appointment_id:string;status:string;currency:string;commerce_frozen:boolean;waived_at:string|null;
    has_confirmed_booking:boolean;request_state:string;purpose:string;request_quote_id:string|null}[]>`
    select h.*,r.state as request_state,r.purpose,r.quote_id as request_quote_id from commerce_appointment_holds h
     join commerce_deposit_requests r on r.hold_id=h.id where r.order_id=${order.id} and h.location_id=${ctx.locationId} for update of h,r`;
  const [appt]=hold?await tx<{status:string;deposit_status:string;business_date:string;future:boolean;settled:boolean}[]>`
    select status,deposit_status,business_date::text,starts_at>now() as future,
     exists(select 1 from tickets t where t.appointment_id=a.id and t.status<>'voided' and t.service_settled_at is not null) as settled
    from appointments a where id=${hold.appointment_id} for update`:[];
  const [payment]=await tx<{id:string;status:string;amount_cents:number;currency:string}[]>`select id,status,amount_cents,currency from commerce_payments where order_id=${order.id}`;
  if(!hold||!appt||hold.commerce_frozen||payment?.status!=='paid'||payment.amount_cents!==order.amount_cents||payment.currency!==hold.currency
    ||order.snapshot.depositHoldId!==hold.id||(hold.request_quote_id&&order.snapshot.depositQuoteId!==hold.request_quote_id))
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_confirmation_context_mismatch'}});
  let guestShares:Array<{guestIndex:number;amountCents:number}>|null=null;
  const originalGuests=(order.snapshot.depositPolicy?.guestAllocation as {guests?:Array<{guestIndex:number;amountCents:number}>}|undefined)?.guests;
  if(Array.isArray(originalGuests)&&originalGuests.reduce((n,g)=>n+g.amountCents,0)===payment.amount_cents){
    try{guestShares=allocateDepositRefundByGuest(originalGuests,payment.amount_cents);}catch{/* Unknown historical allocation remains unclaimed. */}
  }
  await tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,entry,amount_cents,reference,guest_allocation)
    values(${ctx.orgId},${ctx.locationId},${hold.id},${payment.id},'collected',${payment.amount_cents},${`collect:${payment.id}`},${guestShares?jsonb(guestShares):null}::jsonb)`;
  const obsolete=['superseded','cancelled'].includes(hold.request_state);
  const supplemental=hold.has_confirmed_booking||hold.purpose==='supplement';
  let confirmed=!obsolete&&!hold.waived_at&&!appt.settled&&(supplemental
    ?['booked','checked_in','in_service'].includes(appt.status)
    :hold.status==='pending'&&appt.status==='booked'&&appt.deposit_status==='pending'&&appt.future);
  if(!confirmed&&!obsolete&&!hold.waived_at&&!supplemental&&hold.status==='expired'&&appt.status==='cancelled'&&appt.deposit_status==='expired'){
    try{await tx.savepoint(async sp=>restoreDepositBookingCapacity(sp,ctx,hold.appointment_id));confirmed=true;}
    catch(error){const code=(error as {code?:string}).code;
      if(!['RESOURCE_CONFLICT','STAFF_OVER_CAPACITY','LOCATION_OVER_CAPACITY','STAFF_NOT_BOOKABLE','23001','23P01'].includes(code??''))throw error;}
  }
  if(!obsolete)await tx`update commerce_deposit_requests set state='paid' where order_id=${order.id} and state in('open','expired')`;
  if(!confirmed){
    const reason=hold.waived_at?'deposit_payment_after_waiver':obsolete?'deposit_payment_after_requote':appt.settled?'deposit_payment_after_service_settlement':'late_deposit_booking_unavailable';
    if(!obsolete&&!hold.waived_at&&!supplemental&&!appt.settled){
      await tx`update appointment_items set status='cancelled' where appointment_id=${hold.appointment_id} and status='booked'`;
      await tx`update order_bundle_instances set status='cancelled' where appointment_id=${hold.appointment_id} and status='active'`;
      await tx`update appointments set status='cancelled',deposit_status='refund_pending',cancelled_at=coalesce(cancelled_at,now()),
        cancel_reason=coalesce(cancel_reason,'other') where id=${hold.appointment_id}`;
    }
    const [refund]=await tx<{id:string}[]>`insert into commerce_refunds(org_id,location_id,payment_id,amount_cents,asset_quantity,reason,recorded_by,deposit_guest_allocation)
      values(${ctx.orgId},${ctx.locationId},${payment.id},${payment.amount_cents},${payment.amount_cents},${reason},null,${guestShares?jsonb(guestShares):null}::jsonb) returning id`;
    await tx`update commerce_appointment_holds set reserved_cents=reserved_cents+${payment.amount_cents},updated_at=now() where id=${hold.id}`;
    await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id) values(${ctx.orgId},${ctx.locationId},'refund',${refund!.id})`;
    await refreshDepositFinancialState(tx,hold.id);
    args.audit({entityType:'commerce_refund',entityId:refund!.id,after:{status:'pending',reason}});
    emit({type:'appointment.changed',entityId:hold.appointment_id,businessDate:appt.business_date});
    return {assetId:hold.id,status:'refund_pending'};
  }
  await tx`update commerce_appointment_holds set has_confirmed_booking=true,updated_at=now() where id=${hold.id}`;
  await refreshDepositFinancialState(tx,hold.id);
  if(!hold.has_confirmed_booking)await confirmPaidDepositBooking(tx,ctx,hold.appointment_id);
  else {
    await tx`update email_outbox set status='failed',last_error='deposit_request_paid' where entity_id=${hold.appointment_id} and kind='appointment_deposit_pending' and status='pending'`;
    await queueAdditionalDepositReceipt(tx,ctx,hold.id,order.id);
  }
  emit({type:'appointment.changed',entityId:hold.appointment_id,businessDate:appt.business_date});
  return {assetId:hold.id,status:'fulfilled'};
}
