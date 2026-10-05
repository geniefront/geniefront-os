import type {Tx,Ctx} from './model';
import {depositGuestBalances} from './depositGuests';

export interface DepositRetentionQuote {enabled:boolean;reason:string|null;policyVersion:string|null;guests:Array<{guestIndex:number;availableCents:number}>;
  policy?:{cancelCutoffHours:number;notice:string};}
/** Uses the cancellation's original time, never the remaining group's later rescheduled time. */
export async function loadDepositRetentionQuote(tx:Tx,ctx:Pick<Ctx,'locationId'>,holdId:string):Promise<DepositRetentionQuote>{
  const disabled=(reason:string):DepositRetentionQuote=>({enabled:false,reason,policyVersion:null,guests:[]});
  const [h]=await tx<{appointment_id:string;order_id:string|null;status:string;waived_at:string|null;commerce_frozen:boolean;
    policy_snapshot:{version?:string;retainAfterCutoff?:boolean;cancelCutoffHours?:number;cancellationPolicyNotice?:string;consent?:{accepted?:boolean}};
    whole_late:boolean;payment_status:string|null}[]>`select h.*,case when exists(select 1 from commerce_deposit_requests dr join commerce_payments dp on dp.order_id=dr.order_id where dr.hold_id=h.id and dp.status='paid' and dr.state='paid') then 'paid' else null end as payment_status,
      a.status in('cancelled','no_show') and a.cancelled_at is not null
       and a.cancelled_at>a.starts_at-(h.policy_snapshot->>'cancelCutoffHours')::numeric*interval '1 hour'
       and (a.cancel_reason<>'no_show' or a.cancelled_at>=a.starts_at) as whole_late
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id
    where h.id=${holdId} and h.location_id=${ctx.locationId}`;
  if(!h||h.payment_status!=='paid'||h.waived_at||h.commerce_frozen)return disabled('deposit_not_retainable');
  if(h.policy_snapshot.retainAfterCutoff!==true||h.policy_snapshot.consent?.accepted!==true||!h.policy_snapshot.version)
    return disabled('deposit_retention_policy_not_accepted');
  const guests=await depositGuestBalances(tx,ctx,holdId);if(!guests)return disabled('deposit_guest_refund_requires_review');
  const cancellations=await tx<{guest_index:number;late:boolean}[]>`select guest_index,
    original_starts_at is not null and created_at>original_starts_at-${h.policy_snapshot.cancelCutoffHours!}*interval '1 hour' as late
    from appointment_guest_cancellations where appointment_id=${h.appointment_id}`;
  const reviews=await tx<{deposit_guest_allocation:Array<{guestIndex:number;amountCents:number}>|null}[]>`select deposit_guest_allocation
    from commerce_refunds where payment_id in(select p.id from commerce_payments p join commerce_deposit_requests dr on dr.order_id=p.order_id where dr.hold_id=${holdId})
      and status='review' and review_required and approved_at is null and stripe_refund_id is null`;
  const amounts=new Map(guests.map(g=>[g.guestIndex,g.availableCents]));
  for(const r of reviews){if(!r.deposit_guest_allocation)return disabled('deposit_guest_refund_requires_review');
    for(const share of r.deposit_guest_allocation)amounts.set(share.guestIndex,(amounts.get(share.guestIndex)??0)+share.amountCents);}
  const eligible=guests.filter(g=>{
    const cancellation=cancellations.find(c=>c.guest_index===g.guestIndex);
    return cancellation?cancellation.late:h.whole_late;
  }).map(g=>({guestIndex:g.guestIndex,availableCents:amounts.get(g.guestIndex)??0})).filter(g=>g.availableCents>0);
  return {enabled:eligible.length>0,reason:eligible.length?null:'deposit_retention_no_eligible_balance',policyVersion:h.policy_snapshot.version,guests:eligible,
    policy:{cancelCutoffHours:h.policy_snapshot.cancelCutoffHours!,notice:h.policy_snapshot.cancellationPolicyNotice??''}};
}
