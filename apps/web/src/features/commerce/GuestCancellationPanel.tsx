import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {AppointmentCancelGuests,depositText,depositAdjustmentText,type DepositAdjustmentQuote} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
import {useSession} from '@/lib/session';
import {useCanWrite} from '@/lib/permissions';
import {useErrorMessage} from '@/lib/errorMessage';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {useDurableDepositCommand} from './useDurableDepositCommand';
import {DepositAdjustmentReview} from './DepositAdjustmentReview';

export function GuestCancellationPanel({appointment}:{appointment:AppointmentDetail}){
  const {language,t}=useLanguage(),{membershipId}=useSession(),writable=useCanWrite('appointment.cancel');
  const cache=useQueryClient(),errorMessage=useErrorMessage();
  const action=useDurableDepositCommand<typeof AppointmentCancelGuests.input._type>('appointment.cancelGuests',appointment.appointmentId,AppointmentCancelGuests.input);
  const [quote,setQuote]=useState<DepositAdjustmentQuote|null>(null),[accepted,setAccepted]=useState(false);
  const currentQuote=(action.pending?.meta?.quote as DepositAdjustmentQuote|undefined)??quote;
  useEffect(()=>{if(action.pending){setSelected(action.pending.input.guestIndices);setReason(action.pending.input.reason);setAccepted(!!action.pending.input.depositAdjustment);setOpen(true);}},[action.pending?.key]);
  const [selected,setSelected]=useState<number[]>([]),[open,setOpen]=useState(false),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const text=(key:Parameters<typeof depositText>[1])=>depositText(language,key);
  const config=appointment.guestCancellation,guests=appointment.guests??[],active=guests.filter(g=>g.status==='active');
  const money=(n:number)=>new Intl.NumberFormat(language,{style:'currency',currency:config?.currency??'USD'}).format(n/100);
  const pending=config?.reason==='pending_deposit_change_requires_reconfirmation';
  const adjustment=(key:Parameters<typeof depositAdjustmentText>[1])=>depositAdjustmentText(language,key);
  const selectable=writable&&!busy&&!action.pending&&(config?.enabled||pending);
  const shared=appointment.items.some(i=>i.status!=='cancelled'&&i.guestIndices?.some(g=>selected.includes(g))&&i.guestIndices.some(g=>!selected.includes(g)));
  const canSubmit=!!action.pending&&writable&&!busy||selectable&&selected.length>0&&!shared&&(config?.enabled||pending&&selected.length===active.length);
  const refundCents=action.pending?.input.expectedRefundCents??guests.filter(g=>selected.includes(g.guestIndex)).reduce((n,g)=>n+(g.refundableDepositCents??0),0);
  async function cancel(){
    if(!canSubmit||!membershipId||!action.pending&&(reason.trim().length<2||currentQuote&&!accepted))return;
    const input=action.pending?.input??{...(currentQuote&&accepted?{depositAdjustment:{accepted:true as const,quoteHash:currentQuote.quoteHash}}:{}),appointmentId:appointment.appointmentId,guestIndices:[...selected].sort((a,b)=>a-b),reason:reason.trim(),expectedRefundCents:refundCents};
    setBusy(true);setError('');
    try{
      await action.execute(input,{...(quote?{quote}:{})});setQuote(null);setAccepted(false);setOpen(false);setSelected([]);
      await Promise.all([cache.invalidateQueries({queryKey:['desk','appointment-detail']}),cache.invalidateQueries({queryKey:['desk','day']}),
        cache.invalidateQueries({queryKey:['desk','commerce']})]);
    }catch(e){
      const details=(e as {details?:{reason?:string;depositQuote?:DepositAdjustmentQuote;notApplied?:boolean}}|null)?.details,code=details?.reason;
      if((!action.pending||details?.notApplied===true)&&code==='deposit_quote_reconfirmation_required'&&details?.depositQuote){setQuote(details.depositQuote);setAccepted(false);return;}
      setError(code==='deposit_guest_refund_quote_changed'?text('guestQuoteChanged'):
        ['shared_service_requires_all_guests','shared_bundle_requires_all_guests'].includes(code??'')?text('sharedGuests'):errorMessage(e));
      if(code==='deposit_guest_refund_quote_changed'){if(!action.pending){setQuote(null);setAccepted(false);}await cache.invalidateQueries({queryKey:['desk','appointment-detail']});}
    }finally{setBusy(false);}
  }
  if(!config)return null;
  return <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label={text('selectGuests')}>
    <h3 className="font-semibold">{text('selectGuests')}</h3>
    <div className="my-3 space-y-3">{guests.map(g=><label key={g.guestIndex} className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1" checked={selected.includes(g.guestIndex)} disabled={!selectable||g.status==='cancelled'}
        onChange={e=>{setSelected(current=>e.target.checked?[...current,g.guestIndex]:current.filter(i=>i!==g.guestIndex));setQuote(null);setAccepted(false);}}/>
      <span className="min-w-0 flex-1">{text('guestLabel').replace('{n}',String(g.guestIndex+1))}{g.status==='cancelled'?` · ${text('guestCancelled')}`:''}
        {g.refundStatus&&<span className="mt-1 block text-xs text-slate-500">{text(g.refundStatus==='retained'?'retained':g.refundStatus==='succeeded'?'refunded':g.refundStatus==='review'?'review':'refund_pending')}</span>}</span>
      {g.status!=='cancelled'&&<span className="font-mono">{money(g.serviceTotalCents)}</span>}
    </label>)}</div>
    {!config.enabled&&config.reason&&<p className="mb-3 text-sm text-slate-600">{pending?text('pendingGuestChange'):
      config.reason==='appointment_ticket_exists'?text('guestTicketExists'):text('guestMappingReview')}</p>}
    {shared&&<p className="mb-3 text-sm text-amber-700">{text('sharedGuests')}</p>}
    <GuardedButton permission="appointment.cancel" variant="outline" isDisabled={!canSubmit} onPress={()=>{setReason('');setQuote(null);setAccepted(false);setError('');setOpen(true);}}>{text('cancelGuests')}</GuardedButton>
    <Modal isOpen={open||!!action.pending} onOpenChange={value=>{if(!busy&&!action.pending)setOpen(value);}} title={text('cancelGuests')} size="sm"
      footer={<><Button variant="ghost" isDisabled={busy||!!action.pending} onPress={()=>setOpen(false)}>{t('cancel')}</Button>
        <GuardedButton permission="appointment.cancel" variant="danger" isPending={busy} isDisabled={!canSubmit||!action.pending&&(reason.trim().length<2||!!currentQuote&&!accepted)}
          onPress={()=>void cancel()}>{action.pending?adjustment('retry'):text('cancelGuests')}</GuardedButton></>}>
      {action.pending&&<p className="mb-3 text-sm" role="status">{adjustment('unknown')}</p>}
      <p className="mb-3 text-sm">{text('guestCancellationNotice')}</p>
      {currentQuote&&<DepositAdjustmentReview quote={currentQuote} language={language} accepted={accepted} onAccepted={setAccepted} disabled={busy||!!action.pending||!writable}/>}
      <p className="mb-3 font-medium">{text('guestRefund')}: {money(refundCents)}</p>
      <label className="space-y-1 text-sm">{text('guestCancellationReason')}<Input value={reason} minLength={2} maxLength={500} required disabled={!writable||busy||!!action.pending}
        onChange={e=>setReason(e.target.value)}/></label>
      {error&&<p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    </Modal>
  </section>;
}
