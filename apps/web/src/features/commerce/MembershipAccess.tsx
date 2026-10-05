import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {commerceText,membershipAccessText,membershipAccessInput} from '@gf/contracts';
import {apiGet,runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
type Review={id:string;name:string;email:string|null;version:number;expires_at:string;revoked:boolean};
type Saved={input:typeof membershipAccessInput._type;key:string};
export function MembershipAccess({id,language,onClose}:{id:string;language:string;onClose:()=>void}){
 const {membershipId,can,isOnline}=useSession(),storageKey=`gf-membership-access:${membershipId}:${id}`;
 const load=():Saved|null=>{try{const p=JSON.parse(sessionStorage.getItem(storageKey)??'null'),parsed=membershipAccessInput.safeParse(p?.input);return parsed.success&&parsed.data.membershipId===id&&typeof p.key==='string'?{input:parsed.data,key:p.key}:null;}catch{return null;}};
 const [pending,setPending]=useState(load),[action,setAction]=useState<'reissue'|'revoke'>(()=>load()?.input.action??'reissue'),[reason,setReason]=useState(()=>load()?.input.reason??''),[confirmed,setConfirmed]=useState(()=>!!load()),[busy,setBusy]=useState(false),[message,setMessage]=useState<'sent'|'disabled'|'unknown'|'changed'|null>(null),[failed,setFailed]=useState(false),running=useRef(false);
 const text=(key:Parameters<typeof membershipAccessText>[1])=>membershipAccessText(language,key);
 const review=useQuery({queryKey:['membership-access',membershipId,id],queryFn:()=>apiGet<Review>(`/v1/desk/commerce/memberships/${id}/access-review`),enabled:!!membershipId&&can('commerce.configure')});
 useEffect(()=>{if(!pending)setConfirmed(false);},[review.data?.version,review.data?.email,pending]);
 const locked=busy||!!pending||!isOnline;
 async function submit(){
  if(running.current||!isOnline||!can('commerce.configure')||!membershipId)return;
  if(!pending&&(!review.data||!confirmed||reason.trim().length<2||action==='reissue'&&!review.data.email||action==='revoke'&&review.data.revoked))return;
  const saved=pending??{key:crypto.randomUUID(),input:{membershipId:id,expectedVersion:review.data!.version,action,reason:reason.trim(),confirmed:true as const,...(action==='reissue'?{expectedEmail:review.data!.email!}:{})}};
  running.current=true;setBusy(true);setFailed(false);setMessage(null);
  try{
   sessionStorage.setItem(storageKey,JSON.stringify(saved));setPending(saved);
   await runCommand('commerce.manageMembershipAccess',saved.input,membershipId,saved.key);
   sessionStorage.removeItem(storageKey);setPending(null);setConfirmed(false);setReason('');setMessage(saved.input.action==='reissue'?'sent':'disabled');await review.refetch();
  }catch(e){const failure=e as {code?:string};if(!pending&&failure.code==='VALIDATION_FAILED'){sessionStorage.removeItem(storageKey);setPending(null);setMessage('changed');await review.refetch();}else{setMessage('unknown');setFailed(true);}}finally{running.current=false;setBusy(false);}
 }
 if(!can('commerce.configure'))return null;
 const submitDisabled=busy||!isOnline||!pending&&(!review.data||!confirmed||reason.trim().length<2||action==='reissue'&&!review.data.email||action==='revoke'&&review.data.revoked);
 return <Modal isOpen onOpenChange={open=>{if(!open)onClose();}} isDismissDisabled={busy} title={text('title')} size="lg" footer={<div className="flex flex-wrap gap-2">
  <Button type="button" disabled={submitDisabled} onPress={()=>void submit()}>{busy?commerceText(language,'processing'):text(pending?'retry':action)}</Button>
  <Button type="button" variant="outline" disabled={busy||!!pending||!isOnline} onPress={()=>{setConfirmed(false);void review.refetch();}}>{commerceText(language,'refresh')}</Button>
 </div>}>
  {review.error||failed?<p role="alert">{commerceText(language,'error')}</p>:null}
  {message||pending?<p role="status">{text(pending?'unknown':message!)}</p>:null}
  {review.data?<div className="space-y-3"><p className="font-semibold">{review.data.name}</p><p>{text('email')}: {pending?.input.expectedEmail??review.data.email??'—'}</p>
   <p>{review.data.revoked?text('revoked'):`${text('expires')}: ${new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'short'}).format(new Date(review.data.expires_at))}`}</p>
   <p className="text-sm">{text('hint')}</p>
   <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submit();}}>
    <fieldset disabled={locked}>{(['reissue','revoke'] as const).map(value=><label key={value} className="flex items-start gap-2 py-1"><input type="radio" name="membershipAccessAction" checked={action===value} onChange={()=>{setAction(value);setConfirmed(false);}}/>{text(value)}</label>)}</fieldset>
    <label className="block">{commerceText(language,'reason')}<Input required minLength={2} maxLength={500} value={reason} disabled={locked} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label>
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}/>{text('confirm')}</label>

   </form>
  </div>:!review.error?<p>{commerceText(language,'processing')}</p>:null}
 </Modal>;
}
