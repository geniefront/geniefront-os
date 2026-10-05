import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {groupCheckoutText} from '@gf/contracts';
import {useLanguage} from '@/LanguageContext';
import {useSession} from '@/lib/session';
import {useCanWrite} from '@/lib/permissions';
import {runCommand} from '@/lib/api';
import {useErrorMessage} from '@/lib/errorMessage';
import {toast} from '@/lib/toast';
import {parseMoney} from '@/lib/validation';
import {useValidationMessage} from '@/lib/validationMessage';
import {Modal} from '@/components/ui/Modal';
import {Button} from '@/components/ui/Button';
import {GuardedButton} from '@/components/ui/GuardedButton';
import {useOpenTickets,useCloseGroup,useGroupQuote,centsToDollars,type CheckoutQuoteInput,type CheckoutQuote,type CloseGroupResult} from './api';
import {emptyLine,patchPayment,toPaymentLine,distributeTip,chargedCents,type DraftLine} from './paymentDraft';
import {paymentStageFor,type OpenTicket} from './types';
import {allocateTips} from '@/features/queue/checkoutMath';
type SelectionRenderer=(ticketId:string,initial:CheckoutQuoteInput|undefined,save:(input:CheckoutQuoteInput,quote:CheckoutQuote)=>void)=>ReactNode;
function GroupReceipts({result}:{result:CloseGroupResult}){const {language}=useLanguage();return <div role="status" className="space-y-2 rounded-xl border border-teal-300 bg-teal-50 p-3">
 <strong>{groupCheckoutText(language,'done')}</strong>{result.tickets.map(t=><p key={t.ticketId}><Link className="underline" to={`/print/receipt/${t.ticketId}`}>{groupCheckoutText(language,'receipt')} · {t.ticketId.slice(0,8)} · ${centsToDollars(t.totalCents)}</Link></p>)}
 </div>;}
export function GroupCheckoutEntry({renderSelection}: {renderSelection:SelectionRenderer}){
 const {language}=useLanguage(),errorMessage=useErrorMessage(),close=useCloseGroup();const [open,setOpen]=useState(false),[recovered,setRecovered]=useState<CloseGroupResult|null>(null);
 return <>
  {close.pendingGroupPayment&&<div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3">
   <p>{groupCheckoutText(language,'pending')}</p><GuardedButton permission="ticket.write" isPending={close.isPending} onClick={async()=>{try{setRecovered(await close.mutateAsync(close.pendingGroupPayment!));}catch(e){toast.danger(errorMessage(e));}}}>{groupCheckoutText(language,'retry')}</GuardedButton>
  </div>}
  {recovered&&<GroupReceipts result={recovered}/>}
  <GuardedButton permission="ticket.write" isDisabled={close.hasPendingSettlement} onClick={()=>{setRecovered(null);setOpen(true);}}>{groupCheckoutText(language,'title')}</GuardedButton>
  {open&&<GroupCheckoutDialog onClose={()=>setOpen(false)} renderSelection={renderSelection}/>}
 </>;
}
function GroupCheckoutDialog({onClose,renderSelection}:{onClose:()=>void;renderSelection:SelectionRenderer}){
 const {language,t}=useLanguage(),text=(key:Parameters<typeof groupCheckoutText>[1])=>groupCheckoutText(language,key),errorMessage=useErrorMessage(),{membershipId}=useSession(),queryClient=useQueryClient();
 const openTickets=useOpenTickets(),close=useCloseGroup(),canDiscount=useCanWrite('ticket.discount'),invalid=useValidationMessage();
 const readMoney=(value:string,apply:(cents:number)=>void)=>{const parsed=parseMoney(value,{allowEmpty:true});if(!parsed.ok){toast.danger(invalid.money(parsed.reason));return;}apply(parsed.value);};
 const tickets=(openTickets.data?.tickets??[]).filter(ticket=>!!paymentStageFor(ticket));
 const [ids,setIds]=useState<string[]>([]),[groupId,setGroupId]=useState<string|null>(null),[payer,setPayer]=useState(''),[editing,setEditing]=useState<string|null>(null);
 const [selections,setSelections]=useState<Record<string,{input:CheckoutQuoteInput;quote:CheckoutQuote}>>({});
 const [lines,setLines]=useState<DraftLine[]>([emptyLine('card')]),[discount,setDiscount]=useState(''),[fee,setFee]=useState(''),[result,setResult]=useState<CloseGroupResult|null>(null);
 const prepareKey=useRef(crypto.randomUUID()),paymentKey=useRef(crypto.randomUUID()),originalTickets=useRef<Record<string,OpenTicket>>({});
 const prepare=useMutation({mutationFn:async()=>{
  const selected=tickets.filter(t=>ids.includes(t.ticketId));if(!selected.length||selected.length!==ids.length)throw new Error(text('empty'));originalTickets.current=Object.fromEntries(selected.map(t=>[t.ticketId,t]));
  const existing=selected[0]!.groupId;let id:string;
  if(existing&&selected.every(t=>t.groupId===existing))id=existing;
  else id=(await runCommand<{groupId:string}>('ticket.group',{ticketIds:ids,label:text('title')},membershipId!,prepareKey.current)).result.groupId;
  setGroupId(id);setPayer(ids[0]!);void queryClient.invalidateQueries({queryKey:['desk','tickets']});
 }});
 const baseTips=ids.reduce((n,id)=>n+(selections[id]?.input.tipCents??0),0),paidTips=lines.reduce((n,l)=>n+l.tipCents,0),extraTips=Math.max(0,paidTips-baseTips);
 const choices=ids.map(id=>{
  const ticket=tickets.find(t=>t.ticketId===id)??originalTickets.current[id];
  const choice=selections[id]?.input??{ticketId:id,paymentStage:ticket?paymentStageFor(ticket)??'combined':'combined'};
  const tipCents=(choice.tipCents??0)+(id===payer?extraTips:0);
  if(id!==payer||!extraTips||!choice.tipSplits?.length)return {...choice,tipCents};
  const added=allocateTips(choice.tipSplits.map(s=>({membershipId:s.staffMembershipId,name:s.staffName??'',items:[],totalRevenueCents:s.amountCents})),extraTips,'proportional');
  return {...choice,tipCents,tipSplits:choice.tipSplits.map((split,i)=>({...split,amountCents:split.amountCents+added[i]!}))};
 });
 const parsedDiscount=parseMoney(discount,{allowEmpty:true}),parsedFee=parseMoney(fee,{allowEmpty:true});
 const amountError=!parsedDiscount.ok?invalid.money(parsedDiscount.reason):!parsedFee.ok?invalid.money(parsedFee.reason):null;
 const groupInput=groupId&&parsedDiscount.ok&&parsedFee.ok?{groupId,ticketIds:ids,payerTicketId:payer,ticketSelections:choices,payments:lines.filter(l=>chargedCents(l)>0).map(toPaymentLine),discountCents:canDiscount?parsedDiscount.value:0,surchargeCents:parsedFee.value,tipCents:Math.max(baseTips,paidTips)}:null;
 const quote=useGroupQuote(result?null:groupInput);
 useEffect(()=>{if(quote.data&&lines.length===1){const base=Math.max(0,quote.data.amountDueCents-lines[0]!.tipCents);if(base!==lines[0]!.baseCents)setLines(prev=>[patchPayment(prev[0]!,{baseCents:base})]);}},[quote.data?.amountDueCents,lines.length]);
 const patch=(index:number,change:Partial<DraftLine>)=>setLines(prev=>prev.map((line,i)=>i===index?patchPayment(line,change):line));
 const ready=!!groupInput&&!amountError&&!!quote.data?.readyToPay&&!quote.isFetching&&!quote.error&&!close.hasPendingSettlement;
 const submit=async()=>{if(!groupInput||!ready)return;try{setResult(await close.mutateAsync({...groupInput,expectedQuoteHash:quote.data!.quoteHash,idempotencyKey:paymentKey.current}));}
  catch(e){toast.danger(errorMessage(e));if(!close.pendingGroupPayment)void quote.refetch();}};
 const selectionView=editing?renderSelection(editing,selections[editing]?.input,(input,quote)=>{const next={...selections,[editing]:{input,quote}};setSelections(next);setLines(prev=>distributeTip(prev,ids.reduce((n,id)=>n+(next[id]?.input.tipCents??0),0)));setEditing(null);}):null;
 return <Modal isOpen onOpenChange={open=>{if(!open)onClose();}} isDismissDisabled={close.isPending||prepare.isPending} size="cover" title={text('title')}>
  {result?<GroupReceipts result={result}/>:editing?<><Button onClick={()=>setEditing(null)}>{text('back')}</Button>{selectionView}</>:<div className="space-y-4">
   {close.pendingGroupPayment&&<div role="alert" className="rounded-lg bg-amber-50 p-3"><p>{text('pending')}</p><GuardedButton permission="ticket.write" isPending={close.isPending} onClick={async()=>{try{setResult(await close.mutateAsync(close.pendingGroupPayment!));}catch(e){toast.danger(errorMessage(e));}}}>{text('retry')}</GuardedButton></div>}
   {!groupId?<><p>{text('choose')}</p><div className="space-y-2">{tickets.map(ticket=><label key={ticket.ticketId} className="flex gap-2 rounded-lg border p-3"><input type="checkbox" checked={ids.includes(ticket.ticketId)} onChange={e=>{setIds(old=>e.target.checked?[...old,ticket.ticketId]:old.filter(id=>id!==ticket.ticketId));prepareKey.current=crypto.randomUUID();}}/><span>{ticket.customerName} · {ticket.ticketId.slice(0,8)} · ${centsToDollars(ticket.subtotalCents)}</span></label>)}</div>
    {!tickets.length&&<p>{text('empty')}</p>}<GuardedButton permission="ticket.write" isPending={prepare.isPending} isDisabled={!ids.length} onClick={()=>prepare.mutateAsync().catch(e=>toast.danger(errorMessage(e)))}>{text('prepare')}</GuardedButton></>:
   <>
    <div className="space-y-2">{ids.map(id=>{const ticket=tickets.find(t=>t.ticketId===id),q=quote.data?.tickets.find(t=>t.ticketId===id);return <div key={id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
     <strong>{ticket?.customerName??id.slice(0,8)}</strong><span>{text('member')} {id.slice(0,8)}</span>{q&&<span>${centsToDollars(q.totalCents)} · {text('tip')} ${centsToDollars(q.tipCents)}</span>}
     <Button isDisabled={close.hasPendingSettlement} onClick={()=>setEditing(id)}>{text('configure')}</Button></div>;})}</div>
    <label className="block">{text('payer')}<select className="ml-2 max-w-full rounded border p-2" value={payer} onChange={e=>setPayer(e.target.value)}>{ids.map(id=><option key={id} value={id}>{tickets.find(t=>t.ticketId===id)?.customerName??id.slice(0,8)}</option>)}</select></label>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label>{text('discount')}<input aria-label={text('discount')} type="number" min="0" step="0.01" disabled={!canDiscount} value={discount} onChange={e=>setDiscount(e.target.value)} className="block w-full rounded border p-2"/></label><label>{text('fee')}<input aria-label={text('fee')} type="number" min="0" step="0.01" value={fee} onChange={e=>setFee(e.target.value)} className="block w-full rounded border p-2"/></label></div>
    <h3 className="font-bold">{text('payments')}</h3>{lines.map((line,index)=><div key={index} className="space-y-2 rounded-xl border p-3">
     <div className="flex gap-2"><select aria-label={`${text('payments')} ${index+1}`} className="rounded border p-2" value={line.method} onChange={e=>patch(index,{...emptyLine(e.target.value as 'cash'|'card'|'external'),baseCents:line.baseCents,tipCents:line.tipCents})}><option value="cash">{t('payCash')}</option><option value="card">{t('payCard')}</option><option value="external">{t('methodExternal')}</option></select>{lines.length>1&&<Button onClick={()=>setLines(old=>old.filter((_,i)=>i!==index))}>{t('removePayment')}</Button>}</div>
     <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label>{text('amount')}<input aria-label={`${text('amount')} ${index+1}`} type="number" min="0" step="0.01" value={centsToDollars(chargedCents(line))} onChange={e=>readMoney(e.target.value,cents=>{if(cents<line.tipCents){toast.danger(text('error'));return;}patch(index,{baseCents:cents-line.tipCents});})} className="block w-full rounded border p-2"/></label><label>{text('tip')}<input aria-label={`${text('tip')} ${index+1}`} type="number" min="0" step="0.01" value={centsToDollars(line.tipCents)} onChange={e=>readMoney(e.target.value,cents=>patch(index,{tipCents:cents,keepChange:false}))} className="block w-full rounded border p-2"/></label></div>
     {line.method==='cash'&&<><label>{text('tendered')}<input aria-label={`${text('tendered')} ${index+1}`} type="number" min="0" step="0.01" value={line.tenderedInput??''} onChange={e=>{const value=e.target.value;readMoney(value,cents=>setLines(old=>old.map((l,i)=>{if(i!==index)return l;const next={...l,tenderedInput:value};if(value)next.tenderedCents=cents;else{delete next.tenderedCents;next.keepChange=false;}return patchPayment(next,{});})) );}} className="block w-full rounded border p-2"/></label><label className="flex gap-2"><input type="checkbox" checked={line.keepChange} onChange={e=>patch(index,{keepChange:e.target.checked})}/>{text('keepChange')}</label></>}
    </div>)}
    <Button isDisabled={lines.length>=5} onClick={()=>setLines(old=>[...old,emptyLine('card')])}>{text('add')}</Button>
    {amountError&&<p role="alert">{amountError}</p>}
    {quote.error&&<div role="alert"><p>{text('error')}</p><Button onClick={()=>void quote.refetch()}>{text('refresh')}</Button></div>}
    <p role="status" className="font-bold">{text('confirmed')}: {quote.data?`$${centsToDollars(quote.data.amountDueCents)}`:'…'}</p>
    <GuardedButton permission="ticket.write" isPending={close.isPending} isDisabled={!ready} onClick={()=>void submit()}>{text('confirm')}</GuardedButton>
   </>}
  </div>}
 </Modal>;
}
