import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {CommerceReleaseDepositRetention,retentionReleaseText,commerceText} from '@gf/contracts';
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
type Pending={key:string;input:typeof CommerceReleaseDepositRetention.input._type};
function readPending(key:string):Pending|null{
 try{const raw=JSON.parse(sessionStorage.getItem(key)??'null'),input=CommerceReleaseDepositRetention.input.safeParse(raw?.input);
  return raw&&typeof raw.key==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(raw.key)&&input.success?{key:raw.key,input:input.data}:null;}catch{return null;}
}
export function DepositRetentionReleaseActions({deposit}:{deposit:NonNullable<AppointmentDetail['deposit']>}){
 const {language,t}=useLanguage(),{membershipId}=useSession(),canRetain=useCanWrite('commerce.retainDeposit'),canRefund=useCanWrite('commerce.refund'),writable=canRetain&&canRefund;
 const cache=useQueryClient(),attempt=useAttemptKey(),errorMessage=useErrorMessage(),storageKey=`gf:deposit-release:${membershipId}:${deposit.holdId}`;
 const [pending,setPending]=useState<Pending|null>(()=>readPending(storageKey));
 const [selected,setSelected]=useState<string|null>(null),[open,setOpen]=useState(false),[amount,setAmount]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const text=(key:Parameters<typeof retentionReleaseText>[1])=>retentionReleaseText(language,key),money=(n:number)=>new Intl.NumberFormat(language,{style:'currency',currency:deposit.currency}).format(n/100);
 const original=deposit.retentions?.find(r=>r.id===selected),remaining=pending?.input.expectedRemainingCents??original?.remainingCents??0,parsed=parseMoney(amount);
 useEffect(()=>{const saved=readPending(storageKey);setPending(saved);setOpen(!!saved);setError('');setSelected(saved?.input.retentionId??null);
  setAmount(saved?(saved.input.amountCents/100).toFixed(2):'');setReason(saved?.input.reason??'');},[storageKey]);
 async function release(){
  if(!writable||!membershipId||busy||!pending&&(!original||!parsed.ok||parsed.value<=0||parsed.value>remaining||reason.trim().length<2))return;
  const input=pending?.input??{retentionId:original!.id,expectedRemainingCents:remaining,amountCents:parsed.ok?parsed.value:0,reason:reason.trim()},intent=['commerce.releaseDepositRetention',membershipId,input],saved=pending??{key:attempt.take(intent),input};
  setBusy(true);setError('');
  try{
   sessionStorage.setItem(storageKey,JSON.stringify(saved));setPending(saved);
   const response=await runCommand('commerce.releaseDepositRetention',saved.input,membershipId,saved.key),result=CommerceReleaseDepositRetention.output.parse(response.result);
   if(result.amountCents!==saved.input.amountCents)throw new Error('Refund response does not match saved release');
   sessionStorage.removeItem(storageKey);setPending(null);attempt.settle(intent);setOpen(false);
   await Promise.all([cache.invalidateQueries({queryKey:['desk','appointment-detail']}),cache.invalidateQueries({queryKey:['desk','day']}),cache.invalidateQueries({queryKey:['desk','commerce']})]);
  }catch(e){
   const failure=e as {code?:string;status?:number;details?:{reason?:string}};
   if(!pending&&failure.status&&failure.status<500&&['VALIDATION_FAILED','RESOURCE_CONFLICT','NOT_FOUND'].includes(failure.code??'')){
    sessionStorage.removeItem(storageKey);setPending(null);attempt.settle(intent);
   }
   setError(failure.details?.reason==='deposit_retention_release_changed'?text('changed'):errorMessage(e));await cache.invalidateQueries({queryKey:['desk','appointment-detail']});
  }finally{setBusy(false);}
 }
 return <div className="space-y-3">
  {deposit.retentions?.map(r=><div key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
   <p className="break-words">{money(r.amountCents)} · {r.reason}</p><p>{text('remaining')}: {money(r.remainingCents)}</p>
   {r.releases?.map(s=><p key={s.id} className="mt-1 break-words text-xs text-slate-600">{text('released')}: {money(s.amountCents)} · {s.reason} · {text('refund')}: {commerceText(language,s.refundStatus==='succeeded'?'refunded':s.refundStatus==='failed'?'failed':'processing')}</p>)}
   {r.remainingCents>0&&writable&&<GuardedButton permission="commerce.retainDeposit" variant="outline" isDisabled={busy||!!pending}
    onPress={()=>{setSelected(r.id);setAmount('');setReason('');setError('');setOpen(true);}}>{text('action')}</GuardedButton>}
  </div>)}
  {pending&&<div role="status" className="rounded-lg bg-amber-50 p-3 text-sm"><p>{text('unknown')}</p><GuardedButton permission="commerce.retainDeposit" isDisabled={!writable||busy}
   onPress={()=>setOpen(true)}>{text('retry')}</GuardedButton></div>}
  <Modal isOpen={open} onOpenChange={v=>{if(!busy)setOpen(v);}} title={text('action')} size="sm" footer={<><Button variant="ghost" isDisabled={busy} onPress={()=>setOpen(false)}>{t('cancel')}</Button>
   <GuardedButton permission="commerce.retainDeposit" isPending={busy} isDisabled={!writable||busy||!pending&&(!parsed.ok||parsed.value<=0||parsed.value>remaining||reason.trim().length<2)} onPress={()=>void release()}>{text(pending?'retry':'action')}</GuardedButton></>}>
   <div className="space-y-3 text-sm"><p>{text('notice')}</p><p>{text('remaining')}: {money(remaining)}</p>
    <label className="block space-y-1"><span>{text('amount')}</span><Input inputMode="decimal" value={amount} disabled={!writable||busy||!!pending} onChange={e=>setAmount(e.target.value)}/></label>
    <label className="block space-y-1"><span>{text('reason')}</span><Input value={reason} minLength={2} maxLength={500} disabled={!writable||busy||!!pending} onChange={e=>setReason(e.target.value)}/></label>
    {error&&<p role="alert" className="text-red-700">{error}</p>}
   </div>
  </Modal>
 </div>;
}
