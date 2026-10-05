import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {depositText} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
import {useSession} from '@/lib/session';
import {useCanWrite} from '@/lib/permissions';
import {useAttemptKey} from '@/lib/idempotency';
import {runCommand} from '@/lib/api';
import {useErrorMessage} from '@/lib/errorMessage';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {DepositPaymentActions} from './DepositPaymentActions';
import {DepositAdjustmentActions} from './DepositAdjustmentActions';
import {DepositRetentionActions} from './DepositRetentionActions';

export function AppointmentDepositPanel({deposit}:{deposit:NonNullable<AppointmentDetail['deposit']>}){
  const {language,t}=useLanguage(),{membershipId}=useSession(),canWaive=useCanWrite('commerce.waiveDeposit');
  const cache=useQueryClient(),attempt=useAttemptKey(),errorMessage=useErrorMessage();
  const [open,setOpen]=useState(false),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const text=(key:Parameters<typeof depositText>[1])=>depositText(language,key);
  const status=(['pending','paid','waived','not_required','expired','cancelled','refund_pending','refunded','review','retained'].includes(deposit.status)?deposit.status:'review') as Parameters<typeof depositText>[1];
  const money=(value:number)=>new Intl.NumberFormat(language,{style:'currency',currency:deposit.currency}).format(value/100);
  async function waive(){
    if(!membershipId||!canWaive||busy||!deposit.waivable||reason.trim().length<2)return;
    const input={holdId:deposit.holdId,reason:reason.trim()},intent=['commerce.waiveAppointmentDeposit',membershipId,input];
    setBusy(true);setError('');
    try{
      await runCommand('commerce.waiveAppointmentDeposit',input,membershipId,attempt.take(intent));attempt.settle(intent);
      setOpen(false);
      await Promise.all([cache.invalidateQueries({queryKey:['desk','appointment-detail']}),cache.invalidateQueries({queryKey:['desk','day']}),
        cache.invalidateQueries({queryKey:['desk','commerce']})]);
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <section className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4" aria-label={text(status)}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold text-teal-900">{text(status)}</h3>
      <span className="font-mono text-sm">{money(deposit.status==='pending'?deposit.amountCents:deposit.status==='retained'?(deposit.retainedCents??0):deposit.availableCents)}</span></div>
    {deposit.status==='waived'?<><p className="mt-2 text-sm text-slate-600">{text('waivedNotice')}</p>
      {deposit.waiverReason&&<p className="mt-2 break-words text-sm">{text('waiverReason')}: {deposit.waiverReason}</p>}
      {['refund_pending','refunded','review'].includes(deposit.financialStatus)&&<p className="mt-2 text-sm">{text(deposit.financialStatus as 'refund_pending'|'refunded'|'review')}</p>}</>:null}
    {deposit.waivable&&<GuardedButton permission="commerce.waiveDeposit" fallback="hide" className="mt-3" variant="outline"
      onPress={()=>{setReason('');setError('');setOpen(true);}}>{text('waive')}</GuardedButton>}
    <DepositPaymentActions deposit={deposit}/>
    <DepositAdjustmentActions deposit={deposit}/>
    <DepositRetentionActions deposit={deposit}/>
    <Modal isOpen={open} onOpenChange={value=>{if(!busy)setOpen(value);}} title={text('waive')} size="sm"
      footer={<><Button variant="ghost" isDisabled={busy} onPress={()=>setOpen(false)}>{t('cancel')}</Button>
        <GuardedButton permission="commerce.waiveDeposit" isPending={busy} isDisabled={!canWaive||!deposit.waivable||busy||reason.trim().length<2}
          onPress={()=>void waive()}>{text('waive')}</GuardedButton></>}>
      <p className="mb-4 text-sm text-slate-600">{text('waiveNotice')}</p>
      <label className="space-y-1 text-sm">{text('waiverReason')}<Input value={reason} minLength={2} maxLength={500} required
        disabled={!canWaive||busy} onChange={event=>setReason(event.target.value)}/></label>
      {error&&<p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    </Modal>
  </section>;
}
