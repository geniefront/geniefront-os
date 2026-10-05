import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {CommerceRequoteAppointmentDeposit,CommerceRefundExcessDeposit,depositAdjustmentText,type DepositAdjustmentQuote} from '@gf/contracts';
import {useSession} from '@/lib/session';
import {useLanguage} from '@/LanguageContext';
import {useErrorMessage} from '@/lib/errorMessage';
import {parseMoney} from '@/lib/validation';
import {Button} from '@/components/ui/Button';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {DepositAdjustmentReview} from './DepositAdjustmentReview';
import {useDurableDepositCommand} from './useDurableDepositCommand';
export function DepositAdjustmentActions({deposit}:{deposit:NonNullable<AppointmentDetail['deposit']>}){
 const {language,t}=useLanguage(),{can,isOnline}=useSession(),cache=useQueryClient(),errorMessage=useErrorMessage();
 const request=useDurableDepositCommand<typeof CommerceRequoteAppointmentDeposit.input._type>('commerce.requoteAppointmentDeposit',deposit.holdId,CommerceRequoteAppointmentDeposit.input);
 const refund=useDurableDepositCommand<typeof CommerceRefundExcessDeposit.input._type>('commerce.refundExcessDeposit',deposit.holdId,CommerceRefundExcessDeposit.input);
 const [mode,setMode]=useState<'request'|'refund'|null>(null),[accepted,setAccepted]=useState(false),[reason,setReason]=useState(''),[channel,setChannel]=useState<'online'|'offline'>('online'),
  [amount,setAmount]=useState(''),[quote,setQuote]=useState<DepositAdjustmentQuote|null>(null),[error,setError]=useState('');
 const action=request.pending?'request':refund.pending?'refund':mode,pending=action==='request'?request.pending:refund.pending,busy=request.busy||refund.busy;
 const currentQuote=(pending?.meta?.quote as DepositAdjustmentQuote|undefined)??quote??deposit.adjustmentQuote;
 const writable=isOnline&&can(action==='refund'?'commerce.refund':'commerce.sell'),locked=busy||!!pending||!writable;
 const text=(key:Parameters<typeof depositAdjustmentText>[1])=>depositAdjustmentText(language,key);
 useEffect(()=>{if(request.pending){setReason(request.pending.input.reason);setChannel(request.pending.input.channel??'online');setAccepted(!!request.pending.input.depositAdjustment);}
  else if(refund.pending){setReason(refund.pending.input.reason);setAmount(String(refund.pending.input.amountCents/100));}},[request.pending?.key,refund.pending?.key]);
 const value=parseMoney(amount),validRefund=value.ok&&value.value>0&&value.value<=(currentQuote?.excessCents??0);
 const refresh=()=>Promise.all([cache.invalidateQueries({queryKey:['desk','appointment-detail']}),cache.invalidateQueries({queryKey:['desk','day']}),cache.invalidateQueries({queryKey:['desk','commerce']})]);
 async function submit(){
  if(!action||!writable||busy||!currentQuote||!pending&&(reason.trim().length<2||action==='request'&&!accepted||action==='refund'&&!validRefund))return;
  setError('');try{
   if(action==='request')await request.execute(request.pending?.input??{holdId:deposit.holdId,channel,reason:reason.trim(),depositAdjustment:{accepted:true,quoteHash:currentQuote.quoteHash}},{quote:currentQuote});
   else await refund.execute(refund.pending?.input??{holdId:deposit.holdId,quoteHash:currentQuote.quoteHash,amountCents:value.ok?value.value:0,reason:reason.trim()},{quote:currentQuote});
   setMode(null);setQuote(null);setAccepted(false);await refresh();
  }catch(e){const details=(e as {details?:{reason?:string;depositQuote?:DepositAdjustmentQuote;notApplied?:boolean}}).details;
   if((!pending||details?.notApplied===true)&&details?.depositQuote){setQuote(details.depositQuote);setAccepted(false);setError(text('quoteChanged'));await refresh();}
   else setError(details?.reason==='deposit_adjustment_requires_review'?text('reviewRequired'):errorMessage(e));}
 }
 const start=(next:'request'|'refund')=>{setMode(next);setQuote(deposit.adjustmentQuote??null);setReason('');setAccepted(false);setError('');setAmount(String((deposit.adjustmentQuote?.excessCents??0)/100));setChannel(deposit.paymentRequest?.channel??'online');};
 if(!deposit.adjustmentQuote&&!pending)return null;
 return <div className="mt-3 space-y-3">
  {!!deposit.adjustmentQuote?.excessCents&&<p className="text-sm">{text('excess')}: {new Intl.NumberFormat(language,{style:'currency',currency:deposit.currency}).format(deposit.adjustmentQuote.excessCents/100)}</p>}
  <div className="flex flex-wrap gap-2">
   <GuardedButton permission="commerce.sell" fallback="hide" variant="outline" isDisabled={!isOnline||busy||!!pending||!deposit.adjustmentQuote} onPress={()=>start('request')}>{text('requote')}</GuardedButton>
   {!!deposit.adjustmentQuote?.excessCents&&<GuardedButton permission="commerce.refund" fallback="hide" variant="outline" isDisabled={!isOnline||busy||!!pending} onPress={()=>start('refund')}>{text('refundExcess')}</GuardedButton>}
  </div>
  <Modal isOpen={action!==null} onOpenChange={open=>{if(!open&&!busy&&!pending)setMode(null);}} title={text(action==='refund'?'refundExcess':'title')} size="sm"
   footer={<><Button variant="outline" isDisabled={busy||!!pending} onPress={()=>setMode(null)}>{t('cancel')}</Button>
    <GuardedButton permission={action==='refund'?'commerce.refund':'commerce.sell'} isPending={busy} className="max-w-full !whitespace-normal h-auto min-h-10"
     isDisabled={!writable||!pending&&(!currentQuote||reason.trim().length<2||action==='request'&&!accepted||action==='refund'&&!validRefund)} onPress={()=>void submit()}>{text(pending?'retry':action==='refund'?'refundExcess':'approve')}</GuardedButton></>}>
   <div className="space-y-3">{pending&&<p role="status">{text('unknown')}</p>}
    {action==='request'&&currentQuote&&<><DepositAdjustmentReview quote={currentQuote} language={language} accepted={accepted} onAccepted={setAccepted} disabled={locked}/>
     <select aria-label={text('request')} value={channel} disabled={locked} onChange={e=>{setChannel(e.target.value as 'online'|'offline');setAccepted(false);}} className="w-full rounded-xl border px-3 py-2.5">
      <option value="online">{text('online')}</option><option value="offline">{text('offline')}</option></select></>}
    {action==='refund'&&<><p>{text('refundNotice')}</p><label className="block space-y-1 text-sm"><span>{text('excess')}</span><Input value={amount} inputMode="decimal" disabled={locked} onChange={e=>setAmount(e.target.value)}/></label></>}
    <label className="block space-y-1 text-sm"><span>{text('reason')}</span><Input required minLength={2} maxLength={500} value={reason} disabled={locked} onChange={e=>setReason(e.target.value)}/></label>
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
   </div>
  </Modal>
 </div>;
}
