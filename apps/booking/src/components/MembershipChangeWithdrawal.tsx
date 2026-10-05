import {useEffect,useState} from 'react';
import {membershipChangeWithdrawalInput,membershipChangeText,commerceText} from '@gf/contracts';
import {commerceApi} from '../lib/commerceApi';
import {useLanguage} from '../lib/i18n';
import {Btn} from './Chrome';
export function MembershipChangeWithdrawal({slug,memberId,change,onSaved}:{slug:string;memberId:string;change:{id:string;status:string;withdrawal_requested_at?:string|null};onSaved:()=>void}){
 const {locale}=useLanguage(),key=`gf-membership-withdraw:${slug}:${memberId}:${change.id}`;
 const load=()=>{try{const value=membershipChangeWithdrawalInput.safeParse(JSON.parse(sessionStorage.getItem(key)??'null'));return value.success?value.data:null;}catch{return null;}};
 const [saved,setSaved]=useState(load),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[online,setOnline]=useState(()=>navigator.onLine);
 useEffect(()=>{setSaved(load());setConsent(false);setError(false);},[key]);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 const text=(k:Parameters<typeof membershipChangeText>[1])=>membershipChangeText(locale,k);
 const allowed=['pending','scheduled'].includes(change.status)&&!change.withdrawal_requested_at;
 async function submit(){
  if(busy||!online||!saved&&(!allowed||!consent))return;
  const request=saved??{businessKey:crypto.randomUUID(),confirmed:true as const};setBusy(true);setError(false);
  try{
   const token=sessionStorage.getItem(`gf-membership:${slug}:${memberId}`);if(!token)throw new Error('No access');
   sessionStorage.setItem(key,JSON.stringify(request));setSaved(request);
   const result=await commerceApi<{changeId:string;status:string}>(slug,`/memberships/${memberId}/plan-change/${change.id}/withdraw`,{token,body:{...request,locale}});
   if(result.changeId!==change.id||!['withdrawing','withdrawn','applied','canceled'].includes(result.status))throw new Error('Unknown withdrawal result');
   sessionStorage.removeItem(key);setSaved(null);setConsent(false);onSaved();
  }catch(e){const failure=e as {status?:number;code?:string};if(!saved&&failure.status&&failure.status<500&&['VALIDATION_FAILED','NOT_FOUND'].includes(failure.code??'')){sessionStorage.removeItem(key);setSaved(null);}setError(true);}finally{setBusy(false);}
 }
 if(!saved&&!allowed)return null;
 return <div className="space-y-2 border-t pt-2">
  {saved?<p role="status">{text('withdrawUnknown')}</p>:<label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{text('withdrawConsent')}</label>}
  <Btn disabled={!online||busy||!saved&&!consent} onClick={()=>void submit()}>{busy?commerceText(locale,'processing'):text(saved?'withdrawRetry':'withdraw')}</Btn>
  {error?<p role="alert" className="text-red-700">{commerceText(locale,'error')}</p>:null}
 </div>;
}
