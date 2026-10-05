import {AppError,ERROR_CODES} from '@gf/contracts';
import {allocateDepositRefundByGuest} from '@gf/payroll';
import type {Tx,Ctx} from './model';

export interface DepositSourceGuest {guestIndex:number;amountCents:number;serviceTotalCents:number;availableCents:number;refundStatus:string|null;}
export interface DepositPaymentSource {paymentId:string;orderId:string;requestState:string;status:string;amountCents:number;currency:string;
 balanceCents:number;reservedCents:number;availableCents:number;guests:DepositSourceGuest[]|null;}
const invalid=(reason:string):never=>{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});};
/** Each collection retains its own cash and guest provenance. Never use another payment's unused money to authorize a refund. */
export async function depositPaymentSources(tx:Tx,ctx:Pick<Ctx,'locationId'>,holdId:string):Promise<DepositPaymentSource[]>{
 const rows=await tx<{payment_id:string;order_id:string;request_state:string;status:string;amount_cents:number;currency:string;balance:number;reserved:number;
  policy:{guestAllocation?:{guests?:Array<{guestIndex:number;amountCents:number;serviceTotalCents:number}>}}}[]>`
  select p.id as payment_id,p.order_id,r.state as request_state,p.status,p.amount_cents,p.currency,
   (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger l where l.hold_id=r.hold_id and l.payment_id=p.id) as balance,
   (select coalesce(sum(asset_quantity),0)::int from commerce_refunds f where f.payment_id=p.id and f.status in('pending','review')) as reserved,
   o.snapshot->'depositPolicy' as policy
  from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id join commerce_orders o on o.id=r.order_id
  where r.hold_id=${holdId} and r.location_id=${ctx.locationId} order by p.created_at,p.id`;
 const ledger=await tx<{payment_id:string;entry:string;amount_cents:number;guest_allocation:Array<{guestIndex:number;amountCents:number}>|null}[]>`
  select payment_id,entry,amount_cents,guest_allocation from commerce_deposit_ledger where hold_id=${holdId} order by created_at,id`;
 const refunds=await tx<{payment_id:string;status:string;amount_cents:number;deposit_guest_allocation:Array<{guestIndex:number;amountCents:number}>|null}[]>`
  select f.payment_id,f.status,f.amount_cents,f.deposit_guest_allocation from commerce_refunds f join commerce_payments p on p.id=f.payment_id
   join commerce_deposit_requests r on r.order_id=p.order_id where r.hold_id=${holdId} and f.status in('pending','review','succeeded') order by f.created_at,f.id`;
 return rows.map(row=>{
  const uses=ledger.filter(l=>l.payment_id===row.payment_id),collection=uses.find(l=>l.entry==='collected');
  const original=row.policy?.guestAllocation?.guests;
  let guests:DepositSourceGuest[]|null=null;
  if(collection&&Array.isArray(original)&&original.length>0&&original.length<=20&&new Set(original.map(g=>g.guestIndex)).size===original.length
   &&original.every(g=>Number.isInteger(g.guestIndex)&&g.guestIndex>=0&&g.guestIndex<20&&[g.amountCents,g.serviceTotalCents].every(n=>Number.isSafeInteger(n)&&n>=0))
   &&original.reduce((n,g)=>n+g.amountCents,0)===row.amount_cents){
   guests=original.map(g=>({...g,availableCents:g.amountCents,refundStatus:null}));
   for(const use of uses.filter(l=>!['collected','refund'].includes(l.entry))){
    const shares=use.guest_allocation??(guests.length===1?[{guestIndex:guests[0]!.guestIndex,amountCents:Math.abs(use.amount_cents)}]:null);
    if(!shares){guests=null;break;}
    for(const share of shares){const guest=guests.find(g=>g.guestIndex===share.guestIndex);if(!guest){guests=null;break;}
     guest.availableCents+=(use.amount_cents>0?1:-1)*share.amountCents;if(use.entry==='retained')guest.refundStatus='retained';}
    if(!guests)break;
   }
   if(guests)for(const refund of refunds.filter(f=>f.payment_id===row.payment_id)){
    if(!refund.deposit_guest_allocation){guests=null;break;}
    for(const share of refund.deposit_guest_allocation){const guest=guests.find(g=>g.guestIndex===share.guestIndex);if(!guest){guests=null;break;}
     guest.availableCents-=share.amountCents;
     if(refund.status==='review'||guest.refundStatus!=='review'&&refund.status==='pending'||!guest.refundStatus)guest.refundStatus=refund.status;}
    if(!guests)break;
   }
   if(guests?.some(g=>g.availableCents<0||g.availableCents>g.amountCents))guests=null;
  }
  const availableCents=row.status==='paid'&&row.request_state==='paid'?Math.max(0,row.balance-row.reserved):0;
  return {paymentId:row.payment_id,orderId:row.order_id,requestState:row.request_state,status:row.status,amountCents:row.amount_cents,currency:row.currency,
   balanceCents:row.balance,reservedCents:row.reserved,availableCents,guests};
 });
}
export interface DepositSourceAllocation {paymentId:string;orderId:string;amountCents:number;guestAllocation:Array<{guestIndex:number;amountCents:number}>|null;}
/** Deterministic original-payment order, followed by deterministic allocation within that payment's guests. */
export function allocateDepositSources(sources:readonly DepositPaymentSource[],amountCents:number,guestIndices?:readonly number[],
 exactGuests?:readonly {guestIndex:number;amountCents:number}[]):DepositSourceAllocation[]{
 if(!Number.isSafeInteger(amountCents)||amountCents<=0)invalid('invalid_deposit_allocation');
 const pendingGuests=exactGuests?new Map(exactGuests.map(g=>[g.guestIndex,g.amountCents])):null;
 if(pendingGuests&&(pendingGuests.size!==exactGuests!.length||[...pendingGuests.values()].some(v=>!Number.isSafeInteger(v)||v<0)
  ||[...pendingGuests.values()].reduce((n,v)=>n+v,0)!==amountCents))invalid('invalid_deposit_guest_allocation');
 let remaining=amountCents;const result:DepositSourceAllocation[]=[];
 for(const source of sources){
  if(!remaining)break;if(source.availableCents<=0)continue;
  if((guestIndices||pendingGuests)&&!source.guests)invalid('deposit_guest_refund_requires_review');
  const eligible=source.guests?.filter(g=>!guestIndices||guestIndices.includes(g.guestIndex));
  const available=pendingGuests?eligible!.reduce((n,g)=>n+Math.min(g.availableCents,pendingGuests.get(g.guestIndex)??0),0):
   guestIndices?eligible!.reduce((n,g)=>n+g.availableCents,0):source.availableCents;
  const amount=Math.min(remaining,source.availableCents,available);if(!amount)continue;
  const guests=eligible?allocateDepositRefundByGuest(eligible.map(g=>({guestIndex:g.guestIndex,
   amountCents:pendingGuests?Math.min(g.availableCents,pendingGuests.get(g.guestIndex)??0):g.availableCents})),amount):null;
  if(pendingGuests)for(const guest of guests??[])pendingGuests.set(guest.guestIndex,(pendingGuests.get(guest.guestIndex)??0)-guest.amountCents);
  result.push({paymentId:source.paymentId,orderId:source.orderId,amountCents:amount,guestAllocation:guests});remaining-=amount;
 }
 if(remaining)invalid(guestIndices?'refund_exceeds_selected_guest_deposit':'deposit_exceeds_available_balance');
 return result;
}
