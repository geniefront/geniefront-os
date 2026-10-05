import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {CommerceRecordOfflineDeposit,commerceText,depositText,depositAdjustmentText} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
import {useSession} from '@/lib/session';
import {useStoreTime} from '@/lib/time';
import {useCanWrite} from '@/lib/permissions';
import {useAttemptKey} from '@/lib/idempotency';
import {runCommand} from '@/lib/api';
import {useErrorMessage} from '@/lib/errorMessage';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {useDurableDepositCommand} from './useDurableDepositCommand';

export function DepositPaymentActions({deposit}:{deposit:NonNullable<AppointmentDetail['deposit']>}){
  const {language,t}=useLanguage(),{membershipId}=useSession(),writable=useCanWrite('commerce.sell');
  const receipt=useDurableDepositCommand<typeof CommerceRecordOfflineDeposit.input._type>('commerce.recordOfflineDeposit',deposit.holdId,CommerceRecordOfflineDeposit.input);
  const storeTime=useStoreTime();
  const cache=useQueryClient(),attempt=useAttemptKey(),errorMessage=useErrorMessage();
  const [mode,setMode]=useState<'offline'|'send'|null>(null),[method,setMethod]=useState('cash'),[reference,setReference]=useState(''),
    [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const text=(key:Parameters<typeof depositText>[1])=>depositText(language,key),commerce=(key:Parameters<typeof commerceText>[1])=>commerceText(language,key);
  const money=new Intl.NumberFormat(language,{style:'currency',currency:deposit.currency}).format((receipt.pending?.input.amountCents??deposit.paymentRequest?.amountCents??deposit.amountCents)/100);
  const effectiveMode=receipt.pending?'offline':mode,locked=busy||!!receipt.pending;
  useEffect(()=>{if(receipt.pending){setMethod(receipt.pending.input.method);setReference(receipt.pending.input.reference);}},[receipt.pending?.key]);
  async function command(name:string,input:unknown){
    if(!writable||!membershipId||busy)return;
    const intent=[name,membershipId,input];setBusy(true);setError('');setNotice('');
    try{if(name==='commerce.recordOfflineDeposit')await receipt.execute(CommerceRecordOfflineDeposit.input.parse(input));
      else await runCommand(name,input,membershipId,attempt.take(intent));attempt.settle(intent);setMode(null);setNotice(commerce('success'));
      await Promise.all([cache.invalidateQueries({queryKey:['desk','appointment-detail']}),cache.invalidateQueries({queryKey:['desk','day']}),
        cache.invalidateQueries({queryKey:['desk','commerce']})]);
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  if(!receipt.pending&&!(deposit.status==='pending'&&deposit.waivable)&&!deposit.paymentRequest?.payable)return null;
  return <div className="mt-3 space-y-3">
    {deposit.paymentRequest?.purpose==='supplement'&&<div className="space-y-2 rounded-xl border border-teal-200 bg-white p-3"><p className="font-semibold">{depositAdjustmentText(language,'supplementTitle')}: {money}</p>
      <p className="text-sm">{depositAdjustmentText(language,'supplementNotice')}</p><p className="text-sm">{text('expires')}: {storeTime.dateTime(deposit.paymentRequest.expiresAt)}</p></div>}
    {receipt.pending&&<p role="status">{depositAdjustmentText(language,'unknown')}</p>}
    <div className="flex flex-wrap gap-2">
      {deposit.recordable&&<GuardedButton permission="commerce.sell" fallback="hide" variant="outline" isDisabled={locked}
        onPress={()=>{setMode('offline');setReference('');setError('');}}>{text('recordDeposit')}</GuardedButton>}
      {deposit.onlineCheckoutAvailable&&!deposit.checkoutUrl&&<GuardedButton permission="commerce.sell" fallback="hide" variant="outline" isDisabled={locked}
        onPress={()=>void command('commerce.startDepositCheckout',{holdId:deposit.holdId})}>{text('prepareLink')}</GuardedButton>}
      {deposit.checkoutUrl&&<a className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" href={deposit.checkoutUrl}
        target="_blank" rel="noopener noreferrer">{text('pay')}</a>}
      <GuardedButton permission="commerce.sell" fallback="hide" variant="outline" isDisabled={locked||!deposit.emailAvailable}
        onPress={()=>{setMode('send');setReason('');setError('');}}>{text('sendLink')}</GuardedButton>
    </div>
    {!deposit.emailAvailable&&<p className="text-xs text-slate-600">{text('customerEmailRequired')}</p>}
    {notice&&<p className="text-sm" role="status">{notice}</p>}{error&&!mode&&<p className="text-sm text-red-700" role="alert">{error}</p>}
    <Modal isOpen={effectiveMode!==null} onOpenChange={open=>{if(!open&&!locked)setMode(null);}} title={text(effectiveMode==='offline'?'recordDeposit':'sendLink')} size="sm"
      footer={<><Button variant="ghost" isDisabled={locked} onPress={()=>setMode(null)}>{t('cancel')}</Button>
        <GuardedButton permission="commerce.sell" isPending={busy} isDisabled={!writable||busy||(effectiveMode==='offline'?!reference.trim():reason.trim().length<2)}
          onPress={()=>void command(effectiveMode==='offline'?'commerce.recordOfflineDeposit':'commerce.sendDepositNotice',effectiveMode==='offline'?
            receipt.pending?.input??{holdId:deposit.holdId,...(deposit.paymentRequest?{orderId:deposit.paymentRequest.orderId}:{}),amountCents:deposit.paymentRequest?.amountCents??deposit.amountCents,method,reference:reference.trim()}:{holdId:deposit.holdId,reason:reason.trim()})}>{receipt.pending?depositAdjustmentText(language,'retry'):text(effectiveMode==='offline'?'recordDeposit':'sendLink')}</GuardedButton></>}>
      {effectiveMode==='offline'?<div className="space-y-3"><p className="text-sm">{text('recordNotice')}</p><p className="font-medium">{text('required')}: {money}</p>
        <label className="block space-y-1 text-sm"><span className="block">{commerce('offlineSale')}</span><select value={method} disabled={!writable||locked}
          onChange={e=>setMethod(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
          <option value="cash">{commerce('cash')}</option><option value="card">{commerce('card')}</option><option value="external">{text('externalMethod')}</option></select></label>
        <label className="block space-y-1 text-sm"><span className="block">{commerce('reference')}</span><Input required maxLength={200} value={reference}
          disabled={!writable||locked} onChange={e=>setReference(e.target.value)}/></label></div>:
        <label className="block space-y-1 text-sm"><span className="block">{commerce('reason')}</span><Input required minLength={2} maxLength={500} value={reason}
          disabled={!writable||locked} onChange={e=>setReason(e.target.value)}/></label>}
      {error&&<p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    </Modal>
  </div>;
}
