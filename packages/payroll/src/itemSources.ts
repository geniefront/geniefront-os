import {largestRemainderSplit} from './split';
export type ItemComponents={serviceCents:number;taxCents:number;feeCents:number};
const components=['serviceCents','taxCents','feeCents'] as const;
const returned=['returnedServiceCents','returnedTaxCents','returnedFeeCents'] as const;
const cents=(n:number)=>Number.isSafeInteger(n)&&n>=0;
/** Allocate columns against remaining row capacity. Both margins remain exact, including cent remainders. */
export function balancedComponentAllocation(rowCents:readonly number[],sourceCents:readonly number[]){
 if(![...rowCents,...sourceCents].every(cents)||rowCents.reduce((n,v)=>n+v,0)!==sourceCents.reduce((n,v)=>n+v,0))throw new Error('item_source_margins_mismatch');
 const remaining=[...rowCents];
 return sourceCents.map(amount=>{const parts=amount?largestRemainderSplit(amount,remaining,{zeroWeights:'throw'}):remaining.map(()=>0);parts.forEach((v,i)=>{remaining[i]!-=v;});return parts;});
}
export interface ItemSourceBalance extends ItemComponents{id:string;sourceId:string;itemId:string;returnedServiceCents:number;returnedTaxCents:number;returnedFeeCents:number;}
export type ItemSourceReturn=ItemComponents&{allocationId:string;sourceId:string;itemId:string};
function checkedCells(input:readonly ItemSourceBalance[]){
 const rows=[...input].sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>components.some((key,i)=>!cents(r[key])||!cents(r[returned[i]!]!)||r[returned[i]!]!>r[key])))throw new Error('invalid_item_source_balance');
 return rows;
}
function distribute(rows:ItemSourceBalance[],targets:ItemComponents,out:Map<string,ItemSourceReturn>){
 for(const [index,key] of components.entries()){
  const weights=rows.map(r=>r[key]-r[returned[index]!]!);if(!cents(targets[key])||targets[key]>weights.reduce((n,v)=>n+v,0))throw new Error('item_refund_exceeds_original');
  const shares=targets[key]?largestRemainderSplit(targets[key],weights,{zeroWeights:'throw'}):weights.map(()=>0);
  rows.forEach((r,i)=>{const result=out.get(r.id)??{allocationId:r.id,sourceId:r.sourceId,itemId:r.itemId,serviceCents:0,taxCents:0,feeCents:0};result[key]+=shares[i]!;out.set(r.id,result);});
 }
}
/** Amount-only compatibility returns follow each frozen original source column. */
export function allocateSourceItemReturns(input:readonly ItemSourceBalance[],slices:readonly (ItemComponents&{sourceId:string})[]){
 const rows=checkedCells(input),out=new Map<string,ItemSourceReturn>();
 if(new Set(slices.map(s=>s.sourceId)).size!==slices.length)throw new Error('duplicate_source_return');
 for(const slice of slices)distribute(rows.filter(r=>r.sourceId===slice.sourceId),slice,out);
 return [...out.values()].filter(r=>components.some(k=>r[k]>0));
}
/** Selected execution items keep their original service, tax and fee capacities; never re-price the current catalog. */
export function allocateSelectedItemReturns(input:readonly ItemSourceBalance[],selections:readonly {itemId:string;amountCents:number}[]){
 const rows=checkedCells(input),out=new Map<string,ItemSourceReturn>();
 if(!selections.length||new Set(selections.map(s=>s.itemId)).size!==selections.length)throw new Error('invalid_refund_items');
 for(const selection of selections){
  const itemRows=rows.filter(r=>r.itemId===selection.itemId);if(!itemRows.length||!cents(selection.amountCents)||selection.amountCents===0)throw new Error('invalid_refund_items');
  let remaining=selection.amountCents;const target:ItemComponents={serviceCents:0,taxCents:0,feeCents:0};
  for(const [index,key] of components.entries()){target[key]=Math.min(remaining,itemRows.reduce((n,r)=>n+r[key]-r[returned[index]!]!,0));remaining-=target[key];}
  if(remaining)throw new Error('item_refund_exceeds_original');distribute(itemRows,target,out);
 }
 return [...out.values()].filter(r=>components.some(k=>r[k]>0));
}
export interface ItemCommissionBalance{id:string;itemId:string;membershipId:string;baseCents:number;amountCents:number;returnedBaseCents:number;returnedAmountCents:number;}
export interface ReturnedItemCoverage{itemId:string;serviceCents:number;returnedServiceCents:number;}
const targetValue=(value:number,used:number,total:number)=>total===0?0:Number((BigInt(value)*BigInt(used)+BigInt(total)/2n)/BigInt(total));
/** Item coverage drives its original funded commission. Incremental bounded splits avoid negative rounding corrections. */
export function allocateItemCommissionReturns(input:readonly ItemCommissionBalance[],coverages:readonly ReturnedItemCoverage[]){
 const rows=[...input].sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>![r.baseCents,r.amountCents,r.returnedBaseCents,r.returnedAmountCents].every(cents)||r.returnedBaseCents>r.baseCents||r.returnedAmountCents>r.amountCents))throw new Error('invalid_item_commission_balance');
 if(new Set(coverages.map(c=>c.itemId)).size!==coverages.length||coverages.some(c=>!cents(c.serviceCents)||!cents(c.returnedServiceCents)||c.returnedServiceCents>c.serviceCents))throw new Error('invalid_returned_item_coverage');
 const results:Array<{commissionSourceId:string;itemId:string;membershipId:string;baseCents:number;amountCents:number}>=[];
 for(const coverage of coverages){
  const itemRows=rows.filter(r=>r.itemId===coverage.itemId);if(!itemRows.length)continue;
  const deltas=(['baseCents','amountCents'] as const).map((key,i)=>{const prior=i===0?'returnedBaseCents':'returnedAmountCents';
   const delta=targetValue(itemRows.reduce((n,r)=>n+r[key],0),coverage.returnedServiceCents,coverage.serviceCents)-itemRows.reduce((n,r)=>n+r[prior],0);
   if(delta<0)throw new Error('historical_item_commission_needs_review');const weights=itemRows.map(r=>r[key]-r[prior]);return delta?largestRemainderSplit(delta,weights,{zeroWeights:'throw'}):weights.map(()=>0);});
  itemRows.forEach((r,i)=>{if(deltas[0]![i]!||deltas[1]![i]!)results.push({commissionSourceId:r.id,itemId:r.itemId,membershipId:r.membershipId,baseCents:deltas[0]![i]!,amountCents:deltas[1]![i]!});});
 }
 if(rows.some(r=>!coverages.some(c=>c.itemId===r.itemId)))throw new Error('item_commission_coverage_missing');
 return results;
}
