import type {Tx} from '../commerce/model';
/** Refunds of an obsolete request must never confirm or cancel the replacement booking. */
export async function refreshDepositFinancialState(tx:Tx,holdId:string):Promise<string>{
 const [h]=await tx<{appointment_id:string;status:string;waived_at:string|null;has_confirmed_booking:boolean;commerce_frozen:boolean;
  reserved_cents:number;appointment_status:string;balance:number;applied:number;retained:number;current_required:number}[]>`
  select h.*,a.status as appointment_status,
   coalesce((select required_cents from commerce_deposit_requotes where hold_id=h.id order by revision desc limit 1),h.amount_cents) as current_required,
   (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance,
   (select -coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id and entry in('applied','restored')) as applied,
   (select -coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id and entry in('retained','retention_released')) as retained
  from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${holdId} for update of h`;
 if(!h)throw new Error('Deposit hold missing');
 const status=h.commerce_frozen?'review':!h.waived_at&&!h.has_confirmed_booking&&h.appointment_status==='booked'?'pending':
  h.reserved_cents>0?'refund_pending':h.waived_at?(h.balance>0?'review':h.status==='waived'?'waived':'refunded'):
  !h.has_confirmed_booking&&['expired','cancelled'].includes(h.status)&&h.balance===0?h.status:
  h.balance===0&&h.applied===0?(h.retained>0?'retained':h.current_required===0&&h.has_confirmed_booking?'not_required':'refunded'):
  ['cancelled','no_show'].includes(h.appointment_status)?'review':'paid';
 await tx`update commerce_appointment_holds set status=${status},updated_at=now() where id=${holdId}`;
 await tx`update appointments set deposit_status=${h.waived_at?'waived':status} where id=${h.appointment_id}`;
 return status;
}
