import {AppError,ERROR_CODES,AppointmentCancelGuests,appointmentAllowsSchedulingChanges} from '@gf/contracts';
import {businessDateOf} from '@gf/scheduling';
import {registerHandler} from '../bus';
import {lockBookingCapacity,cancelAppointmentInTransaction,loadChangeNotifySnapshot,notifyAppointmentChange} from './appointment';
import {requestRefundInTransaction} from './commerce';
import {requoteAppointmentDeposit} from './appointmentDepositAdjustments';
import {depositPaymentSources,allocateDepositSources} from '../commerce/depositSources';
import {depositGuestBalances,appointmentItemGuestIndices} from '../commerce/depositGuests';
import {assertManagedGuestCancellation} from '../public/managedCancellation';

function invalid(reason:string,extra:Record<string,unknown>={}):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason,...extra}});}
registerHandler(AppointmentCancelGuests,async(args)=>{
  const {input,ctx,tx,audit,emit}=args;
  if(!ctx.membershipId&&!ctx.verifiedManagedBooking)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  await lockBookingCapacity(tx,ctx.locationId);
  const [appt]=await tx<{id:string;status:string;party_size:number;starts_at:string;business_date:string}[]>`
    select id,status,party_size,starts_at::text,business_date::text from appointments
    where id=${input.appointmentId} and location_id=${ctx.locationId} for update`;
  if(!appt)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment'}});
  if(!ctx.membershipId)await assertManagedGuestCancellation(tx,ctx,appt.id);
  const selected=[...input.guestIndices].sort((a,b)=>a-b);
  const past=await tx<{id:string;guest_index:number;original_party_size:number;reason:string}[]>`
    select id,guest_index,original_party_size,reason from appointment_guest_cancellations where appointment_id=${appt.id} order by guest_index`;
  const originalSize=past[0]?.original_party_size??appt.party_size;
  if(originalSize<=1||selected.some(i=>i>=originalSize))invalid('invalid_cancellation_guests');
  const previous=past.filter(p=>selected.includes(p.guest_index));
  if(previous.length){
    if(previous.length!==selected.length)invalid('guest_already_cancelled');
    if(previous.some(p=>p.reason!==input.reason))invalid('guest_cancellation_changed');
    const refunds=await tx<{id:string;amount_cents:number;status:string}[]>`select id,amount_cents,status from commerce_refunds
      where guest_cancellation_id=any(${previous.map(p=>p.id)}::uuid[]) and status<>'failed' order by created_at,id`;
    audit({entityType:'appointment',entityId:appt.id,after:{replayed:true,guestIndices:selected}});
    return {appointmentId:appt.id,cancellationIds:previous.map(p=>p.id),cancelledItemIds:[],
      remainingGuests:['cancelled','no_show'].includes(appt.status)?0:originalSize-past.length,
      refunds:refunds.map(r=>({refundId:r.id,amountCents:r.amount_cents,status:r.status}))};
  }
  if(!appointmentAllowsSchedulingChanges(appt.status))invalid('appointment_not_editable',{status:appt.status});
  const [ticket]=await tx`select id from tickets where appointment_id=${appt.id} and status<>'voided' limit 1`;
  if(ticket)invalid('appointment_ticket_exists');
  const remainingCount=originalSize-past.length-selected.length;
  const rows=await tx<{id:string;status:string;details:Record<string,unknown>;bundle_instance_id:string|null}[]>`
    select id,status,details,bundle_instance_id from appointment_items where appointment_id=${appt.id} and status<>'cancelled' order by seq,id`;
  const mapped=rows.map(row=>({...row,guests:appointmentItemGuestIndices(row.details)}));
  if(mapped.some(row=>!row.guests||row.guests.some(i=>i>=originalSize)))invalid('appointment_guest_mapping_requires_review');
  const targets=mapped.filter(row=>row.guests!.some(i=>selected.includes(i)));
  if(!targets.length)invalid('guest_has_no_active_services');
  if(Array.from({length:originalSize},(_,i)=>i).filter(i=>!past.some(p=>p.guest_index===i))
    .some(i=>!mapped.some(row=>row.guests!.includes(i))))invalid('appointment_guest_mapping_requires_review');
  const shared=targets.find(row=>row.guests!.some(i=>!selected.includes(i)));
  if(shared)invalid('shared_service_requires_all_guests',{guestIndices:shared.guests});
  const instances=new Set(targets.map(row=>row.bundle_instance_id).filter(Boolean));
  if(mapped.some(row=>row.bundle_instance_id&&instances.has(row.bundle_instance_id)&&!targets.some(t=>t.id===row.id)))
    invalid('shared_bundle_requires_all_guests');
  const [h]=await tx<{id:string;status:string;order_id:string|null;waived_at:string|null;commerce_frozen:boolean;balance:number;before_cutoff:boolean}[]>`
    select h.id,h.status,h.order_id,h.waived_at::text,h.commerce_frozen,
      (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance,
      a.starts_at>=now()+(h.policy_snapshot->>'cancelCutoffHours')::numeric*interval '1 hour' as before_cutoff
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.appointment_id=${appt.id} for update of h`;
  if(h?.commerce_frozen)invalid('deposit_guest_refund_requires_review');
  const balances=h&&!h.waived_at&&h.balance>0?await depositGuestBalances(tx,ctx,h.id):null;
  if(h&&!h.waived_at&&h.balance>0&&!balances)invalid('deposit_guest_refund_requires_review');
  const amounts=selected.map(guestIndex=>({guestIndex,amountCents:balances?.find(g=>g.guestIndex===guestIndex)?.availableCents??0}));
  const totalRefund=amounts.reduce((n,g)=>n+g.amountCents,0);
  if(totalRefund!==input.expectedRefundCents)invalid('deposit_guest_refund_quote_changed',{amountCents:totalRefund});
  const sources=h?await depositPaymentSources(tx,ctx,h.id):[];
  if(totalRefund>0&&sources.reduce((n,s)=>n+s.availableCents,0)<totalRefund)invalid('payment_not_refundable');
  const cancellations=[] as Array<{id:string;guestIndex:number}>;
  for(const guestIndex of selected){
    const [record]=await tx<{id:string}[]>`insert into appointment_guest_cancellations(org_id,location_id,appointment_id,guest_index,original_party_size,reason,created_by,actor_source,original_starts_at)
      values(${ctx.orgId},${ctx.locationId},${appt.id},${guestIndex},${originalSize},${input.reason},${ctx.membershipId},${ctx.membershipId?'staff':'customer'},${appt.starts_at}::timestamptz) returning id`;
    cancellations.push({id:record!.id,guestIndex});
  }
  const snapshot=await loadChangeNotifySnapshot(tx,appt.id);
  await tx`update email_outbox set status='failed',last_error='appointment_guest_cancelled' where entity_id=${appt.id} and kind='appointment_confirm' and status='pending'`;
  await tx`update sms_outbox set status='suppressed',last_error='appointment_guest_cancelled' where entity_id=${appt.id} and kind='appointment_confirm' and status='pending'`;
  if(remainingCount===0){
    const paymentIds=sources.map(s=>s.paymentId);
    const earlier=paymentIds.length?await tx<{id:string}[]>`select id from commerce_refunds where payment_id=any(${paymentIds}::uuid[])`:[];
    await cancelAppointmentInTransaction({...args,input:{appointmentId:appt.id,reason:'guest_changed_mind',note:input.reason,keepStaffTurn:false}},{notifyCustomer:true});
    const refunds=paymentIds.length?await tx<{id:string;amount_cents:number;status:string}[]>`select id,amount_cents,status from commerce_refunds
      where payment_id=any(${paymentIds}::uuid[]) and not(id=any(${earlier.map(r=>r.id)}::uuid[]))`:[];
    audit({entityType:'appointment',entityId:appt.id,after:{cancelledGuests:selected,remainingGuests:0}});
    return {appointmentId:appt.id,cancellationIds:cancellations.map(c=>c.id),cancelledItemIds:targets.map(t=>t.id),remainingGuests:0,
      refunds:refunds.map(r=>({refundId:r.id,amountCents:r.amount_cents,status:r.status}))};
  }
  await tx`update appointment_items set status='cancelled' where id=any(${targets.map(t=>t.id)}::uuid[])`;
  for(const instanceId of instances)await tx`update order_bundle_instances set status='cancelled' where id=${instanceId!}`;
  const [span]=await tx<{starts_at:string;ends_at:string}[]>`select min(starts_at)::text as starts_at,max(ends_at)::text as ends_at
    from appointment_items where appointment_id=${appt.id} and status<>'cancelled'`;
  const [loc]=await tx<{timezone:string;cutoff:string}[]>`select timezone,business_day_cutoff::text as cutoff from locations where id=${ctx.locationId}`;
  const businessDate=businessDateOf(new Date(span!.starts_at),loc!.timezone,loc!.cutoff);
  await tx`update appointments set party_size=${remainingCount},starts_at=${span!.starts_at}::timestamptz,ends_at=${span!.ends_at}::timestamptz,business_date=${businessDate}
    where id=${appt.id}`;
  const refunds=[] as Array<{refundId:string;amountCents:number;status:string}>;
  for(const cancellation of cancellations){
    const amount=amounts.find(g=>g.guestIndex===cancellation.guestIndex)!.amountCents;if(!amount)continue;
    for(const part of allocateDepositSources(await depositPaymentSources(tx,ctx,h!.id),amount,[cancellation.guestIndex])){
      const refund=await requestRefundInTransaction({...args,input:{paymentId:part.paymentId,amountCents:part.amountCents,reason:input.reason,depositGuestIndices:[cancellation.guestIndex]}},undefined,
        {guestCancellationId:cancellation.id,requireReview:!h!.before_cutoff});refunds.push({...refund,amountCents:part.amountCents});
    }
  }
  const requote=h?.status==='pending'?await requoteAppointmentDeposit(args,h.id,input.depositAdjustment,{reason:input.reason}):null;
  await notifyAppointmentChange(tx,ctx,{appointmentId:appt.id,depositNoticeQueued:!!requote,event:'appointment_changed',staffEvent:'staff_changed',oldStartsAt:appt.starts_at,
    newStartsAt:span!.starts_at,snapshot,notifyCustomer:true});
  audit({entityType:'appointment',entityId:appt.id,after:{cancelledGuests:selected,remainingGuests:remainingCount,cancellationIds:cancellations.map(c=>c.id)}});
  emit({type:'appointment.changed',entityId:appt.id,businessDate});
  return {appointmentId:appt.id,cancellationIds:cancellations.map(c=>c.id),cancelledItemIds:targets.map(t=>t.id),remainingGuests:remainingCount,refunds};
});
