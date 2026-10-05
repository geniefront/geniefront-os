import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {CommerceRetainAppointmentDeposit,depositText} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
import {useSession} from '@/lib/session';
import {useCanWrite} from '@/lib/permissions';
import {useAttemptKey} from '@/lib/idempotency';
import {runCommand} from '@/lib/api';
import {useErrorMessage} from '@/lib/errorMessage';
import {parseMoney} from '@/lib/validation';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {DepositRetentionReleaseActions} from './DepositRetentionReleaseActions';
type Pending={key:string;input:typeof CommerceRetainAppointmentDeposit.input._type};
function readPending(key:string,holdId:string):Pending|null{
  try{const raw=JSON.parse(sessionStorage.getItem(key)??'null') as Pending|null;
    const input=CommerceRetainAppointmentDeposit.input.safeParse(raw?.input);
    return raw&&typeof raw.key==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(raw.key)&&input.success&&input.data.holdId===holdId?
      {key:raw.key,input:input.data}:null;}catch{return null;}
}

export function DepositRetentionActions({deposit}:{deposit:NonNullable<AppointmentDetail['deposit']>}){
  const {language,t}=useLanguage(),{membershipId}=useSession(),writable=useCanWrite('commerce.retainDeposit');
  const cache=useQueryClient(),attempt=useAttemptKey(),errorMessage=useErrorMessage();
  const storageKey=`gf:deposit-retention:${membershipId}:${deposit.holdId}`;
  const [pending,setPending]=useState<Pending|null>(()=>readPending(storageKey,deposit.holdId));
  const [open,setOpen]=useState(false),[selected,setSelected]=useState<number[]>([]),[amount,setAmount]=useState(''),[reason,setReason]=useState(''),
    [busy,setBusy]=useState(false),[error,setError]=useState('');
  const text=(key:Parameters<typeof depositText>[1])=>depositText(language,key),quote=deposit.retentionQuote;
  const money=(cents:number)=>new Intl.NumberFormat(language,{style:'currency',currency:deposit.currency}).format(cents/100);
  const recovering=pending?.input.holdId===deposit.holdId?pending:null;
  const shownGuests=recovering?.input.expectedGuestBalances??quote?.guests??[];
  const guests=shownGuests.filter(g=>selected.includes(g.guestIndex)),max=guests.reduce((n,g)=>n+g.availableCents,0),parsed=parseMoney(amount);
  useEffect(()=>{
    const saved=readPending(storageKey,deposit.holdId);setPending(saved);setOpen(!!saved);setError('');
    if(saved){setSelected(saved.input.guestIndices);setAmount((saved.input.amountCents/100).toFixed(2));setReason(saved.input.reason);}
  },[storageKey,deposit.holdId]);
  async function retain(){
    if(!writable||!membershipId||busy)return;
    if(!recovering&&(!quote?.enabled||!parsed.ok||parsed.value<=0||parsed.value>max||reason.trim().length<2))return;
    const input=recovering?.input??{holdId:deposit.holdId,guestIndices:guests.map(g=>g.guestIndex),expectedGuestBalances:guests,amountCents:parsed.ok?parsed.value:0,reason:reason.trim()},
      intent=['commerce.retainAppointmentDeposit',membershipId,input],saved=recovering??{key:attempt.take(intent),input};
    setBusy(true);setError('');
    try{
      // Persist before sending so a lost response, refreshed quote or remount cannot become a second decision.
      sessionStorage.setItem(storageKey,JSON.stringify(saved));setPending(saved);
      await runCommand('commerce.retainAppointmentDeposit',saved.input,membershipId,saved.key);
      sessionStorage.removeItem(storageKey);setPending(null);attempt.settle(intent);setOpen(false);
      await Promise.all([cache.invalidateQueries({queryKey:['desk','appointment-detail']}),cache.invalidateQueries({queryKey:['desk','day']}),
        cache.invalidateQueries({queryKey:['desk','commerce']})]);
    }catch(e){
      const failure=e as {code?:string;status?:number;details?:{reason?:string}};
      if(failure.status&&failure.status<500&&['VALIDATION_FAILED','PAYMENT_MISMATCH','RESOURCE_CONFLICT'].includes(failure.code??'')){
        sessionStorage.removeItem(storageKey);setPending(null);attempt.settle(intent);
      }
      setError(failure.details?.reason==='deposit_retention_quote_changed'?text('guestQuoteChanged'):errorMessage(e));
      await cache.invalidateQueries({queryKey:['desk','appointment-detail']});}finally{setBusy(false);}
  }
  return <div className="mt-3 space-y-2">
    {!!deposit.retainedCents&&<p className="text-sm font-medium">{text('retained')}: {money(deposit.retainedCents)}</p>}
    <DepositRetentionReleaseActions deposit={deposit}/>
    {(quote?.enabled||recovering)&&<GuardedButton permission="commerce.retainDeposit" fallback="hide" variant="outline" isDisabled={busy}
      onPress={()=>{if(!recovering){setSelected(quote!.guests.map(g=>g.guestIndex));setAmount('');setReason('');setError('');}setOpen(true);}}>{text(recovering?'retentionRecover':'retain')}</GuardedButton>}
    <Modal isOpen={open} onOpenChange={value=>{if(!busy)setOpen(value);}} title={text('retain')} size="sm"
      footer={<><Button variant="ghost" isDisabled={busy} onPress={()=>setOpen(false)}>{t('cancel')}</Button>
        <GuardedButton permission="commerce.retainDeposit" isPending={busy} isDisabled={!writable||busy||!recovering&&(!quote?.enabled||!parsed.ok||parsed.value<=0||parsed.value>max||reason.trim().length<2)}
          onPress={()=>void retain()}>{text(recovering?'retentionRecover':'retain')}</GuardedButton></>}>
      <p className="mb-3 text-sm">{text('retentionNotice')}</p>
      {recovering&&!busy&&<p className="mb-3 text-sm" role="status">{text('retentionRecoverNotice')}</p>}
      {quote?.policy&&<div className="mb-3 space-y-2 text-sm text-slate-600"><p>{text('refundBefore').replace('{hours}',String(quote.policy.cancelCutoffHours))}</p>
        <p>{text('lateRetain')}</p>{quote.policy.notice&&<p>{quote.policy.notice}</p>}</div>}
      <div className="space-y-3">{shownGuests.map(g=><label key={g.guestIndex} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={selected.includes(g.guestIndex)} disabled={!writable||busy||!!recovering} onChange={event=>setSelected(value=>event.target.checked?
          [...value,g.guestIndex]:value.filter(i=>i!==g.guestIndex))}/>
        {text('guestLabel').replace('{n}',String(g.guestIndex+1))} · {money(g.availableCents)}</label>)}
        <p className="text-sm">{text('retentionMax')}: {money(max)}</p>
        <label className="block space-y-1 text-sm"><span className="block">{text('retentionAmount')}</span><Input inputMode="decimal" required value={amount}
          disabled={!writable||busy||!!recovering} onChange={event=>setAmount(event.target.value)}/></label>
        <label className="block space-y-1 text-sm"><span className="block">{text('retentionReason')}</span><Input required minLength={2} maxLength={500} value={reason}
          disabled={!writable||busy||!!recovering} onChange={event=>setReason(event.target.value)}/></label>
      </div>{error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </Modal>
  </div>;
}
