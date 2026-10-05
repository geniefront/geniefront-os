import {commerceText,commerceDayText,type CommerceDaySummary,type CommerceDayCopyKey} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
export function CommerceDayPanel({summary}:{summary:CommerceDaySummary}){
 const {language}=useLanguage(),text=(key:CommerceDayCopyKey)=>commerceDayText(language,key);
 const money=(value:number,currency:string)=>new Intl.NumberFormat(language,{style:'currency',currency:currency.toUpperCase()}).format(value/100);
 const payoutKeys={pending:'payoutPending',in_transit:'payoutInTransit',paid:'payoutPaid',failed:'payoutFailed',canceled:'payoutCanceled'} as const;
 const payoutLabel=(status:string)=>{const key=payoutKeys[status as keyof typeof payoutKeys];return key?commerceText(language,key):text('unknown');};
 const source=(kind:string)=>kind==='customer_membership'?text('membership'):['gift_card','package','membership','appointment_deposit','deposit','store_credit'].includes(kind)?text(kind as CommerceDayCopyKey):text('unknown');
 return <section aria-label={text('title')} className="space-y-4 rounded-xl border bg-white p-4">
  <div><h2 className="font-bold text-lg">{text('title')}</h2><p className="text-sm text-slate-600">{text('hint')}</p></div>
  {summary.currencies.map(b=><div key={b.currency} className="space-y-3 rounded-lg border p-3">
   <h3 className="font-bold">{b.currency.toUpperCase()}</h3>
   <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">{text('kind')}</th><th>{text('received')}</th><th>{text('refunded')}</th></tr></thead><tbody>{b.sales.map(s=><tr key={s.kind}><td className="py-2">{source(s.kind)}</td><td className="text-center">{money(s.receivedCents,b.currency)}</td><td className="text-center">{money(s.refundedCents,b.currency)}</td></tr>)}</tbody></table></div>
   <div className="text-sm space-y-1">{[[text('offlineCash'),b.offlineCashReceivedCents,b.offlineCashRefundedCents],[text('offlineCard'),b.offlineCardReceivedCents,b.offlineCardRefundedCents],[text('online'),b.stripeReceivedCents,b.stripeRefundedCents]].map(([label,received,returned])=><p key={label}>{label}: {money(received as number,b.currency)} / {money(returned as number,b.currency)}</p>)}</div>
   {!!b.redemptions.length&&<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">{text('kind')}</th><th>{text('applied')}</th><th>{text('restored')}</th></tr></thead><tbody>{b.redemptions.map(s=><tr key={s.kind}><td className="py-2">{source(s.kind)}</td><td className="text-center">{money(s.appliedCents,b.currency)}</td><td className="text-center">{money(s.returnedCents,b.currency)}</td></tr>)}</tbody></table></div>}
   <h4 className="font-semibold">{text('assets')}</h4><dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
    {([[text('face'),money(b.giftFaceRemainingCents,b.currency)],[text('packageUnits'),b.packageUnitsRemaining],[text('unlimited'),b.unlimitedPackageCount],[text('packageValue'),money(b.packageFundedRemainingCents,b.currency)],[text('memberUnits'),b.membershipUnitsRemaining],[text('plannedUnits'),b.membershipPlannedUnits],[text('plannedValue'),money(b.membershipPlannedValueCents,b.currency)],[text('depositBalance'),money(b.depositRemainingCents,b.currency)],[text('retained'),money(b.depositRetainedCents,b.currency)],[text('creditIssued'),money(b.serviceRefundCreditIssuedCents,b.currency)]] as const).map(([label,value])=><div key={label} className="flex flex-wrap justify-between gap-x-2"><dt>{label}</dt><dd className="font-mono">{value}</dd></div>)}
   </dl><p className="text-xs text-slate-500">{text('availability')}</p>
  </div>)}
  {!!summary.unclassifiedRedemptionCount&&<p role="status">{text('legacy')}: {summary.unclassifiedRedemptionCount}</p>}
  <h3 className="font-bold">{text('stripe')}</h3>{summary.settlements.map(s=><p key={s.currency} className="text-sm">{s.currency.toUpperCase()} · {text('gross')} {money(s.grossCents,s.currency)} · {text('fee')} {money(s.feeCents,s.currency)} · {text('net')} {money(s.netCents,s.currency)}</p>)}
  {!!summary.pendingSettlementCount&&<p role="status">{text('pending')}: {summary.pendingSettlementCount}</p>}
  {!!summary.payouts.length&&<><h3 className="font-bold">{text('payouts')}</h3><p className="text-sm text-slate-600">{text('payoutHint')}</p>{summary.payouts.map(p=><p key={p.id} className="text-sm">{money(p.amountCents,p.currency)} · {payoutLabel(p.status)} · {new Date(p.arrivalAt).toLocaleDateString(language)}</p>)}</>}
 </section>;
}
