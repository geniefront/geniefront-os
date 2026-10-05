import {useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {commerceText,membershipText,type MembershipTextKey} from '@gf/contracts';
import {apiGet,runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {useAttemptKey} from '@/lib/idempotency';
import {parseMoney} from '@/lib/validation';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
export interface MembershipTerminationReview {
 reviewHash:string;membership:{id:string;name:string;currency:string;timezone:string};
 termination:{id:string;status:string;unused_benefits:'revoke_all'|'keep_current_paid'}|null;
 summary:{paidCents:number;refundedCents:number;reservedCents:number;currentAvailable:number;futurePlanned:number;usedServices:number};
 invoices:Array<{id:string;amount_cents:number;currency:string;paid_at:string;refundable:number;keep_current_refundable:number;held:number}>;
 requests:Array<{id:string;amount_cents:number;status:string}>;
}
type Submission={name:'commerce.terminateMembership'|'commerce.refundMembership';input:Record<string,unknown>;key:string};
export function MembershipTermination({id,language,onClose}:{id:string;language:string;onClose:()=>void}){
 const {membershipId,can,isOnline}=useSession(),keys=useAttemptKey(),client=useQueryClient();
 const storageKey=`gf-membership-termination:${membershipId}:${id}`;
 const [pending,setPending]=useState<Submission|null>(()=>{try{const p=JSON.parse(sessionStorage.getItem(storageKey)??'null') as Submission|null;
  return p&&['commerce.terminateMembership','commerce.refundMembership'].includes(p.name)&&p.input.membershipId===id&&p.key?p:null;}catch{return null;}});
 const [policy,setPolicy]=useState<'revoke_all'|'keep_current_paid'>(pending?.input.unusedBenefits==='keep_current_paid'?'keep_current_paid':'revoke_all');
 const [amounts,setAmounts]=useState<Record<string,string>>(()=>Object.fromEntries(Array.isArray(pending?.input.refunds)?pending.input.refunds.map((r:{invoiceId:string;amountCents:number})=>[r.invoiceId,String(r.amountCents/100)]):[]));
 const [reason,setReason]=useState(typeof pending?.input.reason==='string'?pending.input.reason:''),[confirmed,setConfirmed]=useState(!!pending),[busy,setBusy]=useState(false),[notice,setNotice]=useState<MembershipTextKey|null>(pending?'unknownResult':null);
 const running=useRef(false),text=(key:MembershipTextKey)=>membershipText(language,key),common=(key:'reason'|'error'|'refresh'|'processing')=>commerceText(language,key);
 const query=useQuery({queryKey:['desk','membership-termination',membershipId,id],queryFn:()=>apiGet<MembershipTerminationReview>(`/v1/desk/commerce/memberships/${id}/termination-review`),
  enabled:!!membershipId&&can('commerce.refund'),refetchInterval:q=>q.state.data?.termination?.status==='pending'||q.state.data?.requests.some(r=>r.status==='pending')?2000:false});
 const review=query.data,t=review?.termination,editable=!t||t.status!=='pending',locked=busy||!!pending||!isOnline||!can('commerce.refund');
 const money=(cents:number,currency=review?.membership.currency??'usd')=>new Intl.NumberFormat(language,{style:'currency',currency}).format(cents/100);
 const date=(value:string)=>new Intl.DateTimeFormat(language,{timeZone:review?.membership.timezone??'UTC',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
 const cap=(i:MembershipTerminationReview['invoices'][number])=>!t&&policy==='keep_current_paid'?i.keep_current_refundable:i.refundable;
 const validAmounts=!!review&&review.invoices.every(i=>{const raw=amounts[i.id]??'';if(!raw.trim())return true;const n=parseMoney(raw);return n.ok&&n.value>=0&&n.value<=cap(i);});
 const hasRefund=review?.invoices.some(i=>{const n=parseMoney(amounts[i.id]??'');return n.ok&&n.value>0;})??false;
 function preserve(p:Submission|null){setPending(p);try{if(p)sessionStorage.setItem(storageKey,JSON.stringify(p));else sessionStorage.removeItem(storageKey);}catch{}}
 async function submit(){
  if(running.current||!review||!membershipId||!isOnline||!can('commerce.refund'))return;
  if(!pending&&(!editable||!confirmed||reason.trim().length<2||!validAmounts||!!t&&!hasRefund))return;
  const refunds=review.invoices.flatMap(i=>{const n=parseMoney(amounts[i.id]??'');return n.ok&&n.value>0?[{invoiceId:i.id,amountCents:n.value}]:[];});
  if(!pending&&refunds.length>24)return setNotice('reviewChanged');
  const name=t?'commerce.refundMembership':'commerce.terminateMembership';
  const input={membershipId:id,expectedReviewHash:review.reviewHash,...(t?{terminationId:t.id}:{unusedBenefits:policy}),refunds,reason:reason.trim(),confirmed:true};
  const p=pending??{name,input,key:keys.take([name,membershipId,input])};preserve(p);running.current=true;setBusy(true);setNotice(null);
  try{await runCommand(p.name,p.input,membershipId,p.key);keys.settle([p.name,membershipId,p.input]);preserve(null);setAmounts({});setReason('');setConfirmed(false);
   await Promise.allSettled([client.invalidateQueries({queryKey:['desk','customer-memberships',membershipId]}),client.invalidateQueries({queryKey:['desk','commerce',membershipId]}),query.refetch()]);
  }catch(e){const error=e as {status?:number;details?:{reason?:string}};
   if(error.status&&error.status<500){preserve(null);setConfirmed(false);setNotice('reviewChanged');await query.refetch();}
   else setNotice('unknownResult');
  }finally{running.current=false;setBusy(false);}
 }
 if(!can('commerce.refund'))return null;
 return <Modal isOpen onOpenChange={open=>{if(!open)onClose();}} isDismissDisabled={busy} size="lg" title={text(t?'refundTitle':'terminationTitle')}>
  {query.error?<p role="alert">{common('error')}</p>:null}{notice?<p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-900">{text(notice)}</p>:null}
  {review?<div className="space-y-4"><p className="font-semibold">{review.membership.name}</p>
   <div className="grid gap-2 text-sm sm:grid-cols-2"><p>{text('paidBills')}: {money(review.summary.paidCents)}</p><p>{text('refundTotal')}: {money(review.summary.refundedCents)}</p>
    <p>{text('refundPending')}: {money(review.summary.reservedCents)}</p><p>{text('usedServices')}: {review.summary.usedServices}</p>
    <p>{text('unusedNow')}: {review.summary.currentAvailable}</p><p>{text('futurePlanned')}: {review.summary.futurePlanned}</p></div>
   <p className="text-sm">{text('terminationHint')}</p>
   {t?<p role="status">{text(t.status==='pending'?'terminationPending':t.status==='review'?'terminationReview':'terminationComplete')} · {text(t.unused_benefits==='revoke_all'?'revokeAll':'keepCurrent')}</p>:null}
   {review.requests.map(r=><p key={r.id} className="text-sm">{text(r.status==='succeeded'?'refundTotal':r.status==='failed'?'refundFailed':'refundPending')}: {money(r.amount_cents)}</p>)}
   {!t?<fieldset disabled={locked} className="space-y-2"><legend className="font-semibold">{text('benefits')}</legend>
    {(['revoke_all','keep_current_paid'] as const).map(value=><label key={value} className="flex gap-2"><input type="radio" name="unusedBenefits" value={value} checked={policy===value} onChange={()=>{setPolicy(value);setConfirmed(false);}}/>{text(value==='revoke_all'?'revokeAll':'keepCurrent')}</label>)}
   </fieldset>:null}
   {editable?<form className="space-y-4" onSubmit={e=>{e.preventDefault();void submit();}}>
    {!validAmounts?<p role="alert">{text('refundAmountInvalid')}</p>:null}
    {review.invoices.map((i,index)=><div key={i.id} className="rounded-lg border p-3 text-sm space-y-2">
     <p>{text('paidBills')} {index+1} · {date(i.paid_at)} · {money(i.amount_cents,i.currency)}</p><p>{text('refundCap')}: {money(cap(i),i.currency)}</p>
     {i.held>0||!t&&policy==='keep_current_paid'&&i.refundable>i.keep_current_refundable?<p>{text('currentProtected')}: {money(i.held||i.refundable-i.keep_current_refundable,i.currency)}</p>:null}
     <label className="block">{text('refundAmount')} {index+1}<Input inputMode="decimal" value={amounts[i.id]??''} disabled={locked||cap(i)===0} onChange={e=>{setAmounts({...amounts,[i.id]:e.target.value});setConfirmed(false);}}/></label>
    </div>)}
    <label className="block text-sm">{common('reason')}<Input minLength={2} maxLength={500} required value={reason} disabled={locked} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" required checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}/>{text('reviewConfirm')}</label>
    <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy||!isOnline||(!pending&&(!confirmed||reason.trim().length<2||!validAmounts||!!t&&!hasRefund))}>{busy?common('processing'):text(t?'refundTitle':'terminationTitle')}</Button>
     <Button type="button" variant="outline" disabled={busy||!!pending||!isOnline} onPress={()=>{setConfirmed(false);setNotice(null);void query.refetch();}}>{common('refresh')}</Button></div>
   </form>:pending?<Button disabled={busy||!isOnline} onPress={()=>void submit()}>{text('unknownResult')}</Button>:null}
  </div>:!query.error?<p>{common('processing')}</p>:null}
 </Modal>;
}
