import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {commerceText,type CommerceTextKey} from '@gf/contracts';
import {apiGet,runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {useAttemptKey} from '@/lib/idempotency';
import {Card,CardContent} from '@/components/ui/Card';
import {Button} from '@/components/ui/Button';
export interface PayoutData{
 payouts:Array<{id:string;amount_cents:number;currency:string;automatic:boolean;livemode:boolean;provider_created_at:string;business_date:string;
  status:string;arrival_at:string;failure_code:string|null;source_count:number|null;source_net_cents:number|null;debit_net_cents:number;returned_net_cents:number;debit_verified:boolean;return_verified:boolean}>;
 sources:Array<{payout_id:string;gross_cents:number;fee_cents:number;net_cents:number;currency:string;type:string;purchase_kind:string|null;payment_id:string|null;refund_id:string|null}>;
}
export function CommercePayouts({language}:{language:string}){
 const {membershipId,can,isOnline,context}=useSession(),attempt=useAttemptKey(),[busy,setBusy]=useState(false),[notice,setNotice]=useState<CommerceTextKey|null>(null);
 const allowed=can('report.view')&&can('commerce.read'),text=(key:CommerceTextKey)=>commerceText(language,key);
 const query=useQuery({queryKey:['desk','commerce-payouts',membershipId],queryFn:()=>apiGet<PayoutData>('/v1/desk/commerce/payouts'),enabled:!!membershipId&&allowed,refetchInterval:10000});
 const money=(cents:number,currency:string)=>new Intl.NumberFormat(language,{style:'currency',currency}).format(cents/100);
 const date=(value:string,calendar=false)=>new Intl.DateTimeFormat(language,{timeZone:calendar?'UTC':context?.timezone??'UTC',dateStyle:'medium',...(calendar?{}:{timeStyle:'short' as const})}).format(new Date(value));
 async function refresh(){if(!membershipId||!isOnline||busy||!can('commerce.configure'))return;const intent=['payout-refresh',membershipId];setBusy(true);setNotice(null);
  try{await runCommand('commerce.refreshPayouts',{},membershipId,attempt.take(intent));attempt.settle(intent);setNotice('payoutQueued');await query.refetch();}
  catch{setNotice('error');}finally{setBusy(false);}}
 if(!allowed)return null;
 const statusKey=(status:string):CommerceTextKey=>status==='paid'?'payoutPaid':status==='failed'?'payoutFailed':status==='canceled'?'payoutCanceled':status==='in_transit'?'payoutInTransit':'payoutPending';
 return <Card><CardContent className="space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{text('payouts')}</h2>
  {can('commerce.configure')?<Button variant="outline" disabled={!isOnline||busy} onPress={()=>void refresh()}>{text('payoutRefresh')}</Button>:null}</div>
  <p className="text-sm text-slate-600">{text('payoutAccountScope')}</p>{notice?<p role="status">{text(notice)}</p>:null}{query.error?<p role="alert">{text('error')}</p>:null}
  {query.data&&!query.data.payouts.length?<p className="text-sm">{text('empty')}</p>:null}
  {query.data?.payouts.map(p=><article key={p.id} className="space-y-2 rounded-xl border p-4 text-sm">
   <h3 className="font-semibold">{money(p.amount_cents,p.currency)} · {text(p.automatic?'payoutAutomatic':'payoutManual')}</h3>
   <p>{text(statusKey(p.status))} · {text(p.livemode?'liveMode':'testMode')}</p><p>{date(p.provider_created_at)}</p><p>{text('payoutArrival')}: {date(p.arrival_at,true)}</p>
   {p.debit_verified?<p>{text('payoutDebit')}: {money(p.debit_net_cents,p.currency)}</p>:null}{p.return_verified?<p>{text('payoutReturned')}: {money(p.returned_net_cents,p.currency)}</p>:null}
   {p.status==='paid'?<p className="text-slate-600">{text('payoutPaidHint')}</p>:null}
   {p.automatic?<p>{text(p.source_count!==null?'payoutBatchComplete':'payoutBatchPending')}{p.source_count!==null?` · ${p.source_count} · ${money(p.source_net_cents??0,p.currency)}`:''}</p>:<p className="text-slate-600">{text('payoutManualSources')}</p>}
   {query.data.sources.some(s=>s.payout_id===p.id)?<details><summary className="cursor-pointer">{text('payoutSources')}</summary><div className="mt-2 space-y-2">
    {query.data.sources.filter(s=>s.payout_id===p.id).map((s,index)=><p key={index}>{text(s.refund_id?'refunded':s.purchase_kind==='gift_card'?'gifts':s.purchase_kind==='package'?'packages':'payoutOtherSource')}
     {' · '}{text('gross')}: {money(s.gross_cents,s.currency)}{' · '}{text('fee')}: {money(s.fee_cents,s.currency)}{' · '}{text('net')}: {money(s.net_cents,s.currency)}</p>)}
   </div></details>:null}
  </article>)}
 </CardContent></Card>;
}
