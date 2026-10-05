import {closeDepositRequests} from './appointmentDepositAdjustments';
import {createHash} from 'node:crypto';
import {jsonb,readOnlineBooking} from '@gf/db';
import {lockOpenDay} from './dayclose';
import {AppError,ERROR_CODES,CommerceHoldAppointment,CommerceExpireAppointmentHold,CommerceRecordOfflineDeposit,CommerceStartDepositCheckout,CommercePublicDepositBooking,CommerceWaiveAppointmentDeposit} from '@gf/contracts';
import {commerceFingerprint,quoteAppointmentDeposit,allocateAppointmentDepositByGuest} from '@gf/payroll';
import {registerHandler,type HandlerArgs} from '../bus';
import {assertCommerceEnabled,commerceLiveMode} from '../commerce/config';
import {executeSingleAppointmentInTx,lockBookingCapacity,confirmPaidDepositBooking} from './appointment';
import type {OrderRow,PurchaseSnapshot} from '../commerce/model';
import {fulfillOrderInTransaction,queueTask} from './commerce';
import {hostedManageBookingUrl} from '../links';
import {commerceReturnBase} from '../commerce/provider';
import {appointmentDepositPolicy} from '../commerce/depositPolicy';
import {queuePendingDepositNotice} from './appointmentDepositNotices';

interface Hold {id:string;appointment_id:string;status:string;amount_cents:number;service_total_cents:number;currency:string;
  expires_at:string;request_hash:string;}
function holdResult(h:Hold){return {holdId:h.id,appointmentId:h.appointment_id,status:h.status,amountCents:h.amount_cents,
  serviceTotalCents:h.service_total_cents,currency:h.currency,expiresAt:new Date(h.expires_at).toISOString()};}
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}

// A real provisional appointment owns the existing capacity rows. Financial confirmation is a separate transition.
export async function holdAppointmentInTransaction({input,ctx,tx,audit,emit}:HandlerArgs<typeof CommerceHoldAppointment.input._type>,
  options?:{nativeVoiceGuestIndices:number[][]}){
  const hash=createHash('sha256').update(commerceFingerprint(input)).digest('hex');
  await lockBookingCapacity(tx,ctx.locationId);
  const [previous]=await tx<Hold[]>`select *,expires_at::text from commerce_appointment_holds
    where location_id=${ctx.locationId} and business_key=${input.businessKey} for update`;
  if(previous){
    if(previous.request_hash!==hash)invalid('deposit_key_reused');
    audit({entityType:'appointment_deposit_hold',entityId:previous.id,after:{replayed:true,status:previous.status}});
    return holdResult(previous);
  }
  // Closing new sales must not prevent replaying or expiring an existing hold.
  assertCommerceEnabled();
  const [loc]=await tx<{currency:string;settings:Record<string,unknown>}[]>`select currency,settings from locations where id=${ctx.locationId}`;
  if(!loc)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'location'}});
  const commerce=(loc.settings.commerce??{}) as {depositsEnabled?:boolean};
  const booking=readOnlineBooking(loc.settings);
  if(!commerce.depositsEnabled||!booking.depositRequired)invalid('new_deposits_disabled');
  if(input.appointment.isBackfill)invalid('deposit_hold_requires_future_booking');
  const starts=input.appointment.items.map(i=>i.startsAt).concat(input.appointment.bundleSelections.map(i=>i.startsAt));
  const [clock]=await tx<{now:string}[]>`select now()::text as now`;
  if(starts.some(s=>Date.parse(s)<=Date.parse(clock!.now)))invalid('deposit_hold_requires_future_booking');
  const booked=await executeSingleAppointmentInTx(tx,ctx,input.appointment,{deferConfirmation:true});
  // The native voice offer has its own configured requested-therapist buffer validation.
  // Attach proven guest identity after that normal scheduling path, under this same capacity lock.
  // This server-only option is never command input and cannot authorize capacity overrides.
  if(options){
    const mapping=options.nativeVoiceGuestIndices;
    if(input.appointment.source!=='phone_ai'||mapping.length!==booked.itemIds.length||mapping.length!==input.appointment.partySize
      ||mapping.some((indices,index)=>indices.length!==1||indices[0]!==index))invalid('invalid_native_voice_guest_mapping');
    for(const [index,itemId] of booked.itemIds.entries())await tx`update appointment_items set details=details||${jsonb({publicGuestIndex:mapping[index]![0]})}::jsonb
      where id=${itemId} and appointment_id=${booked.appointmentId}`;
  }
  const [quote]=await tx<{total:number}[]>`select coalesce(sum(price_cents_snapshot),0)::int as total
    from appointment_items where appointment_id=${booked.appointmentId} and status='booked'`;
  let amount:number;
  const policy=appointmentDepositPolicy(booking);
  try{amount=quoteAppointmentDeposit(quote!.total,policy.method==='percentage'?{percentBps:policy.percentBps!}:{fixedAmountCents:policy.fixedAmountCents!});}
  catch{invalid('invalid_deposit_policy');}
  if(amount!<=0)invalid('deposit_requires_positive_service_total');
  const consent=input.depositConsent;
  if(consent&&(consent.policyVersion!==policy.version||consent.amountCents!==amount!||consent.serviceTotalCents!==quote!.total))invalid('deposit_quote_changed');
  if(policy.retainAfterCutoff&&!consent)invalid('deposit_policy_consent_required');
  const allocationRows=await tx<{id:string;price_cents_snapshot:number;details:Record<string,unknown>}[]>`select id,price_cents_snapshot,details
    from appointment_items where appointment_id=${booked.appointmentId} and status='booked' order by seq,id`;
  let allocation:ReturnType<typeof allocateAppointmentDepositByGuest>;
  try{allocation=allocateAppointmentDepositByGuest(input.appointment.partySize,allocationRows.map(i=>({groupKey:String(i.details.serviceExecutionGroup??i.id),
    priceCents:i.price_cents_snapshot,...(Array.isArray(i.details.publicGuestIndices)?{guestIndices:i.details.publicGuestIndices as number[]}
      :Number.isInteger(i.details.publicGuestIndex)?{guestIndices:[Number(i.details.publicGuestIndex)]}:{})})),amount!);}
  catch{invalid('deposit_guest_allocation_requires_review');}
  const snapshot={...policy,consent:consent?{accepted:true,at:clock!.now,locale:ctx.locale,
    method:ctx.membershipId===null&&input.appointment.source==='phone_ai'?'voice_confirmation':
      ctx.membershipId===null&&ctx.userId===null?'customer_confirmation':'staff_confirmation'}:null,guestAllocation:allocation!};
  const [hold]=await tx<Hold[]>`insert into commerce_appointment_holds
    (org_id,location_id,appointment_id,amount_cents,service_total_cents,currency,expires_at,policy_snapshot,business_key,request_hash)
    values(${ctx.orgId},${ctx.locationId},${booked.appointmentId},${amount!},${quote!.total},${loc.currency.toLowerCase()},
      now()+interval '15 minutes',${jsonb(snapshot)}::jsonb,${input.businessKey},${hash}) returning *,expires_at::text`;
  await tx`update appointments set deposit_status='pending' where id=${booked.appointmentId}`;
  await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at)
    values(${ctx.orgId},${ctx.locationId},'expire_deposit',${hold!.id},${hold!.expires_at}::timestamptz)`;
  audit({entityType:'appointment_deposit_hold',entityId:hold!.id,after:{appointmentId:booked.appointmentId,status:'pending',policyVersion:policy.version}});
  emit({type:'appointment.changed',entityId:booked.appointmentId,businessDate:booked.businessDate});
  return holdResult(hold!);
}
registerHandler(CommerceHoldAppointment,holdAppointmentInTransaction);

export async function startDepositCheckoutInTransaction({input,ctx,tx,audit}:HandlerArgs<typeof CommerceStartDepositCheckout.input._type>){
  await lockBookingCapacity(tx,ctx.locationId);
  const [h]=await tx<(Hold&{order_id:string|null;policy_snapshot:Record<string,unknown>;due:boolean})[]>`select *,expires_at<=now() as due
    from commerce_appointment_holds where id=${input.holdId} and location_id=${ctx.locationId} for update`;
  if(!h)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment_deposit_hold'}});
  const [current]=await tx<{order_id:string}[]>`select order_id from commerce_deposit_requests where hold_id=${h.id}
    order by (state='open') desc,created_at desc,order_id desc limit 1`;
  if(current){
    const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${current.order_id}`;
    const [p]=await tx<{id:string;provider:string}[]>`select id,provider from commerce_payments where order_id=${current.order_id}`;
    if(!o||p?.provider!=='stripe')invalid('deposit_payment_channel_locked');
    audit({entityType:'commerce_order',entityId:o.id,after:{replayed:true,status:o.status}});
    return {orderId:o.id,status:o.status,paymentId:p.id,assetId:o.asset_id};
  }
  assertCommerceEnabled();
  const [loc]=await tx<{settings:Record<string,unknown>}[]>`select settings from locations where id=${ctx.locationId}`;
  if(!(loc?.settings.commerce as {depositsEnabled?:boolean}|undefined)?.depositsEnabled)invalid('new_deposits_disabled');
  if(h.status!=='pending'||h.due)invalid('deposit_hold_not_payable');
  const mode=commerceLiveMode();
  const [account]=await tx<{id:string;stripe_account_id:string}[]>`select id,stripe_account_id from commerce_accounts
    where location_id=${ctx.locationId} and livemode=${mode} and charges_enabled and not disconnected and capabilities->>'card_payments'='active'`;
  if(!account)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'merchant_payments_unavailable'}});
  const [appt]=await tx<{customer_id:string|null}[]>`select customer_id from appointments where id=${h.appointment_id}`;
  const snapshot:PurchaseSnapshot={version:1,kind:'deposit',name:'Appointment deposit',templateId:null,amountCents:h.amount_cents,
    currency:h.currency,faceValueCents:0,sessions:0,serviceIds:[],scope:'location',validDays:null,coverageMode:'bundle',commissionBasis:'zero',
    recipientName:null,recipientNote:null,recipientEmail:null,consentVersion:String(h.policy_snapshot.version),consentAt:new Date().toISOString(),
    depositHoldId:h.id,appointmentId:h.appointment_id,serviceTotalCents:h.service_total_cents,depositPolicy:h.policy_snapshot};
  const [o]=await tx<OrderRow[]>`insert into commerce_orders(org_id,location_id,customer_id,account_id,kind,channel,status,amount_cents,currency,snapshot,idem_key,request_hash)
    values(${ctx.orgId},${ctx.locationId},${appt?.customer_id??null},${account.id},'deposit','online','pending',${h.amount_cents},${h.currency},
      ${jsonb(snapshot)}::jsonb,${`deposit:${h.id}`},${h.request_hash}) returning *`;
  const [p]=await tx<{id:string}[]>`insert into commerce_payments(org_id,location_id,order_id,provider,method,amount_cents,currency,stripe_account_id,livemode)
    values(${ctx.orgId},${ctx.locationId},${o!.id},'stripe','card',${h.amount_cents},${h.currency},${account.stripe_account_id},${mode}) returning id`;
  await tx`update commerce_appointment_holds set order_id=${o!.id},updated_at=now() where id=${h.id}`;
  await queueTask(tx,ctx,'checkout',o!.id);await queueTask(tx,ctx,'reconcile',o!.id,30);
  audit({entityType:'commerce_order',entityId:o!.id,after:{status:'pending',appointmentId:h.appointment_id}});
  return {orderId:o!.id,status:o!.status,paymentId:p!.id,assetId:null};
}
registerHandler(CommerceStartDepositCheckout,startDepositCheckoutInTransaction);
registerHandler(CommercePublicDepositBooking,async(args)=>{
  const a=args.input.appointment;
  if(!['web','phone_ai'].includes(a.source)||a.customerId||a.newCustomer||a.override||!a.guest)invalid('invalid_public_deposit_booking');
  const [loc]=await args.tx<{slug:string}[]>`select slug from locations where id=${args.ctx.locationId}`;
  if(!loc||!hostedManageBookingUrl({shopSlug:loc.slug,manageToken:a.guest.manageToken},{...process.env,BOOKING_PAGE_ORIGIN:commerceReturnBase()}))
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'merchant_deposit_setup_incomplete'}});
  const hold=await holdAppointmentInTransaction(args);
  const [token]=await args.tx<{wrapped:Buffer|null}[]>`select manage_token_wrapped as wrapped from appointments where id=${hold.appointmentId}`;
  if(!token?.wrapped)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'merchant_deposit_setup_incomplete'}});
  const order=await startDepositCheckoutInTransaction({...args,input:{holdId:hold.holdId}});
  await queuePendingDepositNotice(args.tx,args.ctx,hold.holdId);
  const [appt]=await args.tx<{business_date:string}[]>`select business_date::text from appointments where id=${hold.appointmentId}`;
  return {...hold,orderId:order.orderId,businessDate:appt!.business_date};
});

registerHandler(CommerceRecordOfflineDeposit,async(args)=>{
  const {input,ctx,tx,audit}=args;
  await lockBookingCapacity(tx,ctx.locationId);
  const [h]=await tx<(Hold&{order_id:string|null;policy_snapshot:Record<string,unknown>;due:boolean})[]>`select *,expires_at<=now() as due
    from commerce_appointment_holds where id=${input.holdId} and location_id=${ctx.locationId} for update`;
  if(!h)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment_deposit_hold'}});
  const hash=createHash('sha256').update(commerceFingerprint(input)).digest('hex');
  const [current]=await tx<{order_id:string;state:string;due:boolean}[]>`select order_id,state,expires_at<=now() as due from commerce_deposit_requests
    where hold_id=${h.id} and (${input.orderId??null}::uuid is null or order_id=${input.orderId??null}::uuid)
    order by (state='open') desc,created_at desc,order_id desc limit 1 for update`;
  if(input.orderId&&!current)invalid('deposit_payment_context_mismatch');
  if(current){
    const [order]=await tx<OrderRow[]>`select * from commerce_orders where id=${current.order_id} for update`;
    const [p]=await tx<{id:string;status:string;provider:string;method:string;amount_cents:number;external_reference:string|null}[]>`select * from commerce_payments where order_id=${current.order_id} for update`;
    if(!order||!p||p.provider!=='offline')invalid('deposit_receipt_changed');
    if(['paid','refunded','disputed'].includes(p.status)){
      if(p.amount_cents!==input.amountCents||p.method!==input.method||p.external_reference!==input.reference)invalid('deposit_receipt_changed');
      audit({entityType:'commerce_order',entityId:order.id,after:{replayed:true,status:order.status}});
      return {orderId:order.id,status:order.status,paymentId:p.id,assetId:order.asset_id};
    }
    await lockOpenDay(tx,ctx);
    if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    if(current.state!=='open'||current.due||p.status!=='pending'||h.status==='review')invalid('deposit_hold_not_payable');
    if(input.amountCents!==order.amount_cents)invalid('deposit_amount_mismatch');
    await tx`update commerce_payments set status='paid',method=${input.method},external_reference=${input.reference},recorded_by=${ctx.membershipId},paid_at=now() where id=${p.id}`;
    await tx`update commerce_orders set status='paid',updated_at=now() where id=${order.id}`;order.status='paid';
    await fulfillOrderInTransaction(args,order);
    audit({entityType:'commerce_order',entityId:order.id,after:{status:order.status,source:'recorded_offline_receipt',appointmentId:h.appointment_id}});
    return {orderId:order.id,status:order.status,paymentId:p.id,assetId:order.asset_id};
  }
  await lockOpenDay(tx,ctx);
  if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  if(h.status!=='pending'||h.due)invalid('deposit_hold_not_payable');
  if(input.amountCents!==h.amount_cents)invalid('deposit_amount_mismatch');
  const [appt]=await tx<{customer_id:string|null}[]>`select customer_id from appointments where id=${h.appointment_id}`;
  const snapshot:PurchaseSnapshot={version:1,kind:'deposit',name:'Appointment deposit',templateId:null,amountCents:h.amount_cents,
    currency:h.currency,faceValueCents:0,sessions:0,serviceIds:[],scope:'location',validDays:null,coverageMode:'bundle',commissionBasis:'zero',
    recipientName:null,recipientNote:null,recipientEmail:null,consentVersion:String(h.policy_snapshot.version),consentAt:new Date().toISOString(),
    depositHoldId:h.id,appointmentId:h.appointment_id,serviceTotalCents:h.service_total_cents,depositPolicy:h.policy_snapshot};
  const [order]=await tx<OrderRow[]>`insert into commerce_orders(org_id,location_id,customer_id,kind,channel,status,amount_cents,currency,snapshot,idem_key,request_hash)
    values(${ctx.orgId},${ctx.locationId},${appt?.customer_id??null},'deposit','offline','paid',${h.amount_cents},${h.currency},
      ${jsonb(snapshot)}::jsonb,${`deposit:${h.id}`},${hash}) returning *`;
  const [p]=await tx<{id:string}[]>`insert into commerce_payments(org_id,location_id,order_id,provider,method,status,amount_cents,currency,external_reference,recorded_by,paid_at)
    values(${ctx.orgId},${ctx.locationId},${order!.id},'offline',${input.method},'paid',${input.amountCents},${h.currency},${input.reference},${ctx.membershipId},now()) returning id`;
  await tx`update commerce_appointment_holds set order_id=${order!.id},updated_at=now() where id=${h.id}`;
  await fulfillOrderInTransaction(args,order!);
  audit({entityType:'commerce_order',entityId:order!.id,after:{status:order!.status,source:'recorded_offline_receipt',appointmentId:h.appointment_id}});
  return {orderId:order!.id,status:order!.status,paymentId:p!.id,assetId:order!.asset_id};
});

registerHandler(CommerceWaiveAppointmentDeposit,async({input,ctx,tx,audit,emit})=>{
  if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  await lockBookingCapacity(tx,ctx.locationId);
  const [h]=await tx<{id:string;appointment_id:string;order_id:string|null;status:string;due:boolean;commerce_frozen:boolean;
    reserved_cents:number;waived_at:string|null;waiver_reason:string|null;collected:number}[]>`select h.*,h.expires_at<=now() as due,
      (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as collected
      from commerce_appointment_holds h where h.id=${input.holdId} and h.location_id=${ctx.locationId} for update`;
  if(!h)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment_deposit_hold'}});
  if(h.waived_at){
    if(h.waiver_reason!==input.reason)invalid('deposit_waiver_changed');
    audit({entityType:'appointment_deposit_hold',entityId:h.id,after:{replayed:true,status:'waived'}});
    return {holdId:h.id,appointmentId:h.appointment_id,status:'waived' as const};
  }
  const [appt]=await tx<{status:string;deposit_status:string;business_date:string;future:boolean}[]>`
    select status,deposit_status,business_date::text,starts_at>now() as future from appointments where id=${h.appointment_id} for update`;
  if(h.status!=='pending'||h.due||h.commerce_frozen||h.reserved_cents!==0||h.collected!==0
    ||appt?.status!=='booked'||appt.deposit_status!=='pending'||!appt.future)invalid('deposit_hold_not_waivable');
  await tx`update commerce_appointment_holds set status='waived',has_confirmed_booking=true,waived_at=now(),waived_by=${ctx.membershipId},
    waiver_reason=${input.reason},updated_at=now() where id=${h.id}`;
  await tx`update appointments set deposit_status='waived' where id=${h.appointment_id}`;
  await closeDepositRequests(tx,ctx,h.id,'cancelled');
  await confirmPaidDepositBooking(tx,ctx,h.appointment_id);
  audit({entityType:'appointment_deposit_hold',entityId:h.id,before:{status:h.status},
    after:{status:'waived',reason:input.reason,appointmentId:h.appointment_id}});
  emit({type:'appointment.changed',entityId:h.appointment_id,businessDate:appt.business_date});
  return {holdId:h.id,appointmentId:h.appointment_id,status:'waived' as const};
});

registerHandler(CommerceExpireAppointmentHold,async({input,ctx,tx,audit,emit})=>{
  await lockBookingCapacity(tx,ctx.locationId);
  const [hold]=await tx<{id:string;appointment_id:string;order_id:string|null;status:string;due:boolean}[]>`select id,appointment_id,order_id,status,expires_at<=now() as due
    from commerce_appointment_holds where id=${input.holdId} and location_id=${ctx.locationId} for update`;
  if(!hold)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment_deposit_hold'}});
  let expired=false;
  if(hold.status==='pending'&&hold.due){
    const [appt]=await tx<{status:string;deposit_status:string;business_date:string}[]>`select status,deposit_status,business_date::text
      from appointments where id=${hold.appointment_id} for update`;
    if(appt?.status==='booked'&&appt.deposit_status==='pending'){
      // Change the hold first, so the generic cancellation trigger cannot turn expiry into manual cancellation.
      await tx`update commerce_appointment_holds set status='expired',updated_at=now() where id=${hold.id}`;
      await tx`update appointment_items set status='cancelled' where appointment_id=${hold.appointment_id} and status='booked'`;
      await tx`update order_bundle_instances set status='cancelled' where appointment_id=${hold.appointment_id} and status='active'`;
      await tx`update appointments set status='cancelled',deposit_status='expired',cancelled_at=now(),
        cancel_reason='other',cancel_note='Deposit hold expired before payment confirmation' where id=${hold.appointment_id}`;
      emit({type:'appointment.changed',entityId:hold.appointment_id,businessDate:appt.business_date});
      expired=true;
      await closeDepositRequests(tx,ctx,hold.id,'expired');
    }else if(appt?.status==='cancelled'||appt?.status==='no_show'){
      await tx`update commerce_appointment_holds set status='cancelled',updated_at=now() where id=${hold.id}`;
    }else{
      // An inconsistent legacy/manual transition is reviewable, never silently released as unpaid.
      await tx`update commerce_appointment_holds set status='review',updated_at=now() where id=${hold.id}`;
    }
  }
  audit({entityType:'appointment_deposit_hold',entityId:hold.id,after:{expired}});
  return {expired};
});
