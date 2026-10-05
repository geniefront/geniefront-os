import {useEffect,useRef,useState} from 'react';
import {CommerceRequestRefund,commerceText,purchaseRefundText} from '@gf/contracts';
import {runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {parseMoney} from '@/lib/validation';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import type {CommerceData} from './api';
type Order=Pick<CommerceData['orders'][number],'payment_id'|'name'|'amount_cents'|'currency'|'refunded_cents'|'unlimited_package'>;
type Saved={order:Order;input:typeof CommerceRequestRefund.input._type;key:string};
export function PurchaseRefund({selected,language,onClose,onSaved}:{selected:Order|null;language:string;onClose:()=>void;onSaved:()=>Promise<void>}){
 const {membershipId,can,isOnline}=useSession(),storage=`gf-commerce-purchase-refund:${membershipId}`;
 const load=():Saved|null=>{try{const p=JSON.parse(sessionStorage.getItem(storage)??'null'),input=CommerceRequestRefund.input.safeParse(p?.input);return input.success&&p.order?.payment_id===input.data.paymentId&&typeof p.key==='string'&&typeof p.order.name==='string'&&/^[a-z]{3}$/i.test(p.order.currency)&&Number.isSafeInteger(p.order.amount_cents)?{...p,input:input.data}:null;}catch{return null;}};
 const [pending,setPending]=useState(load),[amount,setAmount]=useState(()=>load()?String(load()!.input.amountCents/100):''),[reason,setReason]=useState(()=>load()?.input.reason??''),[confirmed,setConfirmed]=useState(()=>!!load()?.input.unlimitedTerminationConfirmed),[busy,setBusy]=useState(false),[error,setError]=useState(false),running=useRef(false);
 const order=pending?.order??selected,text=(k:Parameters<typeof commerceText>[1])=>commerceText(language,k),copy=(k:Parameters<typeof purchaseRefundText>[1])=>purchaseRefundText(language,k);
 useEffect(()=>{if(!pending){setAmount('');setReason('');setConfirmed(false);setError(false);}},[selected?.payment_id]);
 const value=parseMoney(amount),valid=value.ok&&value.value>0&&!!order&&value.value<=order.amount_cents-order.refunded_cents,locked=busy||!!pending||!isOnline;
 async function submit(){
  if(running.current||!isOnline||!membershipId||!can('commerce.refund')||!order?.payment_id||!pending&&(!valid||reason.trim().length<2||order.unlimited_package&&!confirmed))return;
  const request=pending??{order,key:crypto.randomUUID(),input:{paymentId:order.payment_id,amountCents:value.ok?value.value:0,reason:reason.trim(),...(order.unlimited_package?{unlimitedTerminationConfirmed:true as const}:{})}};
  running.current=true;setBusy(true);setError(false);
  try{sessionStorage.setItem(storage,JSON.stringify(request));setPending(request);await runCommand('commerce.requestRefund',request.input,membershipId,request.key);
   sessionStorage.removeItem(storage);setPending(null);onClose();await onSaved();
  }catch(e){const failure=e as {code?:string};if(!pending&&failure.code==='VALIDATION_FAILED'){sessionStorage.removeItem(storage);setPending(null);setConfirmed(false);}setError(true);}finally{running.current=false;setBusy(false);}
 }
 if(!order||!can('commerce.refund'))return null;
 return <section className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">{text('refund')} · {order.name}</h3>
  <p className="text-sm">{text('price')}: {new Intl.NumberFormat(language,{style:'currency',currency:order.currency}).format(order.amount_cents/100)} · {text('refunded')}: {new Intl.NumberFormat(language,{style:'currency',currency:order.currency}).format(order.refunded_cents/100)}</p>
  {pending?<p role="status">{copy('unknown')}</p>:null}{error?<p role="alert">{text('error')}</p>:null}
  {order.unlimited_package?<p>{copy('unlimited')}</p>:null}
  <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submit();}}>
   <div className="grid gap-3 sm:grid-cols-2"><label>{text('amount')}<Input inputMode="decimal" required disabled={locked} value={amount} onChange={e=>{setAmount(e.target.value);setConfirmed(false);}}/></label>
    <label>{text('reason')}<Input minLength={2} maxLength={500} required disabled={locked} value={reason} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label></div>
   {order.unlimited_package?<label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}/>{copy('terminate')}</label>:null}
   <div className="flex flex-wrap gap-2"><Button type="submit" className="max-w-full !whitespace-normal h-auto min-h-10" disabled={busy||!isOnline||!pending&&(!valid||reason.trim().length<2||order.unlimited_package&&!confirmed)}>{busy?text('processing'):pending?copy('retry'):text('refund')}</Button>
    {!pending?<Button type="button" variant="outline" disabled={busy} onPress={onClose}>{copy('cancel')}</Button>:null}</div>
  </form>
 </section>;
}
