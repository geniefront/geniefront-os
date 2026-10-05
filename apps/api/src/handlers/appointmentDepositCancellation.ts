import type {HandlerArgs} from '../bus';
import {requestRefundInTransaction} from './commerce';
import {closeDepositRequests} from './appointmentDepositAdjustments';
import {depositPaymentSources,allocateDepositSources} from '../commerce/depositSources';

/** Caller owns the appointment capacity lock and has authorized the cancellation. No SDK call occurs in this transaction. */
export async function cancelAppointmentDepositInTransaction(args:HandlerArgs<unknown>,appointmentId:string,reason:string):Promise<void>{
  const {tx,ctx,audit}=args;
  const [h]=await tx<{id:string;order_id:string|null;status:string;reserved_cents:number;commerce_frozen:boolean;policy_snapshot:Record<string,unknown>;
    starts_at:string;before_cutoff:boolean;balance:number}[]>`select h.*,a.starts_at::text,
    case when jsonb_typeof(h.policy_snapshot->'cancelCutoffHours')='number'
      then a.starts_at>=now()+(h.policy_snapshot->>'cancelCutoffHours')::numeric*interval '1 hour' else false end as before_cutoff,
    (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id
    where h.appointment_id=${appointmentId} and h.location_id=${ctx.locationId} for update of h`;
  if(!h)return;
  await closeDepositRequests(tx,ctx,h.id,'cancelled');
  if(['pending','cancelled'].includes(h.status))return;
  if(h.reserved_cents>0)await tx`update appointments set deposit_status='refund_pending' where id=${appointmentId}`;
  if(h.balance-h.reserved_cents<=0||h.commerce_frozen||h.status==='refunded')return;
  if(h.before_cutoff&&reason!=='no_show'&&['paid','refund_pending'].includes(h.status)){
    const sources=await depositPaymentSources(tx,ctx,h.id),available=sources.reduce((n,p)=>n+p.availableCents,0);
    if(!available)return;
    for(const source of allocateDepositSources(sources,available))await requestRefundInTransaction({...args,input:{paymentId:source.paymentId,amountCents:source.amountCents,
      reason:'appointment_cancelled_before_purchase_policy_cutoff'}});
    await tx`update appointments set deposit_status='refund_pending' where id=${appointmentId}`;
  }else{
    // Funds remain unused and refundable by an authorized employee; no forfeiture or fabricated refund.
    await tx`update commerce_appointment_holds set status='review',updated_at=now() where id=${h.id}`;
    await tx`update appointments set deposit_status='review' where id=${appointmentId}`;
    audit({entityType:'appointment_deposit_hold',entityId:h.id,after:{status:'review',reason:'cancellation_requires_frontdesk_review'}});
  }
}
