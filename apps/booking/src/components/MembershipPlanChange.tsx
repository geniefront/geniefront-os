import {MembershipChangeWithdrawal} from './MembershipChangeWithdrawal';
import {useEffect,useState} from 'react';
import {membershipChangeInput,membershipChangeText,membershipText,commerceText,pickText,type CustomerMembershipTerms} from '@gf/contracts';
import {commerceApi} from '../lib/commerceApi';
import {useLanguage} from '../lib/i18n';
import {Btn} from './Chrome';
type Plan={versionId:string;terms:CustomerMembershipTerms;currency:string};
export type PlanChange={id:string;status:string;task_status?:string;withdrawal_requested_at?:string|null;withdrawal_task_status?:string;snapshot:{terms:CustomerMembershipTerms;currency:string;timezone:string};effective_at:string};
type Pending={plan:Plan;input:typeof membershipChangeInput._type};
export function MembershipPlanChange({slug,memberId,periodEnd,timezone,plans,services,changes,allowed,onSaved}:{slug:string;memberId:string;periodEnd:string|null;timezone:string;plans:Plan[];services:Array<{id:string;name:string}>;changes:PlanChange[];allowed:boolean;onSaved:()=>void}){
 const {locale}=useLanguage(),key=`gf-membership-change:${slug}:${memberId}`;
 const load=():Pending|null=>{try{const saved=JSON.parse(sessionStorage.getItem(key)??'null'),input=membershipChangeInput.safeParse(saved?.input);return input.success&&saved?.plan?.versionId===input.data.versionId?{plan:saved.plan,input:input.data}:null;}catch{return null;}};
 const [saved,setSaved]=useState<Pending|null>(load),[version,setVersion]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [online,setOnline]=useState(()=>navigator.onLine);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 useEffect(()=>{setSaved(load());setVersion('');setConsent(false);setError('');},[key]);
 const text=(k:Parameters<typeof membershipChangeText>[1])=>membershipChangeText(locale,k),t=(k:Parameters<typeof membershipText>[1])=>membershipText(locale,k);
 const chosen=saved?.plan??plans.find(p=>p.versionId===version),effective=saved?.input.expectedPeriodEnd??periodEnd;
 useEffect(()=>{if(!saved)setConsent(false);},[periodEnd,chosen?.versionId,chosen?.terms.amountCents,chosen?.terms.cadence,saved]);
 const pending=changes.some(c=>['pending','scheduled'].includes(c.status)),money=(n:number,currency:string)=>new Intl.NumberFormat(locale,{style:'currency',currency}).format(n/100);
 const date=(value:string)=>new Intl.DateTimeFormat(locale,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
 async function submit(){
  if(!online||busy||!chosen||!effective||!saved&&(!allowed||pending||!consent))return;
  let token:string|null;try{token=sessionStorage.getItem(`gf-membership:${slug}:${memberId}`);}catch{setError(commerceText(locale,'noAccess'));return;}if(!token)return;
  const request=saved??{plan:chosen,input:{versionId:chosen.versionId,businessKey:crypto.randomUUID(),expectedPeriodEnd:new Date(effective).toISOString(),consent:{accepted:true as const,versionId:chosen.versionId,amountCents:chosen.terms.amountCents,cadence:chosen.terms.cadence,effectiveAt:new Date(effective).toISOString()}}};
  setBusy(true);setError('');
  try{sessionStorage.setItem(key,JSON.stringify(request));setSaved(request);
   const result=await commerceApi<{changeId:string;status:string}>(slug,`/memberships/${memberId}/plan-change`,{token,body:{...request.input,locale}});
   if(!result.changeId||!['pending','scheduled','applied','withdrawn','canceled'].includes(result.status))throw new Error('Unknown plan change result');
   sessionStorage.removeItem(key);setSaved(null);setVersion('');setConsent(false);onSaved();
  }catch(e){const failure=e as {status?:number;code?:string};if(!saved&&failure.status&&failure.status<500&&['VALIDATION_FAILED','NOT_FOUND'].includes(failure.code??'')){sessionStorage.removeItem(key);setSaved(null);}setError(commerceText(locale,'error'));}finally{setBusy(false);}
 }
 if(!saved&&!allowed&&!changes.length)return null;
 return <section className="space-y-3 rounded-xl border p-4">
  <h3 className="font-semibold">{text('title')}</h3>
  {changes.map(change=><div key={change.id} className="space-y-1 text-sm"><p className="font-medium">{text(change.status==='canceled'?'canceled':change.status==='withdrawn'?'withdrawn':change.status==='applied'?'applied':change.withdrawal_requested_at?'withdrawing':change.status==='scheduled'?'scheduled':'pending')}</p>
   <p>{pickText(change.snapshot.terms.name,locale)} · {money(change.snapshot.terms.amountCents,change.snapshot.currency)} / {t(change.snapshot.terms.cadence)}</p><p>{text('date')}: {date(change.effective_at)}</p>
   {change.status==='pending'&&change.task_status==='failed'||change.withdrawal_requested_at&&change.withdrawal_task_status==='review'?<p role="alert">{text('failed')}</p>:null}<MembershipChangeWithdrawal slug={slug} memberId={memberId} change={change} onSaved={onSaved}/></div>)}
  {saved?<p role="status" className="text-sm">{text('unknown')}</p>:null}
  {(saved||allowed&&!pending)&&<>
   {!saved?<label className="block text-sm">{text('select')}<select className="booking-input mt-1 w-full" value={version} disabled={busy} onChange={e=>{setVersion(e.target.value);setConsent(false);}}><option value="">—</option>{plans.map(p=><option key={p.versionId} value={p.versionId}>{pickText(p.terms.name,locale)} · {money(p.terms.amountCents,p.currency)} / {t(p.terms.cadence)}</option>)}</select></label>:null}
   {chosen&&effective?<div className="space-y-2 text-sm"><p className="font-semibold">{pickText(chosen.terms.name,locale)} · {money(chosen.terms.amountCents,chosen.currency)} / {t(chosen.terms.cadence)}</p>
    <p>{text('date')}: {date(effective)}</p><p>{text('notice')}</p><p>{t(chosen.terms.benefitFrequency==='month'?'benefitMonth':'benefitPeriod')} · {t('quota')}: {chosen.terms.quantity}</p>
    <p>{t('covered')}: {chosen.terms.serviceIds.map(id=>services.find(s=>s.id===id)?.name??'').filter(Boolean).join(' · ')}</p>
    {chosen.terms.discountBps>0?<p>{t('discount')}: {chosen.terms.discountBps/100}% · {chosen.terms.discountServiceIds.map(id=>services.find(s=>s.id===id)?.name??'').filter(Boolean).join(' · ')}</p>:null}<p>{t('noRollover')}</p>
    {!saved?<label className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{text('consent')}</label>:null}
    <Btn primary disabled={!online||busy||!saved&&!consent} onClick={()=>void submit()}>{busy?commerceText(locale,'processing'):text(saved?'retry':'confirm')}</Btn>
   </div>:null}
  </>}{error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}
 </section>;
}
