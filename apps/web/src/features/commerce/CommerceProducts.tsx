import {useState} from 'react';
import {commerceText,type CommerceTextKey} from '@gf/contracts';
import {parseMoney} from '@/lib/validation';
import {Input} from '@/components/ui/Input';
import {Button} from '@/components/ui/Button';
import {Card,CardContent} from '@/components/ui/Card';
import type {CommerceData} from './api';
import type {PackageTemplateView} from '@/features/marketing/types';
interface Props {
 language:string;writable:boolean;canSavePackages:boolean;gifts:CommerceData['giftTemplates'];packages:PackageTemplateView[];
 services:Array<{id:string;name:string;priceCents:number}>;
 save:(command:'giftcard.saveTemplate'|'package.saveTemplate',input:unknown)=>Promise<{templateId:string}>;
 action:(work:()=>Promise<unknown>)=>Promise<void>;
}
/** Edits the existing catalog commands; purchased rights keep their original snapshots. */
export function CommerceProducts({language,writable,canSavePackages,gifts,packages,services,save,action}:Props){
 const text=(key:CommerceTextKey)=>commerceText(language,key);
 const [selection,setSelection]=useState('new:gift_card'),[name,setName]=useState(''),[price,setPrice]=useState('80'),[face,setFace]=useState('100');
 const [sessions,setSessions]=useState('5'),[days,setDays]=useState(''),[scope,setScope]=useState<'location'|'org'>('location');
 const [online,setOnline]=useState(false),[active,setActive]=useState(true),[serviceIds,setServiceIds]=useState<string[]>([]);
 const [coverage,setCoverage]=useState<'bundle'|'any_included'>('any_included'),[commission,setCommission]=useState<'catalog_price'|'sale_price'|'zero'>('sale_price');
 const isGift=selection==='new:gift_card'||selection.startsWith('gift:');
 const selectedGift=gifts.find(g=>selection===`gift:${g.id}`),selectedPackage=packages.find(p=>selection===`package:${p.id}`);
 function choose(value:string){
  setSelection(value);const g=gifts.find(t=>value===`gift:${t.id}`),p=packages.find(t=>value===`package:${t.id}`);
  setName(g?.name??p?.name??'');setPrice(String((g?.sale_price_cents??p?.priceCents??8000)/100));setFace(String((g?.face_value_cents??10000)/100));
  setDays(String(g?.valid_days??p?.validDays??''));setSessions(String(p?.totalUnits??5));setScope(g?.scope??p?.scope??'location');
  setOnline(g?.online_sale??p?.onlineSale??false);setActive(g?.active??p?.active??true);setServiceIds(p?.serviceIds??[]);
  setCoverage(p?.coverageMode??'any_included');setCommission(p?.commissionBasis??'sale_price');
 }
 async function submit(){
  const value=parseMoney(price),faceValue=parseMoney(face);if(!value.ok||(isGift&&!faceValue.ok))throw new Error('invalid_amount');
  const oldNames=isGift?selectedGift?.names:selectedPackage?.names;
  const names={...(oldNames&&typeof oldNames==='object'&&!Array.isArray(oldNames)?oldNames as Record<string,string>:{}),[language]:name.trim()};
  const validDays=days.trim()?Number(days):null;
  const result=isGift?await save('giftcard.saveTemplate',{id:selectedGift?.id,name:names,faceValueCents:faceValue.ok?faceValue.value:0,salePriceCents:value.value,
    validDays,scope,onlineSale:online,active}):await save('package.saveTemplate',{templateId:selectedPackage?.id,name:names,priceCents:value.value,sessions:Number(sessions),
    validDays,scope,onlineSale:online,active,serviceIds,coverageMode:coverage,commissionBasis:commission});
  setSelection(`${isGift?'gift':'package'}:${result.templateId}`);
 }
 return <Card><CardContent className="p-5"><details><summary className="cursor-pointer text-lg font-semibold">{text('products')}</summary>
  <form className="mt-5" onSubmit={e=>{e.preventDefault();void action(submit);}}><fieldset disabled={!writable} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
   <label className="space-y-1 text-sm">{text('product')}<select value={selection} onChange={e=>choose(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
    <option value="new:gift_card">{text('newProduct')} · {text('gifts')}</option>{canSavePackages?<option value="new:package">{text('newProduct')} · {text('packages')}</option>:null}
    {gifts.map(g=><option key={g.id} value={`gift:${g.id}`}>{g.name}</option>)}{canSavePackages?packages.map(p=><option key={p.id} value={`package:${p.id}`}>{p.name}</option>):null}
   </select></label>
   <label className="space-y-1 text-sm">{text('productName')}<Input value={name} onChange={e=>setName(e.target.value)} required maxLength={120}/></label>
   <label className="space-y-1 text-sm">{text('price')}<Input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} required/></label>
   {isGift?<label className="space-y-1 text-sm">{text('faceValue')}<Input inputMode="decimal" value={face} onChange={e=>setFace(e.target.value)} required/></label>:
    <label className="space-y-1 text-sm">{text('sessions')}<Input type="number" min={0} step={1} value={sessions} onChange={e=>setSessions(e.target.value)} required/>
     {Number(sessions)===0?<span>{text('unlimited')}</span>:null}</label>}
   <label className="space-y-1 text-sm">{text('validDays')}<Input type="number" min={1} max={3650} step={1} value={days} onChange={e=>setDays(e.target.value)} required={!isGift&&Number(sessions)===0}/></label>
   <label className="space-y-1 text-sm">{text('scope')}<select value={scope} onChange={e=>setScope(e.target.value as 'location'|'org')} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
    <option value="location">{text('storeOnly')}</option><option value="org">{text('organization')}</option></select></label>
   {!isGift?<><label className="space-y-1 text-sm">{text('coverage')}<select value={coverage} onChange={e=>setCoverage(e.target.value as 'bundle'|'any_included')} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
    <option value="any_included">{text('oneService')}</option><option value="bundle">{text('serviceBundle')}</option></select></label>
    <label className="space-y-1 text-sm">{text('commission')}<select value={commission} onChange={e=>setCommission(e.target.value as typeof commission)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
     <option value="sale_price">{text('purchasePrice')}</option><option value="catalog_price">{text('catalogPrice')}</option><option value="zero">{text('zero')}</option></select></label>
    <fieldset className="space-y-2 sm:col-span-2 lg:col-span-3"><legend className="text-sm font-medium">{text('includedServices')}</legend>
     <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{services.map(s=><label key={s.id} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={serviceIds.includes(s.id)} onChange={e=>setServiceIds(current=>e.target.checked?[...current,s.id]:current.filter(id=>id!==s.id))}/>{s.name}</label>)}</div>
    </fieldset></>:null}
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={online} onChange={e=>setOnline(e.target.checked)}/>{text('onlineSale')}</label>
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>{text('active')}</label>
   <div className="sm:col-span-2 lg:col-span-3"><Button type="submit">{text('save')}</Button></div>
  </fieldset></form>
 </details></CardContent></Card>;
}
