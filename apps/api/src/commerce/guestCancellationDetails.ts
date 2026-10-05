import {allocateAppointmentDepositByGuest} from '@gf/payroll';
import type {Tx} from './model';
import {appointmentItemGuestIndices,depositGuestBalances} from './depositGuests';

export interface GuestCancellationDetails {
  guests?:Array<{guestIndex:number;status:'active'|'cancelled';serviceTotalCents:number;refundableDepositCents?:number|null;refundStatus?:string|null}>;
  guestCancellation?:{enabled:boolean;reason:string|null;currency:string};
}

/** Shared staff/customer quote, using current service snapshots and original payment sources. */
export async function loadGuestCancellationDetails(tx:Tx,locationId:string,appointmentId:string,
  appointment:{partySize:number;status:string;depositStatus:string},
  items:Array<{groupKey:string;priceCents:number;status:string;details:Record<string,unknown>}>,
  options:{moneyVisible:boolean;ticketExists:boolean}):Promise<GuestCancellationDetails>{
  const cancellations=await tx<{guest_index:number;original_party_size:number}[]>`select guest_index,original_party_size
    from appointment_guest_cancellations where appointment_id=${appointmentId} order by guest_index`;
  const originalSize=cancellations[0]?.original_party_size??appointment.partySize;
  if(originalSize<=1)return {};
  const activeItems=items.filter(item=>item.status!=='cancelled');
  const mapped=activeItems.every(item=>{const indices=appointmentItemGuestIndices(item.details);return !!indices&&indices.every(i=>i<originalSize);});
  const [loc]=await tx<{currency:string}[]>`select currency from locations where id=${locationId}`;
  let reason=!mapped?'appointment_guest_mapping_requires_review':options.ticketExists?'appointment_ticket_exists':
    !['booked','checked_in'].includes(appointment.status)?'appointment_not_editable':null;
  let balances:Awaited<ReturnType<typeof depositGuestBalances>>=null,unknownMoney=false;
  if(options.moneyVisible){
    const [h]=await tx<{id:string;status:string;waived_at:string|null;balance:number;commerce_frozen:boolean}[]>`
      select h.id,h.status,h.waived_at,(select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance,h.commerce_frozen
      from commerce_appointment_holds h where h.appointment_id=${appointmentId}`;
    if(h&&!h.waived_at&&h.balance>0){balances=await depositGuestBalances(tx,{locationId},h.id);unknownMoney=!balances;
      if(!balances||h.commerce_frozen)reason??='deposit_guest_refund_requires_review';}
  }else if(appointment.depositStatus!=='none')reason??='financial_access_required';
  const result:GuestCancellationDetails={guestCancellation:{enabled:reason===null,reason,currency:loc!.currency.toUpperCase()}};
  if(mapped){
    const allocation=allocateAppointmentDepositByGuest(originalSize,activeItems.map(item=>({...item,guestIndices:appointmentItemGuestIndices(item.details)!})),0);
    result.guests=allocation.guests.map(g=>({guestIndex:g.guestIndex,status:cancellations.some(c=>c.guest_index===g.guestIndex)?'cancelled':'active',
      serviceTotalCents:g.serviceTotalCents,...(options.moneyVisible?{refundableDepositCents:unknownMoney?null:
        balances?.find(b=>b.guestIndex===g.guestIndex)?.availableCents??0,refundStatus:balances?.find(b=>b.guestIndex===g.guestIndex)?.refundStatus??null}:{})}));
  }
  return result;
}
