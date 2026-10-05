import {largestRemainderSplit} from './split';

/** Percentage benefits round once per service line, using integers even at the money limit. */
export function membershipLineDiscountCents(totalCents:number,bps:number):number{
  if(!Number.isSafeInteger(totalCents)||totalCents<0||!Number.isInteger(bps)||bps<0||bps>10000)throw new Error('Invalid membership price');
  const discount=(BigInt(totalCents)*BigInt(bps)+5000n)/10000n;
  return parseInt(discount.toString(),10);
}
export type PriceAdjustment={ticketItemId:string;kind:'manual'|'membership';originalCents:number;discountCents:number};
/** One price benefit per uncovered line. Authorized manual discounts use only the other lines. */
export function allocateCheckoutPriceDiscounts(args:{items:readonly {id:string;totalCents:number}[];coveredItemIds:ReadonlySet<string>;
  membershipDiscounts:ReadonlyMap<string,number>;manualDiscountCents:number}):PriceAdjustment[]{
  const {items,coveredItemIds,membershipDiscounts,manualDiscountCents}=args;
  if(new Set(items.map(i=>i.id)).size!==items.length||!Number.isSafeInteger(manualDiscountCents)||manualDiscountCents<0
    ||items.some(i=>!Number.isSafeInteger(i.totalCents)||i.totalCents<0))throw new Error('Invalid checkout prices');
  const result:PriceAdjustment[]=[];
  for(const [id,discount] of membershipDiscounts){const item=items.find(i=>i.id===id);
    if(!item||coveredItemIds.has(id)||!Number.isSafeInteger(discount)||discount<=0||discount>item.totalCents)throw new Error('Overlapping membership price');
  }
  const eligible=items.filter(i=>!coveredItemIds.has(i.id)&&!membershipDiscounts.has(i.id));
  const capacity=eligible.reduce((sum,i)=>sum+i.totalCents,0);
  if(manualDiscountCents>capacity)throw new Error('Manual discount exceeds remaining unpriced services');
  const shares=manualDiscountCents>0?largestRemainderSplit(manualDiscountCents,eligible.map(i=>i.totalCents),{zeroWeights:'throw'}):eligible.map(()=>0);
  const manual=new Map(eligible.map((i,index)=>[i.id,shares[index]!]));
  for(const item of items){const member=membershipDiscounts.get(item.id),discount=member??manual.get(item.id)??0;
    if(discount>0)result.push({ticketItemId:item.id,kind:member===undefined?'manual':'membership',originalCents:item.totalCents,discountCents:discount});
  }
  return result;
}
