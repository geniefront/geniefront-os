import {depositAdjustmentText,type DepositAdjustmentQuote} from '@gf/contracts';
export function DepositAdjustmentReview({quote,language,accepted,onAccepted,disabled=false,staff=true}:{quote:DepositAdjustmentQuote;language:string;accepted:boolean;onAccepted:(value:boolean)=>void;disabled?:boolean;staff?:boolean}){
 const text=(key:Parameters<typeof depositAdjustmentText>[1])=>depositAdjustmentText(language,key);
 const money=(n:number)=>new Intl.NumberFormat(language,{style:'currency',currency:quote.currency}).format(n/100);
 return <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/50 p-3" aria-label={text('title')}>
  <h3 className="font-semibold">{text('title')}</h3>
  <dl className="space-y-2 text-sm">{(['serviceTotal','required','available','request','excess'] as const).map((key,i)=><div key={key} className="flex justify-between gap-3">
   <dt>{text(key)}</dt><dd className="shrink-0 font-mono">{money([quote.serviceTotalCents,quote.requiredCents,quote.availableCents,quote.requestCents,quote.excessCents][i]!)}</dd></div>)}</dl>
  {quote.requestCents>0&&<p className="text-sm">{text(quote.hasConfirmedBooking?'supplementNotice':'replaceNotice')}</p>}
  {quote.excessCents>0&&<p className="text-sm">{text('refundNotice')}</p>}
  <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={accepted} disabled={disabled} onChange={e=>onAccepted(e.target.checked)}/>
   <span>{text(staff?'staffAccept':'accept')}</span></label>
 </section>;
}
