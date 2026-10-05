import {useEffect,useState} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {commerceText,membershipText,membershipAccessText,pickText,type MembershipTextKey,type CustomerMembershipTerms} from '@gf/contracts';
import {Card,Shell,Btn} from '../components/Chrome';
import {useLanguage,type Locale} from '../lib/i18n';
import {commerceApi} from '../lib/commerceApi';
import {MembershipPlanChange,type PlanChange} from '../components/MembershipPlanChange';
const languages=[['en','English'],['zh-Hans','简体中文'],['zh-Hant','繁體中文'],['es','Español'],['ko','한국어'],['vi','Tiếng Việt']] as const;
interface Plan{id:string;versionId:string;name:string;currency:string;terms:CustomerMembershipTerms;}
interface Catalog{shopName:string;available:boolean;currency:string;timezone:string;plans:Plan[];services?:Array<{id:string;name:string}>;}
type InvoiceContract={terms:CustomerMembershipTerms;currency:string;timezone:string};
interface MemberStatus{billingSnapshot?:InvoiceContract;benefitSnapshot?:InvoiceContract|null;planChanges?:PlanChange[];accountDisconnected?:boolean;portalAvailable?:boolean;benefitsActive?:boolean;termination?:{status:string;unused_benefits:string}|null;membership:{id:string;provider_status:string;current_period_end:string|null;cancel_at_period_end:boolean;scheduled_cancel_at?:string|null;commerce_frozen:boolean;terminated_at:string|null;
 snapshot:{terms:CustomerMembershipTerms;currency:string;timezone:string}};timezone:string;checkoutUrl:string|null;
 cycles:Array<{id:string;starts_at:string;ends_at:string;quantity:number;available_quantity:number;status:string;snapshot?:InvoiceContract}>;
 invoices:Array<{id:string;amount_cents:number;currency:string;paid_at:string;period_start:string;period_end:string;refunded_cents?:number;pending_refund_cents?:number;refund_failed?:boolean;snapshot?:InvoiceContract}>;ledger?:BenefitEntry[];}
type BenefitEntry={id:string;entry:string;quantity:number;created_at:string;planned_quantity?:number};
interface Attempt{plan:Plan;name:string;email:string;locale:string;businessKey:string;}
export function MembershipsPage(){
 const {slug=''}=useParams(),[params,setParams]=useSearchParams(),{locale,setLocale}=useLanguage();
 const [catalog,setCatalog]=useState<Catalog|null>(null),[selected,setSelected]=useState<Plan|null>(null),[status,setStatus]=useState<MemberStatus|null>(null);
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [pending,setPending]=useState<Attempt|null>(null);const memberId=params.get('member');
 const [actionError,setActionError]=useState('');
 const [readRetry,setReadRetry]=useState(0);
 useEffect(()=>{const recover=()=>{if(/^#m\/cm_[A-Za-z0-9_-]{43}$/.test(window.location.hash))setReadRetry(value=>value+1);};window.addEventListener('hashchange',recover);return()=>window.removeEventListener('hashchange',recover);},[]);
 const t=(key:MembershipTextKey)=>membershipText(locale,key),common=(key:'error'|'back'|'name'|'email'|'unavailable'|'processing'|'noAccess'|'refresh')=>key==='noAccess'?membershipAccessText(locale,'noAccess'):commerceText(locale,key);
 const money=(cents:number,currency:string)=>new Intl.NumberFormat(locale,{style:'currency',currency}).format(cents/100);
 const date=(value:string,tz=catalog?.timezone??status?.timezone??'UTC')=>new Intl.DateTimeFormat(locale,{timeZone:tz,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
 useEffect(()=>{
  try{const saved=sessionStorage.getItem(`gf-membership-attempt:${slug}`);if(saved){const a=JSON.parse(saved) as Attempt;
   if(a.plan?.versionId&&a.businessKey&&a.name&&a.email){setPending(a);setSelected(a.plan);setName(a.name);setEmail(a.email);setConsent(true);}}}catch{}
 },[slug]);
 useEffect(()=>{const controller=new AbortController();commerceApi<Catalog>(slug,`/memberships?locale=${encodeURIComponent(locale)}`,{signal:controller.signal})
  .then(setCatalog).catch(e=>{if(e.name!=='AbortError')setError('error');});return()=>controller.abort();},[slug,locale,readRetry]);
 useEffect(()=>{
  setStatus(null);setError('');setActionError('');if(!memberId)return;
  let token:string|null=null;
  try{const fragment=window.location.hash.match(/^#m\/(cm_[A-Za-z0-9_-]{43})$/);if(fragment){sessionStorage.setItem(`gf-membership:${slug}:${memberId}`,fragment[1]!);
    window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}`);}token=sessionStorage.getItem(`gf-membership:${slug}:${memberId}`);}catch{}
  if(!token){setError('noAccess');return;}
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let checks=0;
  async function poll(){try{const result=await commerceApi<MemberStatus>(slug,`/memberships/${memberId}`,{token:token!,signal:controller.signal});
   if(controller.signal.aborted)return;setStatus(result);setError('');if(checks++<150)timer=setTimeout(()=>void poll(),4000);
  }catch(e){if(!controller.signal.aborted){if([401,403,404].includes((e as {status?:number}).status??0)){setStatus(null);setError('noAccess');}else setError('error');}}}void poll();return()=>{controller.abort();clearTimeout(timer);};
 },[slug,memberId,readRetry]);
 async function enroll(){
  if(!selected||!consent)return;setBusy(true);setError('');
  const a=pending??{plan:selected,name:name.trim(),email:email.trim(),locale,businessKey:crypto.randomUUID()};
  try{
   sessionStorage.setItem(`gf-membership-attempt:${slug}`,JSON.stringify(a));setPending(a);
   const result=await commerceApi<{membershipId:string;orderId:string;token:string;url:string|null}>(slug,'/memberships',{body:{versionId:a.plan.versionId,
    businessKey:a.businessKey,customer:{name:a.name,email:a.email},locale:a.locale,
    consent:{accepted:true,versionId:a.plan.versionId,amountCents:a.plan.terms.amountCents,cadence:a.plan.terms.cadence}}});
   sessionStorage.setItem(`gf-membership:${slug}:${result.membershipId}`,result.token);sessionStorage.removeItem(`gf-membership-attempt:${slug}`);setPending(null);
   setParams({member:result.membershipId});if(result.url)window.location.assign(result.url);
  }catch(e){const statusCode=(e as {status?:number}).status;if(statusCode&&statusCode<500){sessionStorage.removeItem(`gf-membership-attempt:${slug}`);setPending(null);}
   setError('error');}finally{setBusy(false);}
 }
 async function portal(){
  if(!memberId)return;setBusy(true);setActionError('');
  try{
   const token=sessionStorage.getItem(`gf-membership:${slug}:${memberId}`);if(!token)throw new Error('missing_access');
   const result=await commerceApi<{url:string}>(slug,`/memberships/${memberId}/portal`,{token,body:{locale,businessKey:crypto.randomUUID()}});
   window.location.assign(result.url);
  }catch{setActionError('error');}finally{setBusy(false);}
 }
 const paid=status?.invoices.length??0,s=status?.membership,ended=!!s&&['canceled','incomplete_expired'].includes(s.provider_status),termination=status?.termination;
 const billing=status?.billingSnapshot??s?.snapshot,benefit=status?.benefitSnapshot===undefined?s?.snapshot:status.benefitSnapshot;
 const statusKey:MembershipTextKey=s?.commerce_frozen?'pending':s?.provider_status==='active'?(paid?'activeStatus':'pending'):
  ['incomplete','incomplete_expired','past_due','canceled','unpaid','paused','trialing'].includes(s?.provider_status??'')?s!.provider_status as MembershipTextKey:'pending';
 return <Shell><header className="flex flex-wrap items-center justify-between gap-3 py-6"><Link to={`/${slug}/shop`} className="text-sm font-semibold text-[var(--brand)]">{common('back')}</Link>
  <select aria-label="Language" className="language-select" value={locale} onChange={e=>setLocale(e.target.value as Locale)}>{languages.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></header>
  <p className="text-sm text-[var(--muted)]">{catalog?.shopName}</p><h1 className="my-3 text-3xl font-semibold">{t('title')}</h1>
  {error||actionError?<p role="alert" className="my-4 rounded-xl bg-rose-50 p-4 text-rose-800">{common((actionError||error) as 'error'|'noAccess')}</p>:null}
  {memberId&&error==='error'?<Btn disabled={busy} onClick={()=>setReadRetry(value=>value+1)}>{common('refresh')}</Btn>:null}
  {memberId?error==='noAccess'?null:<Card className="my-6 space-y-4 p-6">{status&&s?<>
   <h2 className="text-xl font-semibold">{t(statusKey)}</h2><p>{pickText(billing!.terms.name,locale)}</p>
   <p>{money(billing!.terms.amountCents,billing!.currency)} / {t(billing!.terms.cadence)}</p>
   {s.current_period_end&&!ended&&!termination?<p>{t(s.cancel_at_period_end?'expires':'nextCharge')}: {date(s.current_period_end,s.snapshot.timezone)}</p>:null}
   {s.cancel_at_period_end&&!ended&&!termination?<p>{t('cancelAtEnd')}</p>:null}
   {!s.cancel_at_period_end&&s.scheduled_cancel_at&&!ended&&!termination?<p>{t('cancelScheduled')}: {date(s.scheduled_cancel_at,s.snapshot.timezone)}</p>:null}
   {termination?<p role="status" className="rounded-xl border p-3">{t(termination.status==='pending'?'terminationPending':termination.unused_benefits==='revoke_all'?'terminationRevoked':'terminationKept')}</p>:null}
   {status.accountDisconnected?<p role="status" className="rounded-xl bg-amber-50 p-3">{t('disconnected')}</p>:null}
   <p className="font-semibold">{t('available')}: {status.cycles.reduce((sum,c)=>sum+c.available_quantity,0)}</p>
   {benefit&&benefit.terms.discountBps>0?<div className="rounded-xl border p-3 text-sm space-y-2">
    <p className="font-semibold">{t('discount')}: {benefit.terms.discountBps/100}%</p>
    <p>{t('discountServices')}: {benefit.terms.discountServiceIds.map(id=>catalog?.services?.find(service=>service.id===id)?.name??'').filter(Boolean).join(' · ')}</p>
    <p>{t('discountChoiceHint')}</p>
    {status.benefitsActive===false?<p>{t('benefitsInactive')}</p>:null}
   </div>:null}
   <p className="text-sm">{t('noRollover')}</p>
   <h3 className="font-semibold">{t('benefits')}</h3>{status.cycles.map(c=><div key={c.id} className="rounded-xl border p-3 text-sm">
    {c.snapshot?<p className="font-medium">{pickText(c.snapshot.terms.name,locale)}</p>:null}
    <p>{date(c.starts_at,c.snapshot?.timezone??s.snapshot.timezone)} → {date(c.ends_at,c.snapshot?.timezone??s.snapshot.timezone)}</p><p>{t('available')}: {c.available_quantity} / {c.quantity}</p>{c.status==='stopped'?<p>{t('futureStopped')}</p>:null}</div>)}
   <h3 className="font-semibold">{t('paidBills')}: {paid}</h3>{status.invoices.map(i=><div key={i.id} className="text-sm">{i.snapshot?<p className="font-medium">{pickText(i.snapshot.terms.name,locale)}</p>:null}<p>{money(i.amount_cents,i.currency)} · {date(i.paid_at,i.snapshot?.timezone??s.snapshot.timezone)}</p>
    {i.refunded_cents?<p>{t('refundTotal')}: {money(i.refunded_cents,i.currency)}</p>:null}
    {i.pending_refund_cents?<p>{t('refundPending')}: {money(i.pending_refund_cents,i.currency)}</p>:null}{i.refund_failed?<p>{t('refundFailed')}</p>:null}</div>)}
   {status.ledger?.length?<><h3 className="font-semibold">{t('benefitHistory')}</h3>
    {status.ledger.map(row=><p key={row.id} className="text-sm">{date(row.created_at,s.snapshot.timezone)} · {t(row.entry==='redeem'?'redeemBenefit':row.entry==='restore'?'restoreBenefit':row.entry==='expire'?'expireBenefit':row.entry==='stop'?'futureStopped':row.entry==='revoke'?'revokedBenefit':'issuedBenefit')} · {row.entry==='stop'?row.planned_quantity:`${row.quantity>0?'+':''}${row.quantity}`}</p>)}</>:null}
   {status.checkoutUrl?<a className="booking-btn block text-center" href={status.checkoutUrl}>{t('pay')}</a>:null}
   <MembershipPlanChange slug={slug} memberId={memberId} periodEnd={s.current_period_end} timezone={s.snapshot.timezone} plans={catalog?.plans??[]} services={catalog?.services??[]} changes={status.planChanges??[]}
    allowed={!!(catalog?.available&&paid&&s.provider_status==='active'&&!s.commerce_frozen&&!s.terminated_at&&!s.cancel_at_period_end&&!s.scheduled_cancel_at&&!status.accountDisconnected)} onSaved={()=>setReadRetry(value=>value+1)}/>
   {status.portalAvailable?<Btn disabled={busy} onClick={()=>void portal()}>{t(ended?'invoicesOnly':'management')}</Btn>:null}
   <p className="text-sm text-[var(--muted)]">{t('managementHint')}</p>
  </>:!error?<p aria-live="polite">{common('processing')}</p>:null}</Card>:<>
   {catalog&&!catalog.available?<p className="my-4 rounded-xl bg-amber-50 p-4">{common('unavailable')}</p>:null}
   <div className="my-6 grid gap-4 sm:grid-cols-2">{catalog?.plans.map(plan=><Card className="space-y-3 p-6" key={plan.versionId}>
    <h2 className="text-xl font-semibold">{plan.name}</h2><p className="text-2xl font-semibold">{money(plan.terms.amountCents,plan.currency)} / {t(plan.terms.cadence)}</p>
    <p>{t(plan.terms.benefitFrequency==='month'?'benefitMonth':'benefitPeriod')}</p><p>{t('quota')}: {plan.terms.quantity}</p>
    <p className="text-sm">{t('covered')}: {plan.terms.serviceIds.map(id=>catalog.services?.find(s=>s.id===id)?.name??'').filter(Boolean).join(' · ')}</p>
    {plan.terms.discountBps>0?<p>{t('discount')}: {plan.terms.discountBps/100}%</p>:null}
    <Btn primary disabled={!catalog.available||busy||!!pending} onClick={()=>{setSelected(plan);setConsent(false);setError('');}}>{t(plan.terms.cadence==='month'?'monthly':'annual')}</Btn>
   </Card>)}</div>
   {selected?<Card className="mx-auto mb-8 max-w-xl space-y-4 p-6"><h2 className="text-xl font-semibold">{selected.name}</h2>
    <p>{money(selected.terms.amountCents,selected.currency)} / {t(selected.terms.cadence)}</p><p className="text-sm">{t('renewalHint')}</p><p className="text-sm">{t('noRollover')}</p>
    <p>{t(selected.terms.benefitFrequency==='month'?'benefitMonth':'benefitPeriod')} · {t('quota')}: {selected.terms.quantity}</p>
    <p className="text-sm">{t('covered')}: {selected.terms.serviceIds.map(id=>catalog?.services?.find(s=>s.id===id)?.name??'').filter(Boolean).join(' · ')}</p>
    {selected.terms.discountBps>0?<p className="text-sm">{t('discount')}: {selected.terms.discountBps/100}% · {selected.terms.discountServiceIds.map(id=>catalog?.services?.find(s=>s.id===id)?.name??'').filter(Boolean).join(' · ')}</p>:null}
    <form className="space-y-4" onSubmit={e=>{e.preventDefault();void enroll();}}>
     <label className="block text-sm">{common('name')}<input className="booking-input mt-2 w-full" autoComplete="name" required maxLength={120} value={name} readOnly={!!pending} onChange={e=>setName(e.target.value)}/></label>
     <label className="block text-sm">{common('email')}<input className="booking-input mt-2 w-full" autoComplete="email" type="email" required maxLength={200} value={email} readOnly={!!pending} onChange={e=>setEmail(e.target.value)}/></label>
     <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={consent} disabled={!!pending} required className="mt-1" onChange={e=>setConsent(e.target.checked)}/>{t('consent')}</label>
     <Btn primary type="submit" disabled={busy||!consent||(!pending&&!catalog?.available)}>{busy?common('processing'):t('pay')}</Btn>
    </form></Card>:null}
  </>}
 </Shell>;
}
