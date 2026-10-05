import type {Tx,Ctx} from './model';
import {depositPaymentSources} from './depositSources';
export interface DepositGuestBalance{guestIndex:number;serviceTotalCents:number;amountCents:number;availableCents:number;refundStatus:string|null;}
/** Aggregate only proven original-payment guest shares; unknown multi-guest history remains unknown. */
export async function depositGuestBalances(tx:Tx,ctx:Pick<Ctx,'locationId'>,holdId:string):Promise<DepositGuestBalance[]|null>{
 const sources=await depositPaymentSources(tx,ctx,holdId),paid=sources.filter(s=>s.requestState==='paid');
 if(!paid.length)return null;
 if(paid.some(s=>!s.guests))return null;
 const result=new Map<number,DepositGuestBalance>();
 for(const source of paid)for(const guest of source.guests!){
  const row=result.get(guest.guestIndex)??{guestIndex:guest.guestIndex,serviceTotalCents:0,amountCents:0,availableCents:0,refundStatus:null};
  // Service totals describe the latest paid contract for that guest, not the sum of repeated supplementary quotes.
  row.serviceTotalCents=Math.max(row.serviceTotalCents,guest.serviceTotalCents);row.amountCents+=guest.amountCents;
  if(source.status==='paid')row.availableCents+=guest.availableCents;
  if(guest.refundStatus==='review'||row.refundStatus!=='review'&&guest.refundStatus==='pending'||!row.refundStatus)row.refundStatus=guest.refundStatus;
  result.set(guest.guestIndex,row);
 }
 return [...result.values()].sort((a,b)=>a.guestIndex-b.guestIndex);
}
/** A service execution may include several guests; it must be cancelled as a complete unit. */
export function appointmentItemGuestIndices(details:Record<string,unknown>):number[]|null{
  const values=Array.isArray(details.publicGuestIndices)?details.publicGuestIndices:Number.isInteger(details.publicGuestIndex)?[details.publicGuestIndex]:null;
  if(!values||!values.length||new Set(values).size!==values.length||values.some(i=>!Number.isInteger(i)||Number(i)<0||Number(i)>=20))return null;
  return values.map(Number).sort((a,b)=>a-b);
}
