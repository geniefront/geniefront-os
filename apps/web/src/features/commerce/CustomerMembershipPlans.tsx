import {MembershipAccess} from './MembershipAccess';
import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {membershipText,commerceText,membershipChangeText,membershipAccessText,pickText,type MembershipTextKey,type CustomerMembershipTerms} from '@gf/contracts';
import {apiGet,runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {useAttemptKey} from '@/lib/idempotency';
import {parseMoney} from '@/lib/validation';
import {Card,CardContent} from '@/components/ui/Card';
import {Input} from '@/components/ui/Input';
import {Button} from '@/components/ui/Button';
import {MembershipTermination} from './MembershipTermination';
interface Plan{id:string;version_id:string;version:number;terms:CustomerMembershipTerms;currency:string;active:boolean;online_sale:boolean;}
interface Data{plans:Plan[];services:Array<{id:string;name:string}>;members:Array<{id:string;display_name:string;provider_status:string;paid_invoices:number;available_quantity:number;commerce_frozen?:boolean;next_change?:{status:string;withdrawalRequested?:boolean;effectiveAt:string;snapshot:{terms:CustomerMembershipTerms;currency:string;timezone:string}}|null;
 current_period_end:string|null;cancel_at_period_end:boolean;snapshot:{terms:CustomerMembershipTerms;currency:string;timezone:string}}>;}
export function CustomerMembershipPlans({language,enabled=true}:{language:string;enabled?:boolean}){
 const {membershipId,can,isOnline}=useSession(),attempt=useAttemptKey();
 const query=useQuery({queryKey:['desk','customer-memberships',membershipId],queryFn:()=>apiGet<Data>('/v1/desk/commerce/memberships'),enabled:!!membershipId&&can('commerce.read'),refetchInterval:10000});
 const [selected,setSelected]=useState(''),[name,setName]=useState(''),[amount,setAmount]=useState('99'),[cadence,setCadence]=useState<'month'|'year'>('month');
 const [frequency,setFrequency]=useState<'month'|'billing_period'>('month'),[quantity,setQuantity]=useState('1'),[services,setServices]=useState<string[]>([]);
 const [discount,setDiscount]=useState('0'),[discountServices,setDiscountServices]=useState<string[]>([]),[commission,setCommission]=useState<CustomerMembershipTerms['commissionBasis']>('sale_price');
 const [active,setActive]=useState(true),[online,setOnline]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [accessFor,setAccessFor]=useState<string|null>(null);
 const [terminationFor,setTerminationFor]=useState<string|null>(null);
 const text=(key:MembershipTextKey)=>membershipText(language,key),current=query.data?.plans.find(p=>p.id===selected);
 function choose(id:string){const p=query.data?.plans.find(x=>x.id===id);setSelected(id);setName(p?.terms.name[language]??p?.terms.name.en??'');
  setAmount(String((p?.terms.amountCents??9900)/100));setCadence(p?.terms.cadence??'month');setFrequency(p?.terms.benefitFrequency??'month');
  setQuantity(String(p?.terms.quantity??1));setServices(p?.terms.serviceIds??[]);setDiscount(String((p?.terms.discountBps??0)/100));
  setDiscountServices(p?.terms.discountServiceIds??[]);setCommission(p?.terms.commissionBasis??'sale_price');setActive(p?.active??true);setOnline(p?.online_sale??false);}
 async function save(){
  const price=parseMoney(amount),bps=Number(discount)*100,n=Number(quantity);if(!price.ok||!Number.isInteger(bps)||!Number.isInteger(n))return setNotice(commerceText(language,'error'));
  const input={...(current?{planId:current.id,expectedVersion:current.version}:{}),active,onlineSale:online,
   terms:{name:{...current?.terms.name,en:current?.terms.name.en??name,[language]:name},amountCents:price.value,cadence,benefitFrequency:frequency,
    quantity:n,serviceIds:services,discountBps:bps,discountServiceIds:discountServices,commissionBasis:commission}};
  const intent=['membership-plan',membershipId,input];setBusy(true);setNotice('');
  try{await runCommand('commerce.saveMembershipPlan',input,membershipId!,attempt.take(intent));attempt.settle(intent);await query.refetch();choose('');setNotice(commerceText(language,'success'));}
  catch{setNotice(commerceText(language,'error'));}finally{setBusy(false);}
 }
 const disabled=!enabled||!isOnline||busy;
 if(!can('commerce.read'))return null;
 return <Card><CardContent className="space-y-4"><h2 className="text-lg font-semibold">{text('title')}</h2>
  {notice?<p role="status">{notice}</p>:null}{query.error?<p role="alert">{commerceText(language,'error')}</p>:null}
  {can('commerce.configure')&&query.data?<form className="space-y-4" onSubmit={e=>{e.preventDefault();void save();}}>
   <select aria-label={text('name')} className="w-full rounded-lg border p-2" value={selected} disabled={disabled} onChange={e=>choose(e.target.value)}><option value="">{text('newPlan')}</option>
    {query.data.plans.map(p=><option key={p.id} value={p.id}>{p.terms.name[language]??p.terms.name.en} · {text('version')} {p.version}</option>)}</select>
   <div className="grid gap-3 sm:grid-cols-3"><label>{text('name')}<Input required value={name} maxLength={120} disabled={disabled} onChange={e=>setName(e.target.value)}/></label>
    <label>{text('amount')}<Input required inputMode="decimal" value={amount} disabled={disabled} onChange={e=>setAmount(e.target.value)}/></label>
    <label>{text('monthly')} / {text('annual')}<select className="w-full rounded-lg border p-2" value={cadence} disabled={disabled} onChange={e=>setCadence(e.target.value as 'month'|'year')}>
     <option value="month">{text('monthly')}</option><option value="year">{text('annual')}</option></select></label></div>
   <label className="block">{text('benefits')}<select className="ml-3 rounded-lg border p-2" value={frequency} disabled={disabled} onChange={e=>setFrequency(e.target.value as 'month'|'billing_period')}>
    <option value="month">{text('benefitMonth')}</option><option value="billing_period">{text('benefitPeriod')}</option></select></label>
   <label className="block">{text('quantity')}<Input type="number" min={0} max={1000} required value={quantity} disabled={disabled} onChange={e=>setQuantity(e.target.value)}/></label>
   <fieldset className="flex flex-wrap gap-3"><legend>{text('covered')}</legend>{query.data.services.map(s=><label key={s.id} className="flex items-center gap-2 text-sm">
    <input type="checkbox" disabled={disabled} checked={services.includes(s.id)} onChange={e=>setServices(e.target.checked?[...services,s.id]:services.filter(id=>id!==s.id))}/>{s.name}</label>)}</fieldset>
   <label className="block">{text('discount')}<Input type="number" min={0} max={100} step="0.01" required value={discount} disabled={disabled} onChange={e=>setDiscount(e.target.value)}/></label>
   <fieldset className="flex flex-wrap gap-3"><legend>{text('discountServices')}</legend>{query.data.services.map(s=><label key={s.id} className="flex items-center gap-2 text-sm">
    <input type="checkbox" disabled={disabled} checked={discountServices.includes(s.id)} onChange={e=>setDiscountServices(e.target.checked?[...discountServices,s.id]:discountServices.filter(id=>id!==s.id))}/>{s.name}</label>)}</fieldset>
   <label className="block">{text('commission')}<select className="ml-3 rounded-lg border p-2" value={commission} disabled={disabled} onChange={e=>setCommission(e.target.value as CustomerMembershipTerms['commissionBasis'])}>
    <option value="sale_price">{text('priceBasis')}</option><option value="catalog_price">{text('catalogBasis')}</option><option value="zero">{text('zeroBasis')}</option></select></label>
   <div className="flex flex-wrap gap-4"><label><input type="checkbox" checked={active} disabled={disabled} onChange={e=>setActive(e.target.checked)}/> {text('active')}</label>
    <label><input type="checkbox" checked={online} disabled={disabled} onChange={e=>setOnline(e.target.checked)}/> {text('online')}</label></div>
   <Button type="submit" disabled={disabled}>{text('save')}</Button>
  </form>:null}
  {query.data?.members.map(m=><article key={m.id} className="rounded-lg border p-3"><p className="font-medium">{m.display_name} · {m.snapshot.terms.name[language]??m.snapshot.terms.name.en}</p>
   <p>{text(m.provider_status==='active'&&m.paid_invoices>0?'activeStatus':['past_due','canceled','unpaid','incomplete','incomplete_expired','paused'].includes(m.provider_status)?m.provider_status as MembershipTextKey:'pending')}</p>
   <p>{text('paidBills')}: {m.paid_invoices} · {text('available')}: {m.available_quantity}</p>
   {m.next_change?<p className="text-sm">{membershipChangeText(language,m.next_change.withdrawalRequested?'withdrawing':m.next_change.status==='scheduled'?'scheduled':'pending')} · {pickText(m.next_change.snapshot.terms.name,language)} · {new Intl.NumberFormat(language,{style:'currency',currency:m.next_change.snapshot.currency}).format(m.next_change.snapshot.terms.amountCents/100)} / {text(m.next_change.snapshot.terms.cadence)} · {new Intl.DateTimeFormat(language,{timeZone:m.next_change.snapshot.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(m.next_change.effectiveAt))}</p>:null}
   {m.cancel_at_period_end?<p>{text('cancelAtEnd')}</p>:null}
   {can('commerce.configure')&&m.paid_invoices>0?<Button variant="outline" disabled={!isOnline} onPress={()=>setAccessFor(m.id)}>{membershipAccessText(language,'title')}</Button>:null}
   {can('commerce.refund')&&m.paid_invoices>0?<Button variant="outline" disabled={!isOnline} onPress={()=>setTerminationFor(m.id)}>{text('terminationTitle')}</Button>:null}
  </article>)}
  {accessFor?<MembershipAccess id={accessFor} language={language} onClose={()=>setAccessFor(null)}/>:null}
  {terminationFor?<MembershipTermination id={terminationFor} language={language} onClose={()=>setTerminationFor(null)}/>:null}
 </CardContent></Card>;
}
