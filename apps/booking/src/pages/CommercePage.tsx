import {useEffect,useState} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {commerceText,membershipText,purchaseRefundText,type CommerceTextKey} from '@gf/contracts';
import {Card,Shell,Btn} from '../components/Chrome';
import {GiftCardBalance} from '../components/GiftCardBalance';
import {useLanguage,type Locale} from '../lib/i18n';
import {commerceApi,loadPurchaseAccess,savePurchaseAccess,type CommerceCatalog,type Product,type PurchaseStatus} from '../lib/commerceApi';
const languages=[['en','English'],['zh-Hans','简体中文'],['zh-Hant','繁體中文'],['es','Español'],['ko','한국어'],['vi','Tiếng Việt']] as const;
interface PurchaseAttempt{selected:{kind:'gift_card'|'package';product:Product};name:string;email:string;recipientName:string;recipientNote:string;recipientEmail:string;locale:string;currency:string;businessKey:string;}
export function CommercePage(){
  const {slug=''}=useParams();const [params,setParams]=useSearchParams();const {locale,setLocale}=useLanguage();
  const [catalog,setCatalog]=useState<CommerceCatalog|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState<{kind:'gift_card'|'package';product:Product}|null>(null),[purchaseState,setPurchase]=useState<PurchaseStatus|null>(null);
  const [purchaseError,setPurchaseError]=useState('');
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[recipientName,setRecipientName]=useState(''),[recipientNote,setRecipientNote]=useState(''),[recipientEmail,setRecipientEmail]=useState('');
  const [pending,setPending]=useState<PurchaseAttempt|null>(null);const orderId=params.get('order'),attemptStorage=`gf-commerce-attempt:${slug}`;
  const purchase=purchaseState?.order.id===orderId?purchaseState:null;
  const text=(key:CommerceTextKey)=>commerceText(locale,key);
  const money=(amount:number,currency=catalog?.currency??'USD')=>new Intl.NumberFormat(locale,{style:'currency',currency}).format(amount/100);
  useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(attemptStorage)??'null') as PurchaseAttempt|null;
    if(saved?.selected.product.id&&saved.businessKey&&saved.name&&saved.email&&['gift_card','package'].includes(saved.selected.kind)){
      setPending(saved);setSelected(saved.selected);setName(saved.name);setEmail(saved.email);setRecipientName(saved.recipientName);setRecipientEmail(saved.recipientEmail);setRecipientNote(saved.recipientNote);
    }}catch{}},[attemptStorage]);
  useEffect(()=>{const controller=new AbortController();setCatalog(null);setError('');
    commerceApi<CommerceCatalog>(slug,`?locale=${encodeURIComponent(locale)}`,{signal:controller.signal}).then(setCatalog).catch(e=>{if(e.name!=='AbortError')setError('error');});
    return()=>controller.abort();},[slug,locale]);
  useEffect(()=>{
    setPurchase(null);setPurchaseError('');
    if(!orderId)return;
    const fragment=window.location.hash.match(/^#c\/([A-Za-z0-9_-]{43})$/);
    if(fragment?.[1]) {
      try{savePurchaseAccess(slug,orderId,fragment[1]);window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}`);}catch{setPurchaseError('noAccess');return;}
    }
    const token=loadPurchaseAccess(slug,orderId);if(!token){setPurchaseError('noAccess');return;}
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{try{const value=await commerceApi<PurchaseStatus>(slug,`/orders/${orderId}`,{token,signal:controller.signal});
      if(controller.signal.aborted)return;setPurchase(value);setPurchaseError('');
      timer=setTimeout(()=>void poll(),value.order.status==='pending'||value.order.status==='paid'||value.pendingRefundCents?4000:15000);
    }catch(e){if(!controller.signal.aborted){const status=(e as {status?:number}).status;setPurchaseError(status===404?'noAccess':'error');
      if(!status||status>=500||status===429)timer=setTimeout(()=>void poll(),15000);
    }}};void poll();
    return()=>{controller.abort();clearTimeout(timer);};
  },[slug,orderId]);
  async function buy(){
    if(!selected)return;setBusy(true);setError('');
    const attempt=pending??{selected,name:name.trim(),email:email.trim(),recipientName,recipientNote,recipientEmail,locale,currency:catalog?.currency??'USD',businessKey:crypto.randomUUID()};
    try {
      sessionStorage.setItem(attemptStorage,JSON.stringify(attempt));setPending(attempt);
      const result=await commerceApi<{orderId:string;token:string;url:string|null}>(slug,'/orders',{body:{kind:attempt.selected.kind,templateId:attempt.selected.product.id,
        customer:{name:attempt.name,email:attempt.email},recipientName:attempt.recipientName,recipientNote:attempt.recipientNote,...(attempt.recipientEmail?{recipientEmail:attempt.recipientEmail}:{}),
        ...(attempt.selected.product.quoteHash?{expectedQuoteHash:attempt.selected.product.quoteHash}:{}),locale:attempt.locale,businessKey:attempt.businessKey}});
      savePurchaseAccess(slug,result.orderId,result.token);sessionStorage.removeItem(attemptStorage);setPending(null);setParams({order:result.orderId});
      if(result.url)window.location.assign(result.url);
    }catch(e){const failure=e as {status?:number;details?:{reason?:string}};
      if(failure.status&&failure.status<500){sessionStorage.removeItem(attemptStorage);setPending(null);}
      if(failure.details?.reason==='commerce_purchase_quote_changed'){
        setSelected(null);setError('purchaseQuoteChanged');try{setCatalog(await commerceApi<CommerceCatalog>(slug,`?locale=${encodeURIComponent(locale)}`));}catch{}
      }else setError(failure.status&&failure.status<500?'error':'purchaseUnknown');
    }finally{setBusy(false);}
  }
  const statusKey:CommerceTextKey=purchase?.asset?.status==='disabled'?'disabled':(purchase?.asset?.status==='review'||purchase?.order.status==='review')?'review':purchase?.asset?.status==='refund_pending'||purchase?.pendingRefundCents?'processing':purchase?.order.status==='refunded'?'refunded':purchase?.refundedCents?'partiallyRefunded':purchase?.order.status==='fulfilled'?'fulfilled':purchase?.order.status==='canceled'||purchase?.paymentStatus==='failed'?'failed':purchase?.order.status==='paid'?'processing':'pending';
  const terms=(product:Product,kind:'gift_card'|'package')=><div className="space-y-1 text-sm text-[var(--muted)]">
    {product.validDays?<p>{text('purchaseValidity').replace('{days}',String(product.validDays))}</p>:product.validDays===null?<p>{text('noExpiry')}</p>:null}
    {product.scope?<p>{text(product.scope==='org'?'organization':'storeOnly')}</p>:null}
    {kind==='package'?<><p>{product.sessions===0?text('unlimited'):`${product.sessions} ${text('sessions')}`}</p>
      {product.serviceNames?<p>{text('includedServices')}: {product.serviceNames.length?product.serviceNames.join(' · '):text('anyEligibleService')}</p>:null}
      {product.coverageMode?<p>{text(product.coverageMode==='any_included'?'oneService':'serviceBundle')}</p>:null}</>:null}
  </div>;
  return <Shell>
    <header className="flex flex-wrap items-center justify-between gap-3 py-6"><Link to={`/${slug}`} className="text-sm font-semibold text-[var(--brand)]">{text('back')}</Link>
      <select className="language-select" aria-label="Language" value={locale} disabled={!!pending} onChange={e=>setLocale(e.target.value as Locale)}>{languages.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></header>
    <div className="mb-8"><p className="text-sm font-medium text-[var(--muted)]">{catalog?.shopName}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{text('gifts')} &amp; {text('packages')}</h1></div>
    {purchaseError||error||pending&&!busy?<p role="alert" className="mb-6 rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{text((purchaseError||error||'purchaseUnknown') as CommerceTextKey)}</p>:null}
    {orderId?<Card className="mx-auto max-w-xl space-y-4 p-6">{purchase?<h2 className="text-xl font-semibold">{text(statusKey)}</h2>:null}
      {purchase?<><p>{money(purchase.order.amount_cents,purchase.order.currency)}</p>
        {purchase.refundedCents?<p>{text('refunded')}: {money(purchase.refundedCents,purchase.order.currency)}</p>:null}
        {purchase.pendingRefundCents?<p>{text('processing')}: {money(purchase.pendingRefundCents,purchase.order.currency)}</p>:null}
        {purchase.asset?.code?<div><p className="break-all rounded-xl bg-[var(--mint)] p-4 font-mono text-lg">{purchase.asset.code}</p><p className="mt-3">{text('balance')}: {money(purchase.asset.balance_cents??0,purchase.order.currency)}</p></div>:null}
        {purchase.asset?.remaining_sessions!==undefined?<>
          <p>{purchase.asset.total_sessions===0?(purchase.asset.can_redeem?text('unlimited'):purchaseRefundText(locale,'inactive')):`${purchase.asset.remaining_sessions} ${text('sessions')}`}</p>
          {purchase.asset.total_sessions!==0&&purchase.asset.can_redeem===false?<p>{purchaseRefundText(locale,'inactive')}</p>:null}
          {purchase.asset.expires_at?<p>{membershipText(locale,'expires')}: {new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:purchase.timezone??'UTC'}).format(new Date(purchase.asset.expires_at))}</p>:null}
        </>:null}
        {purchase.paymentStatus==='pending'&&purchase.checkoutUrl?<a className="booking-btn block text-center" href={purchase.checkoutUrl}>{text('buy')}</a>:null}
      </>:!purchaseError?<p aria-live="polite">{text('processing')}</p>:null}
      <Btn onClick={()=>{setParams({});setPurchase(null);setError('');}}>{text('back')}</Btn>
    </Card>:<>
      {catalog&&!catalog.available?<p className="mb-6 rounded-xl bg-amber-50 p-4 text-sm">{text('unavailable')}</p>:null}
      {!catalog&&!error?<p aria-live="polite">{text('processing')}</p>:null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{(['gift_card','package'] as const).flatMap(kind=>(kind==='gift_card'?catalog?.gifts:catalog?.packages)?.map(product=><Card key={product.id} className="space-y-4 p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">{kind==='gift_card'?text('gifts'):text('packages')}</p><h2 className="text-xl font-semibold">{product.name}</h2>
        <p className="text-2xl font-semibold">{money(product.priceCents)}</p>
        {product.faceValueCents?<p className="text-sm text-[var(--muted)]">{text('faceHint')}: {money(product.faceValueCents)}</p>:null}
        {terms(product,kind)}
        <Btn primary disabled={!catalog?.available||busy||!!pending} onClick={()=>{setSelected({kind,product});setError('');}}>{text('buy')}</Btn>
      </Card>)??[])}</div>
      {selected?<Card className="mx-auto mt-8 max-w-xl p-6"><h2 className="mb-5 text-xl font-semibold">{selected.product.name} · {money(selected.product.priceCents,pending?.currency??catalog?.currency)}</h2>
        <div className="mb-5">{terms(selected.product,selected.kind)}</div>
        <form className="space-y-4" onSubmit={e=>{e.preventDefault();void buy();}}>
          <label className="block text-sm font-medium">{text('name')}<input className="booking-input mt-2 w-full" autoComplete="name" value={name} readOnly={!!pending} maxLength={120} required onChange={e=>setName(e.target.value)}/></label>
          <label className="block text-sm font-medium">{text('email')}<input className="booking-input mt-2 w-full" autoComplete="email" type="email" value={email} readOnly={!!pending} required onChange={e=>setEmail(e.target.value)}/></label>
          {selected.kind==='gift_card'?<><label className="block text-sm font-medium">{text('recipient')}<input className="booking-input mt-2 w-full" value={recipientName} readOnly={!!pending} maxLength={120} onChange={e=>setRecipientName(e.target.value)}/></label>
            <label className="block text-sm font-medium">{text('recipientEmail')}<input className="booking-input mt-2 w-full" type="email" value={recipientEmail} readOnly={!!pending} maxLength={200} onChange={e=>setRecipientEmail(e.target.value)}/></label>
            <label className="block text-sm font-medium">{text('note')}<textarea className="booking-input mt-2 w-full" value={recipientNote} readOnly={!!pending} maxLength={500} onChange={e=>setRecipientNote(e.target.value)}/></label></>:null}
          <p className="text-sm leading-6 text-[var(--muted)]">{text('terms')}</p>
          <Btn primary type="submit" disabled={busy||(!pending&&!catalog?.available)}>{busy?text('processing'):`${text('buy')} · ${money(selected.product.priceCents,pending?.currency??catalog?.currency)}`}</Btn>
        </form>
      </Card>:null}
    </>}
    <Link className="booking-btn my-6 block text-center" to={`/${slug}/memberships`}>{membershipText(locale,'title')}</Link>
    <GiftCardBalance slug={slug} locale={locale}/>
  </Shell>;
}
