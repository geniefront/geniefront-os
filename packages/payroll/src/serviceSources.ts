import {largestRemainderSplit} from './split';
export type SettlementSourceKind='cash'|'card'|'external'|'gift_card'|'store_credit'|'deposit'|'membership'|'package';
export interface RefundSourceBalance{id:string;kind:SettlementSourceKind;amountCents:number;tipCents:number;returnedCents:number;returnedTipCents:number;serviceCents?:number;taxCents?:number;feeCents?:number;returnedServiceCents?:number;returnedTaxCents?:number;returnedFeeCents?:number;}
export function allocateSourceRefund(sources:readonly RefundSourceBalance[],amount:number,tip:number,method:'original_payment'|'cash'|'store_credit',components?:{serviceCents:number;taxCents:number;feeCents:number}){
 const rows=[...sources].sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(rows.map(s=>s.id)).size!==rows.length||![amount,tip].every(n=>Number.isSafeInteger(n)&&n>=0)||tip>amount||amount===0)throw new Error('invalid_source_refund');
 for(const s of rows)if(![s.amountCents,s.tipCents,s.returnedCents,s.returnedTipCents].every(n=>Number.isSafeInteger(n)&&n>=0)
  ||s.tipCents>s.amountCents||s.returnedTipCents>s.returnedCents||s.returnedTipCents>s.tipCents||s.returnedCents-s.returnedTipCents>s.amountCents-s.tipCents
  ||s.tipCents>0&&!['cash','card','external'].includes(s.kind))throw new Error('invalid_source_balance');
 const tipParts=rows.map(()=>0);
 const cash=rows.filter(s=>s.kind==='cash'),card=rows.filter(s=>s.kind==='card'||s.kind==='external'),priorTip=rows.reduce((n,s)=>n+s.returnedTipCents,0);
 const groups=[cash,card],groupPaid=groups.map(g=>g.reduce((n,s)=>n+s.tipCents,0));
 if(tip>groupPaid.reduce((n,v)=>n+v,0)-priorTip)throw new Error('source_refund_exceeds_remaining');
 if(tip){const totals=largestRemainderSplit(priorTip+tip,groupPaid,{zeroWeights:'throw'});
  for(const [g,group] of groups.entries()){if(!group.length)continue;const targets=largestRemainderSplit(totals[g]!,group.map(s=>s.tipCents));
   for(const [i,s] of group.entries()){const delta=targets[i]!-s.returnedTipCents;if(delta<0)throw new Error('historical_tip_sources_need_review');tipParts[rows.indexOf(s)]=delta;}}
 }
 const target=components??{serviceCents:amount-tip,taxCents:0,feeCents:0};
 if(!Object.values(target).every(n=>Number.isSafeInteger(n)&&n>=0)||target.serviceCents+target.taxCents+target.feeCents!==amount-tip)throw new Error('invalid_refund_components');
 const values=['serviceCents','taxCents','feeCents'] as const,returned=['returnedServiceCents','returnedTaxCents','returnedFeeCents'] as const;
 const parts=values.map((key,index)=>{const weights=rows.map(s=>(s[key]??(index===0?s.amountCents-s.tipCents:0))-(s[returned[index]!]??(index===0?s.returnedCents-s.returnedTipCents:0)));
  const total=target[key];if(weights.some(n=>n<0)||total>weights.reduce((n,v)=>n+v,0))throw new Error('source_refund_exceeds_remaining');return total?largestRemainderSplit(total,weights,{zeroWeights:'throw'}):rows.map(()=>0);});
 if(method!=='original_payment'&&rows.some((s,i)=>!['cash','card','external'].includes(s.kind)&&parts[0]![i]!+parts[1]![i]!+parts[2]![i]!>0))throw new Error('prepaid_refund_requires_original_method');
 return rows.map((s,i)=>({sourceId:s.id,kind:s.kind,amountCents:parts[0]![i]!+parts[1]![i]!+parts[2]![i]!+tipParts[i]!,tipCents:tipParts[i]!,serviceCents:parts[0]![i]!,taxCents:parts[1]![i]!,feeCents:parts[2]![i]!,
  destination:method==='cash'?'cash':method==='store_credit'?'store_credit':s.kind==='external'?'card':s.kind})).filter(s=>s.amountCents>0);
}
