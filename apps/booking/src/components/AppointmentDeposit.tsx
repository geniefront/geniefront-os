import {useEffect,useState} from 'react';
import {depositText,depositAdjustmentText} from '@gf/contracts';
import type {ManagedBooking} from '../lib/api';
import {money} from '../lib/format';
import {useLanguage} from '../lib/i18n';
import {isEmbedded} from '../lib/embed';

export function AppointmentDeposit({deposit,serviceCents,timezone}:{deposit:NonNullable<ManagedBooking['deposit']>;serviceCents:number;timezone:string}){
  const {locale}=useLanguage(),[now,setNow]=useState(()=>Date.now());
  const pending=deposit.status==='pending',expires=Date.parse(deposit.expiresAt),timedOut=pending&&now>=expires;
  const additional=deposit.additionalPayment,additionalOpen=additional?.state==='open',additionalExpired=!!additional&&(additional.state==='expired'||now>=Date.parse(additional.expiresAt));
  useEffect(()=>{
    if(!pending&&!additionalOpen)return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);
  },[pending,deposit.expiresAt,additionalOpen,additional?.expiresAt]);
  const status=timedOut?'expired':deposit.status;
  const statusKey=['pending','paid','waived','not_required','expired','cancelled','refund_pending','refunded','review','retained'].includes(status)
    ?status as 'pending'|'paid'|'waived'|'not_required'|'expired'|'cancelled'|'refund_pending'|'refunded'|'review'|'retained':'review';
  const remaining=deposit.serviceRemainingCents??Math.max(0,serviceCents-(pending?deposit.amountCents:deposit.availableCents+(deposit.appliedCents??0)));
  return <section className="my-4 rounded-2xl border border-[var(--line)] p-4" aria-label={depositText(locale,statusKey)}>
    <h2 className="font-semibold">{depositText(locale,statusKey)}</h2>
    <dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt>{depositText(locale,pending?'required':'available')}</dt>
      <dd>{money(pending?deposit.amountCents:deposit.availableCents,deposit.currency)}</dd></div>
      {!!deposit.appliedCents&&<div className="flex justify-between gap-3"><dt>{depositText(locale,'applied')}</dt><dd>{money(deposit.appliedCents,deposit.currency)}</dd></div>}
      {!!deposit.excessCents&&<div className="flex justify-between gap-3"><dt>{depositAdjustmentText(locale,'excess')}</dt><dd>{money(deposit.excessCents,deposit.currency)}</dd></div>}
      {!!deposit.refundedCents&&<div className="flex justify-between gap-3"><dt>{depositText(locale,'refunded')}</dt><dd>{money(deposit.refundedCents,deposit.currency)}</dd></div>}
      {!!deposit.retainedCents&&<div className="flex justify-between gap-3"><dt>{depositText(locale,'retained')}</dt><dd>{money(deposit.retainedCents,deposit.currency)}</dd></div>}
      <div className="flex justify-between gap-3"><dt>{depositText(locale,'remaining')}</dt><dd>{money(remaining,deposit.currency)}</dd></div></dl>
    {additional&&<div className="mt-4 space-y-3 rounded-xl border border-[var(--line)] p-3" aria-label={depositAdjustmentText(locale,'supplementTitle')}>
      <h3 className="font-semibold">{depositAdjustmentText(locale,'supplementTitle')} · {money(additional.amountCents,deposit.currency)}</h3>
      <p className="text-sm">{depositAdjustmentText(locale,additionalExpired?'requestExpired':'supplementNotice')}</p>
      {!additionalExpired&&<><p className="text-sm">{depositText(locale,'expires')}: {new Date(additional.expiresAt).toLocaleString(locale,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'})}</p>
        {additional.checkoutUrl?<a className="appointment-primary-link" href={additional.checkoutUrl} target={isEmbedded()?'_blank':undefined} rel="noreferrer">{depositText(locale,'pay')}</a>
          :<p className="text-sm" role="status">{additional.paymentMethod==='frontdesk'?depositAdjustmentText(locale,'offlineNotice'):depositText(locale,'preparing')}</p>}</>}
    </div>}
    {status!=='waived'&&deposit.guestAllocation&&deposit.guestAllocation.guests.length>1&&<div className="mt-3 text-sm"><h3 className="font-medium">{depositText(locale,'originalGuestAllocation')}</h3>
      <ol className="mt-2 space-y-2">{deposit.guestAllocation.guests.map(g=><li key={g.guestIndex}><div className="flex justify-between gap-2">
        <span>{depositText(locale,'guestLabel').replace('{n}',String(g.guestIndex+1))}{g.cancelled?` · ${depositText(locale,'guestCancelled')}`:''}</span><span>{money(g.amountCents,deposit.currency)}</span></div>
        {g.refundStatus&&<p className="mt-1 text-xs text-[var(--muted)]">{depositText(locale,g.refundStatus==='retained'?'retained':g.refundStatus==='succeeded'?'refunded':g.refundStatus==='review'?'review':'refund_pending')}</p>}</li>)}</ol>
    </div>}
    {pending&&!timedOut&&<><p className="mt-3 text-sm">{depositText(locale,'expires')}: {new Date(expires).toLocaleTimeString(locale,{timeZone:timezone,hour:'numeric',minute:'2-digit'})}</p>
      {deposit.checkoutUrl?<a className="appointment-primary-link mt-3" href={deposit.checkoutUrl} target={isEmbedded()?'_blank':undefined} rel="noreferrer">{depositText(locale,'pay')}</a>
        :<p className="mt-3 text-sm" role="status">{depositText(locale,deposit.paymentMethod==='frontdesk'?'pendingContact':'preparing')}</p>}</>}
    {status==='waived'?<><p className="mt-3 text-sm text-[var(--muted)]">{depositText(locale,'waivedNotice')}</p>
      {deposit.financialStatus&&['refund_pending','refunded','review'].includes(deposit.financialStatus)&&
        <p className="mt-2 text-sm" role="status">{depositText(locale,deposit.financialStatus as 'refund_pending'|'refunded'|'review')}</p>}</>:
      <>{status!=='not_required'&&<p className="mt-3 text-sm text-[var(--muted)]">{depositText(locale,'policy')}</p>}
        <p className="mt-2 text-sm text-[var(--muted)]">{depositText(locale,'refundBefore').replace('{hours}',String(deposit.policy.cancelCutoffHours))}</p>
        <p className="mt-2 text-sm text-[var(--muted)]">{depositText(locale,deposit.policy.retainAfterCutoff?'lateRetain':'lateReview')}</p>
        {deposit.policy.notice&&<p className="mt-2 text-sm text-[var(--muted)]">{deposit.policy.notice}</p>}</>}
  </section>;
}
