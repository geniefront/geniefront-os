import {largestRemainderSplit} from './split';
/** Integer financial operations. No external requests or database dependencies. */
/** cash/card/gift/credit/deposit: restore deposit service money, while tips return only to their original cash/card channels. */
export function allocateDepositServiceRefund(input:{paid:readonly number[];paidTips:readonly [number,number];refunded:readonly number[];
  refundedTipCents:number;amountCents:number;tipCents:number}):number[]{
  if(input.paid.length!==5||input.refunded.length!==5)throw new Error('Invalid deposit refund allocation');
  return allocateOriginalServiceRefund(input);
}
/** Original prepaid coverage is a return-to-source channel; only cash/card can restore tips. */
export function allocateOriginalServiceRefund(input:{paid:readonly number[];paidTips:readonly [number,number];refunded:readonly number[];
  refundedTipCents:number;amountCents:number;tipCents:number}):number[]{
  const {paid,paidTips,refunded,refundedTipCents,amountCents,tipCents}=input;
  if(paid.length<2||refunded.length!==paid.length||![...paid,...paidTips,...refunded,refundedTipCents,amountCents,tipCents].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||tipCents>amountCents||refundedTipCents+tipCents>paidTips[0]+paidTips[1])throw new Error('Invalid refund allocation');
  const priorTip=refundedTipCents?largestRemainderSplit(refundedTipCents,paidTips,{zeroWeights:'throw'}):[0,0];
  const nextTip=refundedTipCents+tipCents?largestRemainderSplit(refundedTipCents+tipCents,paidTips,{zeroWeights:'throw'}):[0,0];
  const remaining=paid.map((n,i)=>n-(i<2?paidTips[i]!:0)-refunded[i]!+(i<2?priorTip[i]!:0));
  const nonTip=amountCents-tipCents;
  if(remaining.some(n=>n<0)||nonTip>remaining.reduce((a,b)=>a+b,0))throw new Error('Refund exceeds original allocation');
  const allocation=nonTip?largestRemainderSplit(nonTip,remaining,{zeroWeights:'throw'}):paid.map(()=>0);
  allocation[0]!+=nextTip[0]!-priorTip[0]!;allocation[1]!+=nextTip[1]!-priorTip[1]!;
  return allocation;
}
/** The service subtotal excludes tips and tax. Round a percentage to the nearest cent, then cap at the subtotal. */
export function quoteAppointmentDeposit(serviceTotalCents:number,policy:{fixedAmountCents?:number;percentBps?:number}):number {
  if(!Number.isSafeInteger(serviceTotalCents)||serviceTotalCents<0||serviceTotalCents>1_000_000_000)throw new Error('Invalid service total');
  if((policy.fixedAmountCents===undefined)===(policy.percentBps===undefined))throw new Error('Choose exactly one deposit amount policy');
  if(policy.fixedAmountCents!==undefined){
    if(!Number.isSafeInteger(policy.fixedAmountCents)||policy.fixedAmountCents<=0||policy.fixedAmountCents>1_000_000_000)throw new Error('Invalid fixed deposit');
    return Math.min(serviceTotalCents,policy.fixedAmountCents);
  }
  if(!Number.isSafeInteger(policy.percentBps)||policy.percentBps!<=0||policy.percentBps!>10_000)throw new Error('Invalid deposit percentage');
  return Math.min(serviceTotalCents,Number((BigInt(serviceTotalCents)*BigInt(policy.percentBps!)+5_000n)/10_000n));
}
/** Collapse multi-staff execution rows before splitting a shared service, then allocate the deposit by those guest service values. */
export function allocateAppointmentDepositByGuest(partySize:number,items:readonly {groupKey:string;priceCents:number;guestIndices?:readonly number[]}[],amountCents:number){
  if(!Number.isInteger(partySize)||partySize<1||partySize>20||!Number.isSafeInteger(amountCents)||amountCents<0)throw new Error('Invalid guest allocation');
  const groups=new Map<string,{price:number;guests:number[]}>();let explicit=0;
  for(const item of items){
    if(!item.groupKey||!Number.isSafeInteger(item.priceCents)||item.priceCents<0)throw new Error('Invalid service allocation');
    const guests=item.guestIndices?[...item.guestIndices].sort((a,b)=>a-b):Array.from({length:partySize},(_,i)=>i);
    if(!guests.length||new Set(guests).size!==guests.length||guests.some(i=>!Number.isInteger(i)||i<0||i>=partySize))throw new Error('Invalid guest index');
    if(item.guestIndices)explicit++;
    const previous=groups.get(item.groupKey);
    if(previous&&JSON.stringify(previous.guests)!==JSON.stringify(guests))throw new Error('Inconsistent execution guests');
    groups.set(item.groupKey,{price:(previous?.price??0)+item.priceCents,guests});
  }
  const serviceValues=Array.from({length:partySize},()=>0);
  for(const group of groups.values())largestRemainderSplit(group.price,group.guests.map(()=>1)).forEach((n,i)=>{serviceValues[group.guests[i]!]!+=n;});
  const total=serviceValues.reduce((a,b)=>a+b,0);
  if(!Number.isSafeInteger(total)||total>1_000_000_000||amountCents>total)throw new Error('Deposit exceeds allocated services');
  const deposits=amountCents?largestRemainderSplit(amountCents,serviceValues,{zeroWeights:'throw'}):serviceValues.map(()=>0);
  return {method:explicit===items.length?'service_price':explicit===0?'equal_without_guest_mapping':'mixed_guest_mapping',
    guests:serviceValues.map((serviceTotalCents,guestIndex)=>({guestIndex,serviceTotalCents,amountCents:deposits[guestIndex]!}))};
}
export function giftPurchaseRefundLimit(paidCents:number, faceCents:number, remainingFaceCents:number):number {
  for(const n of [paidCents,faceCents,remainingFaceCents]) if(!Number.isSafeInteger(n)||n<0) throw new Error('Invalid money');
  if(faceCents === 0 || remainingFaceCents > faceCents) throw new Error('Invalid face value');
  return Number(BigInt(paidCents)*BigInt(remainingFaceCents)/BigInt(faceCents));
}
/** Split only the selected guests' remaining deposit; original indices fix the rounding order. */
export function allocateDepositRefundByGuest(balances:readonly {guestIndex:number;amountCents:number}[],amountCents:number,guestIndices?:readonly number[]){
  const ordered=[...balances].sort((a,b)=>a.guestIndex-b.guestIndex);
  if(!ordered.length||ordered.length>20||new Set(ordered.map(g=>g.guestIndex)).size!==ordered.length
    ||ordered.some(g=>!Number.isInteger(g.guestIndex)||g.guestIndex<0||g.guestIndex>=20||!Number.isSafeInteger(g.amountCents)||g.amountCents<0)
    ||!Number.isSafeInteger(amountCents)||amountCents<=0)throw new Error('Invalid deposit guest refund');
  if(guestIndices&&(!guestIndices.length||new Set(guestIndices).size!==guestIndices.length||guestIndices.some(i=>!ordered.some(g=>g.guestIndex===i))))throw new Error('Invalid refund guests');
  const selected=ordered.filter(g=>!guestIndices||guestIndices.includes(g.guestIndex));
  const total=selected.reduce((n,g)=>n+g.amountCents,0);
  if(!Number.isSafeInteger(total)||total>1_000_000_000||amountCents>total)throw new Error('Refund exceeds selected guest deposit');
  const shares=largestRemainderSplit(amountCents,selected.map(g=>g.amountCents),{zeroWeights:'throw'});
  return selected.flatMap((g,i)=>shares[i]!>0?[{guestIndex:g.guestIndex,amountCents:shares[i]!}]:[]);
}
export function giftFaceForRefund(amountCents:number, paidCents:number, faceCents:number):number {
  if(!Number.isSafeInteger(amountCents)||amountCents<=0||paidCents<=0||faceCents<=0) throw new Error('Invalid refund');
  const integral=(BigInt(amountCents)*BigInt(faceCents)+BigInt(paidCents)-1n)/BigInt(paidCents);
  return Number(integral);
}
/** Difference of cumulative allocations fixes remainder order across consumption and refunds. */
export function packageUnitValue(paidCents:number,total:number,consumed:number,units:number):number {
  if(![paidCents,total,consumed,units].every(Number.isSafeInteger)||paidCents<0||total<=0||consumed<0||units<0||consumed+units>total) throw new Error('Invalid quantity');
  return Number(BigInt(paidCents)*BigInt(consumed+units)/BigInt(total)-BigInt(paidCents)*BigInt(consumed)/BigInt(total));
}
export function packageRefundUnits(paidCents:number,total:number,remaining:number,amountCents:number):number {
  if(amountCents<=0||remaining<0||remaining>total) throw new Error('Invalid refund');
  let low=1,high=remaining;
  while(low<high){const middle=low+Math.floor((high-low)/2);
    if(packageUnitValue(paidCents,total,total-remaining,middle)<amountCents)low=middle+1;
    else high=middle;
  }
  if(remaining>0&&packageUnitValue(paidCents,total,total-remaining,low)===amountCents)return low;
  throw new Error('Refund must equal the allocated value of whole unused sessions');
}
export function commerceFingerprint(value:unknown):string {
  // Return canonical JSON; cryptographic hashing belongs to the server.
  if(value===null||typeof value!=='object') return JSON.stringify(value) ?? 'null';
  if(Array.isArray(value))return `[${value.map(commerceFingerprint).join(',')}]`;
  const object=value as Record<string,unknown>;
  return `{${Object.keys(object).filter(k=>object[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${commerceFingerprint(object[k])}`).join(',')}}`;
}

export type PackageUnitRange=readonly [number,number];
export function parsePackageUnitRanges(raw:string,total:number):PackageUnitRange[] {
  if(raw==='{}')return [];
  const segments=raw.match(/\[\d+,\d+\)/g)??[];
  if(`{${segments.join(',')}}`!==raw)throw new Error('Invalid unit ranges');
  const ranges=segments.map(s=>s.slice(1,-1).split(',').map(Number) as [number,number]);
  let end=0;
  for(const [from,to] of ranges){if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<end||to<=from||to>total)throw new Error('Invalid unit ranges');end=to;}
  return ranges;
}
export function formatPackageUnitRanges(ranges:readonly PackageUnitRange[]):string {return `{${ranges.map(([a,b])=>`[${a},${b})`).join(',')}}`;}
export function packageRangeCount(ranges:readonly PackageUnitRange[]):number {return ranges.reduce((n,[a,b])=>n+b-a,0);}
export function packageRangeValue(price:number,total:number,ranges:readonly PackageUnitRange[]):number {
  return ranges.reduce((n,[a,b])=>n+packageUnitValue(price,total,a,b-a),0);
}
export function takePackageUnits(price:number,total:number,ranges:readonly PackageUnitRange[],quantity:number){
  if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>packageRangeCount(ranges))throw new Error('Insufficient units');
  let left=quantity;const taken:PackageUnitRange[]=[],remaining:PackageUnitRange[]=[];
  for(const [a,b] of ranges){const count=Math.min(left,b-a);if(count)taken.push([a,a+count]);if(a+count<b)remaining.push([a+count,b]);left-=count;}
  return {taken,remaining,valueCents:packageRangeValue(price,total,taken)};
}
export function refundPackageUnits(price:number,total:number,ranges:readonly PackageUnitRange[],amountCents:number){
  if(!Number.isSafeInteger(amountCents)||amountCents<=0)throw new Error('Invalid refund');
  let low=1,high=packageRangeCount(ranges);
  while(low<high){const middle=low+Math.floor((high-low)/2);
    if(takePackageUnits(price,total,ranges,middle).valueCents<amountCents)low=middle+1;else high=middle;}
  const allocation=takePackageUnits(price,total,ranges,low);
  if(allocation.valueCents!==amountCents)throw new Error('Refund requires whole unused units');
  return allocation;
}
export function restorePackageUnits(available:readonly PackageUnitRange[],returned:readonly PackageUnitRange[]):PackageUnitRange[]{
  const all=[...available,...returned].sort((a,b)=>a[0]-b[0]);const merged:PackageUnitRange[]=[];
  for(const range of all){const last=merged.at(-1);if(last&&range[0]<last[1])throw new Error('Units already available');
    if(last&&range[0]===last[1])merged[merged.length-1]=[last[0],range[1]];else merged.push(range);}
  return merged;
}
