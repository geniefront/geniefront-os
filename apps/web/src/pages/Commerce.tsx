import {PurchaseRefund} from '@/features/commerce/PurchaseRefund';
import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {commerceText,depositText,membershipText,type CommerceTextKey} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
import {useSession} from '@/lib/session';
import {apiGet,apiPost,runCommand} from '@/lib/api';
import {useAttemptKey} from '@/lib/idempotency';
import {useCommerceQuery} from '@/features/commerce/api';
import {CommerceProducts} from '@/features/commerce/CommerceProducts';
import {CustomerMembershipPlans} from '@/features/commerce/CustomerMembershipPlans';
import {CommercePayouts} from '@/features/commerce/CommercePayouts';
import {CommerceAssets} from '@/features/commerce/CommerceAssets';
import {usePackagesQuery} from '@/features/marketing/api';
import {useCustomerList} from '@/features/customers/api';
import {useDebounced} from '@/lib/useDebounced';
import {Button} from '@/components/ui/Button';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {Input} from '@/components/ui/Input';
import {Card,CardContent} from '@/components/ui/Card';
import {PageHeader} from '@/components/ui/PageHeader';
import {PageLoading,PageError} from '@/components/ui/QueryState';
import {parseMoney} from '@/lib/validation';

export function Commerce(){
  const {language}=useLanguage();const {membershipId,can,isOnline,context}=useSession();
  const query=useCommerceQuery();const packages=usePackagesQuery();const attempt=useAttemptKey();const cache=useQueryClient();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const connectRefresh=useRef(false);
  const [giftFace,setGiftFace]=useState('100'),[giftPrice,setGiftPrice]=useState('80'),[name,setName]=useState(''),[email,setEmail]=useState('');
  const [giftTemplateId,setGiftTemplateId]=useState('');
  const [product,setProduct]=useState(()=>new URLSearchParams(window.location.search).get('product')??'gift_card'),[method,setMethod]=useState('cash'),[reference,setReference]=useState('');
  const [refundFor,setRefundFor]=useState<string|null>(null);
  const [receiptId,setReceiptId]=useState<string|null>(null);
  const [customerMode,setCustomerMode]=useState<'new'|'existing'>('new'),[customerSearch,setCustomerSearch]=useState(''),[customerId,setCustomerId]=useState('');
  const [channel,setChannel]=useState<'offline'|'complimentary'>('offline'),[giftReason,setGiftReason]=useState('');
  const [recipientName,setRecipientName]=useState(''),[recipientEmail,setRecipientEmail]=useState(''),[recipientNote,setRecipientNote]=useState('');
  const customerList=useCustomerList({q:useDebounced(customerSearch),limit:20},customerMode==='existing'&&can('customer.read'));
  const receipt=useQuery({queryKey:['desk','commerce-receipt',membershipId,receiptId],enabled:!!receiptId&&!!membershipId,
    queryFn:()=>apiGet<{order:{currency:string};asset:{code:string;balanceCents:number;qr:string}|null}>(`/v1/desk/commerce/orders/${receiptId}`)});
  const text=(key:CommerceTextKey)=>commerceText(language,key);
  const money=(n:number,currency='USD')=>new Intl.NumberFormat(language,{style:'currency',currency}).format(n/100);
  async function action(work:()=>Promise<unknown>){setBusy(true);setNotice('');try{await work();setNotice(text('success'));await query.refetch();}
    catch{setNotice(text('error'));}finally{setBusy(false);}}
  async function command<T=unknown>(name:string,input:unknown){
    const intent=[name,input,membershipId];const result=await runCommand<T>(name,input,membershipId!,attempt.take(intent));attempt.settle(intent);
    if(['commerce.createOrder','commerce.requestRefund','commerce.confirmOfflineRefund','commerce.applyExternalRefund'].includes(name))
      await Promise.all([cache.invalidateQueries({queryKey:['desk','giftcards']}),cache.invalidateQueries({queryKey:['desk','packages']}),cache.invalidateQueries({queryKey:['desk','commerce-asset']}),cache.invalidateQueries({queryKey:['desk','commerce-receipt']})]);
    return result.result;
  }
  useEffect(()=>{
    if(connectRefresh.current||!query.data?.enabled||!membershipId||!isOnline||!can('commerce.configure')
      ||new URLSearchParams(window.location.search).get('connect')!=='refresh')return;
    connectRefresh.current=true;
    const url=new URL(window.location.href);url.searchParams.delete('connect');window.history.replaceState(null,'',url);
    void action(async()=>{const link=await apiPost<{url:string}>('/v1/commerce/accounts/onboard',{idempotencyKey:crypto.randomUUID()});window.location.assign(link.url);});
  },[query.data?.enabled,membershipId,isOnline,can]);
  if(query.isLoading)return <PageLoading/>;
  if(query.error||!query.data)return <PageError error={text('error')} onRetry={()=>void query.refetch()}/>;
  const data=query.data;const writable=isOnline&&!busy;const selectedPackage=packages.data?.templates.find(p=>p.id===product);
  const selectedGift=data.giftTemplates.find(g=>g.id===giftTemplateId);
  async function sell(){
    const face=selectedGift?{ok:true as const,value:selectedGift.face_value_cents}:parseMoney(giftFace),price=selectedGift?{ok:true as const,value:selectedGift.sale_price_cents}:parseMoney(giftPrice);
    if(product==='gift_card'&&(!face.ok||!price.ok))throw new Error('invalid_amount');
    const base={kind:product==='gift_card'?'gift_card':'package',...(product==='gift_card'?selectedGift?{templateId:selectedGift.id}:{faceValueCents:face.ok?face.value:0,salePriceCents:price.ok?price.value:0}:{templateId:product}),
      ...(customerMode==='existing'?{customerId}:name.trim()&&email.trim()?{customer:{name:name.trim(),email:email.trim()}}:{}),channel,
      ...(product==='gift_card'?{recipientName,recipientNote,...(recipientEmail?{recipientEmail}:{} )}:{}),
      ...(channel==='offline'?{offlinePayment:{method,amountCents:product==='gift_card'&&price.ok?price.value:selectedPackage?.priceCents??0,reference}}:{reason:giftReason})};
    const businessKey=attempt.take(['sale',base]);
    const created=await command<{orderId:string}>('commerce.createOrder',{...base,businessKey});attempt.settle(['sale',base]);setReference('');setGiftReason('');setReceiptId(product==='gift_card'?created.orderId:null);
  }
  return <div className="space-y-6 pb-12">
    <PageHeader title={text('title')} description={text('subtitle')} actions={<Button variant="outline" onPress={()=>void query.refetch()}>{text('refresh')}</Button>}/>
    <CustomerMembershipPlans language={language} enabled={data.enabled}/>
    <CommercePayouts language={language}/>
    {notice?<p role="status" className="rounded-xl bg-slate-100 p-3 text-sm">{notice}</p>:null}
    {receiptId?<Card><CardContent className="flex flex-wrap items-center gap-4 p-5">
      {receipt.data?.asset?<><img src={receipt.data.asset.qr} alt={text('gifts')} width={140} height={140}/><div>
        <p className="break-all font-mono text-lg">{receipt.data.asset.code}</p><p className="mt-2 text-sm">{text('balance')}: {money(receipt.data.asset.balanceCents,receipt.data.order.currency)}</p></div></>:<p>{receipt.error?text('error'):text('processing')}</p>}
      <Button variant="outline" onPress={()=>setReceiptId(null)}>{text('close')}</Button>
    </CardContent></Card>:null}
    <Card><CardContent className="space-y-4 p-5"><h2 className="text-lg font-semibold">{text('account')}</h2>
      <p className="text-sm text-slate-600">{data.accounts.some(a=>a.charges_enabled&&!a.disconnected)?text('ready'):text('notReady')}</p>
      {data.accounts.map(a=><p key={a.id} className="text-sm">{a.livemode?text('liveMode'):text('testMode')}</p>)}
      {can('commerce.configure')?<div className="flex flex-wrap gap-2">
        <Button disabled={!writable||!data.enabled} onPress={()=>void action(async()=>{const r=await apiPost<{url:string}>('/v1/commerce/accounts/onboard',{idempotencyKey:attempt.take('connect')});window.location.assign(r.url);})}>{text('connect')}</Button>
        <Button variant="outline" disabled={!writable||!data.accounts.length} onPress={()=>void action(()=>apiPost('/v1/commerce/accounts/refresh',{idempotencyKey:crypto.randomUUID()}))}>{text('refresh')}</Button>
      </div>:null}
    </CardContent></Card>
    {can('commerce.configure')?<Card><CardContent className="space-y-3 p-5"><h2 className="text-lg font-semibold">{text('settings')}</h2>
      <label className="flex items-center gap-3"><input type="checkbox" checked={data.settings.salesEnabled} disabled={!writable||!data.enabled}
        onChange={event=>void action(()=>command('commerce.saveSettings',{...data.settings,salesEnabled:event.target.checked}))}/>{text('salesEnabled')}</label>
      <label className="flex items-center gap-3"><input type="checkbox" checked={data.settings.membershipsEnabled} disabled={!writable||!data.enabled}
        onChange={event=>void action(()=>command('commerce.saveSettings',{...data.settings,membershipsEnabled:event.target.checked}))}/>{membershipText(language,'salesEnabled')}</label>
    </CardContent></Card>:null}
    {can('commerce.configure')?<CommerceProducts language={language} writable={writable} canSavePackages={can('catalog.manage')}
      gifts={data.giftTemplates} packages={packages.data?.templates??[]} services={packages.data?.availableServices??[]}
      action={action} save={async(name,input)=>{const result=await command<{templateId:string}>(name,input);await packages.refetch();return result;}}/>:null}
    {can('commerce.sell')?<Card><CardContent className="p-5"><h2 className="mb-4 text-lg font-semibold">{text('newSale')}</h2>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void action(sell);}}>
        <label className="space-y-1 text-sm">{text('product')}<select value={product} onChange={e=>setProduct(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
          <option value="gift_card">{text('gifts')}</option>{packages.data?.templates.filter(p=>p.active).map(p=><option key={p.id} value={p.id}>{p.name} · {money(p.priceCents)}</option>)}
        </select></label>
        <label className="space-y-1 text-sm">{text('customer')}<select value={customerMode} onChange={e=>setCustomerMode(e.target.value as 'new'|'existing')} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
          <option value="new">{text('newCustomer')}</option>{can('customer.read')?<option value="existing">{text('existingCustomer')}</option>:null}</select></label>
        {customerMode==='new'?<><label className="space-y-1 text-sm">{text('name')}<Input value={name} required={product!=='gift_card'} onChange={e=>setName(e.target.value)} autoComplete="name"/></label>
          <label className="space-y-1 text-sm">{text('email')}<Input type="email" value={email} required={product!=='gift_card'||!!name.trim()} onChange={e=>setEmail(e.target.value)} autoComplete="email"/></label></>:<>
          <label className="space-y-1 text-sm">{text('name')}<Input value={customerSearch} onChange={e=>setCustomerSearch(e.target.value)}/></label>
          <label className="space-y-1 text-sm">{text('existingCustomer')}<select value={customerId} required onChange={e=>setCustomerId(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
            <option value="">{text('existingCustomer')}</option>{customerList.data?.rows.map(c=><option key={c.id} value={c.id}>{c.displayName} {c.phone}</option>)}</select></label>
        </>}
        {product==='gift_card'?<><label className="space-y-1 text-sm sm:col-span-2">{text('product')}<select value={giftTemplateId} onChange={e=>setGiftTemplateId(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
          <option value="">{text('customAmount')}</option>{data.giftTemplates.filter(g=>g.active).map(g=><option key={g.id} value={g.id}>{g.name} · {money(g.sale_price_cents)}</option>)}</select></label>
          <label className="space-y-1 text-sm">{text('faceValue')}<Input inputMode="decimal" value={selectedGift?(selectedGift.face_value_cents/100).toFixed(2):giftFace} readOnly={!!selectedGift} onChange={e=>setGiftFace(e.target.value)} required/></label>
          <label className="space-y-1 text-sm">{text('price')}<Input inputMode="decimal" value={selectedGift?(selectedGift.sale_price_cents/100).toFixed(2):giftPrice} readOnly={!!selectedGift} onChange={e=>setGiftPrice(e.target.value)} required/></label></>:null}
        {product==='gift_card'?<><label className="space-y-1 text-sm">{text('recipient')}<Input value={recipientName} maxLength={120} onChange={e=>setRecipientName(e.target.value)}/></label>
          <label className="space-y-1 text-sm">{text('recipientEmail')}<Input type="email" value={recipientEmail} onChange={e=>setRecipientEmail(e.target.value)}/></label>
          <label className="space-y-1 text-sm">{text('note')}<Input value={recipientNote} maxLength={500} onChange={e=>setRecipientNote(e.target.value)}/></label></>:null}
        <label className="space-y-1 text-sm">{text('newSale')}<select value={channel} onChange={e=>setChannel(e.target.value as 'offline'|'complimentary')} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
          <option value="offline">{text('offlineSale')}</option>{can('commerce.gift')?<option value="complimentary">{text('complimentary')}</option>:null}</select></label>
        {channel==='offline'?<><label className="space-y-1 text-sm">{text('offlineSale')}<select value={method} onChange={e=>setMethod(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3">
          <option value="cash">{text('cash')}</option><option value="card">{text('card')}</option></select></label>
          <label className="space-y-1 text-sm">{text('reference')}<Input value={reference} onChange={e=>setReference(e.target.value)} required/></label></>:
          <label className="space-y-1 text-sm">{text('reason')}<Input value={giftReason} minLength={2} onChange={e=>setGiftReason(e.target.value)} required/></label>}
        <div className="sm:col-span-2"><Button type="submit" disabled={!writable||!data.settings.salesEnabled||!data.enabled}>{text(channel==='offline'?'offlineSale':'complimentary')}</Button></div>
      </form>
    </CardContent></Card>:null}
    {data.failedTasks.length?<Card><CardContent className="space-y-3 p-5"><h2 className="text-lg font-semibold">{text('failedTasks')}</h2>
      {data.failedTasks.map(task=><form key={task.id} className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();const values=new FormData(e.currentTarget);
        void action(()=>command('commerce.retryTask',{taskId:task.id,reason:String(values.get('reason'))}));}}>
        <label className="text-sm">{text('reason')}<Input name="reason" minLength={2} required/></label>
        <Button type="submit" disabled={!writable||!can('commerce.configure')}>{text('retryTask')}</Button>
      </form>)}
    </CardContent></Card>:null}
    {data.reviewItems.length?<Card><CardContent className="space-y-3 p-5"><h2 className="text-lg font-semibold">{text('reviewItems')}</h2>
      {data.reviewItems.map(r=><article key={r.id} className="border-b border-amber-100 pb-3 text-sm">
        <p className="font-medium">{text(r.kind==='dispute'?'dispute':'externalRefund')} · {money(r.amount_cents,r.currency)}</p>
        <p className="text-slate-600">{text('review')}</p><p className="font-mono text-xs text-slate-500">{r.external_id}</p>
        {can('commerce.refund')&&r.kind==='external_refund'&&r.provider_status==='succeeded'?<form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={e=>{
          e.preventDefault();const values=new FormData(e.currentTarget);void action(()=>command('commerce.applyExternalRefund',{reviewId:r.id,reason:String(values.get('reason'))}));
        }}><label>{text('reason')}<Input name="reason" minLength={2} required/></label>
          <Button type="submit" disabled={!writable}>{text('applyExternalRefund')}</Button></form>:null}
      </article>)}
    </CardContent></Card>:null}
    <CommerceAssets language={language}/>
    <Card><CardContent className="space-y-4 p-5"><h2 className="text-lg font-semibold">{text('orderHistory')}</h2>
      {!data.orders.length?<p className="text-sm text-slate-500">{text('empty')}</p>:data.orders.map(o=><article key={o.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div><h3 className="font-medium">{o.name}</h3><p className="text-sm text-slate-500">{o.customer_name} · {money(o.amount_cents,o.currency)} · {text((['pending','fulfilled','paid','refunded','failed','review'].includes(o.status)?o.status:'processing') as CommerceTextKey)}</p>
          {o.refunded_cents>0?<p className="text-sm">{text('refunded')}: {money(o.refunded_cents,o.currency)}</p>:null}
          <time className="text-xs text-slate-500">{new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'short',timeZone:context?.timezone??'UTC'}).format(new Date(o.paid_at??o.created_at))}</time>
          {o.refund_requires_review?<p className="mt-1 text-xs text-amber-700">{text('giftBasisReview')}</p>:null}
          {o.settlement_currency&&o.settlement_gross_cents!==null&&o.fee_cents!==null&&o.net_cents!==null?<p className="mt-1 text-xs text-slate-500">
            {text('gross')}: {money(o.settlement_gross_cents,o.settlement_currency)} · {text('fee')}: {money(o.fee_cents,o.settlement_currency)} · {text('net')}: {money(o.net_cents,o.settlement_currency)}
          </p>:null}
          <details className="mt-2 text-xs"><summary>{text('delivery')}</summary><div className="space-y-2 py-2">
            {data.deliveries.filter(d=>d.order_id===o.id).map(d=><p key={d.id}>{text(d.entity_type.endsWith('_recipient')?'recipient':'customer')} · {text(d.status==='captured'?'captured':d.status==='sent'?'sent':d.status==='failed'?'failed':'processing')}</p>)}
            {can('commerce.sell')&&o.kind!=='customer_membership'&&o.status==='fulfilled'?<form className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();const values=new FormData(e.currentTarget);
              void action(()=>command('commerce.resendNotice',{orderId:o.id,reason:String(values.get('reason'))}));}}>
              <label>{text('reason')}<Input name="reason" minLength={2} required/></label><Button type="submit" disabled={!writable}>{text('resendNotice')}</Button>
            </form>:null}
          </div></details></div>
        <div className="flex flex-wrap gap-2">{can('commerce.sell')&&o.kind==='gift_card'&&o.status==='fulfilled'?<Button variant="outline" onPress={()=>setReceiptId(o.id)}>{text('gifts')}</Button>:null}
        {can('commerce.refund')&&o.kind!=='customer_membership'&&!o.refund_requires_review&&o.status!=='review'&&o.payment_id&&o.payment_status==='paid'?<Button variant="outline" disabled={!writable} onPress={()=>{setRefundFor(o.payment_id);}}>{text('refund')}</Button>:null}</div>
      </article>)}
      <PurchaseRefund key={membershipId} selected={data.orders.find(o=>o.payment_id===refundFor)??null} language={language} onClose={()=>setRefundFor(null)} onSaved={async()=>{
        await Promise.allSettled([query.refetch(),cache.invalidateQueries({queryKey:['desk','giftcards']}),cache.invalidateQueries({queryKey:['desk','packages']}),cache.invalidateQueries({queryKey:['desk','commerce-asset']}),cache.invalidateQueries({queryKey:['desk','commerce-receipt']})]);
      }}/>
      {data.refunds.filter(r=>r.status==='declined').map(r=><p key={r.id} className="text-sm text-slate-600">{money(r.amount_cents,r.currency)} · {depositText(language,'retentionRecorded')} · {r.decline_reason??r.reason}</p>)}
      {data.refunds.filter(r=>r.status==='review'&&r.review_required&&r.guest_cancellation_id).map(r=><form key={r.id} className="flex flex-wrap items-end gap-3" onSubmit={e=>{
        e.preventDefault();const values=new FormData(e.currentTarget);void action(()=>command('commerce.approveGuestRefund',{refundId:r.id,reason:String(values.get('approvalReason'))}));
      }}><p className="text-sm">{money(r.amount_cents,r.currency)} · {r.deposit_guest_allocation?.map(g=>depositText(language,'guestLabel').replace('{n}',String(g.guestIndex+1))).join(', ')}</p>
        <label className="text-sm">{depositText(language,'guestApprovalReason')}<Input name="approvalReason" minLength={2} maxLength={500} required disabled={!writable||!can('commerce.refund')}/></label>
        <GuardedButton type="submit" permission="commerce.refund" isDisabled={!writable}>{depositText(language,'approveGuestRefund')}</GuardedButton>
      </form>)}
      {data.refunds.filter(r=>r.provider==='offline'&&r.status==='pending').map(r=><form key={r.id} className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();const values=new FormData(e.currentTarget);
        void action(()=>command('commerce.confirmOfflineRefund',{refundId:r.id,reference:String(values.get('reference'))}));}}>
        <label className="text-sm">{text('reference')}<Input name="reference" required/></label><span>{money(r.amount_cents)} · {r.reason}</span><Button type="submit" disabled={!writable||!can('commerce.refund')}>{text('confirmOfflineRefund')}</Button></form>)}
    </CardContent></Card>
  </div>;
}
