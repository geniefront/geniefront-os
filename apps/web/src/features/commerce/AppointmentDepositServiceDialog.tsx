import {useEffect,useState} from 'react';
import {AppointmentAddItem,AppointmentReplaceItem,depositAdjustmentText,depositText,type DepositAdjustmentQuote} from '@gf/contracts';
import {useSession} from '@/lib/session';
import {useLanguage} from '@/LanguageContext';
import {useErrorMessage} from '@/lib/errorMessage';
import {Modal} from '@/components/ui/Modal';
import {Button} from '@/components/ui/Button';
import {GuardedButton} from '@/components/ui/GuardedButton';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {DepositAdjustmentReview} from './DepositAdjustmentReview';
import {useDurableDepositCommand} from './useDurableDepositCommand';
type Input=typeof AppointmentAddItem.input._type|typeof AppointmentReplaceItem.input._type;
export function AppointmentDepositServiceDialog({appointment,open,onClose,onSaved,services,staff,editable,replace=false}:{appointment:AppointmentDetail;open:boolean;onClose:()=>void;onSaved:()=>Promise<void>;
 services:readonly {id:string;name:string;priceCents:number;durationMin:number;isAddon?:boolean|undefined;staffCount:number}[];staff:readonly {membershipId:string;name:string}[];editable:boolean;replace?:boolean}){
 const {membershipId,can,isOnline}=useSession(),{language,t}=useLanguage(),errorMessage=useErrorMessage();
 const action=useDurableDepositCommand<Input>(replace?'appointment.replaceItem':'appointment.addItem',appointment.appointmentId,replace?AppointmentReplaceItem.input:AppointmentAddItem.input);
 const [targetItemId,setTargetItemId]=useState('');
 const eligible=appointment.items.filter(i=>i.status!=='cancelled'&&!i.bundleInstanceId&&!i.executionGroup&&(i.guestIndices?.length??1)===1);
 const [serviceId,setServiceId]=useState(''),[staffId,setStaffId]=useState(''),[guestIndex,setGuestIndex]=useState(0),[quote,setQuote]=useState<DepositAdjustmentQuote|null>(null),[accepted,setAccepted]=useState(false),[error,setError]=useState('');
 const text=(key:Parameters<typeof depositAdjustmentText>[1])=>depositAdjustmentText(language,key);
 const guests=appointment.guests?.filter(g=>g.status==='active')??[{guestIndex:0}];
 const writable=!!membershipId&&can('appointment.write')&&can('commerce.sell')&&isOnline,locked=action.busy||!!action.pending||!writable;
 const currentQuote=(action.pending?.meta?.quote as DepositAdjustmentQuote|undefined)??quote;
 useEffect(()=>{if(open&&!action.pending){setTargetItemId(eligible[0]?.itemId??'');setServiceId(replace?eligible[0]?.serviceId??'':'');setStaffId(replace?eligible[0]?.staffId??'':'');setGuestIndex(guests[0]?.guestIndex??0);setQuote(null);setAccepted(false);setError('');}},[open]);
 useEffect(()=>{if(action.pending){setServiceId(action.pending.input.serviceId);setStaffId(action.pending.input.membershipId??'');setGuestIndex('guestIndex' in action.pending.input?action.pending.input.guestIndex??0:0);if('itemId' in action.pending.input)setTargetItemId(action.pending.input.itemId);setAccepted(!!action.pending.input.depositAdjustment);}},[action.pending?.key]);
 const changed=()=>{setQuote(null);setAccepted(false);setError('');};
 async function submit(){
  if(!writable||action.busy||!action.pending&&(!editable||!serviceId||replace&&!targetItemId||currentQuote&&!accepted))return;
  const service=services.find(s=>s.id===serviceId),lastEnd=appointment.items.filter(i=>i.status!=='cancelled').reduce((n,i)=>Math.max(n,Date.parse(i.startsAt)+i.durationMin*60000),0);
  const common={appointmentId:appointment.appointmentId,serviceId,membershipId:staffId||null,isRequest:false,
   ...(quote&&accepted?{depositAdjustment:{accepted:true as const,quoteHash:quote.quoteHash}}:{})};
  const input:Input=action.pending?.input??(replace?{...common,itemId:targetItemId}:{...common,guestIndex,
   startsAt:new Date(lastEnd||Date.now()).toISOString(),...(service?{durationMin:service.durationMin}:{})});
  setError('');
  try{await action.execute(input,{...(quote?{quote}:{}),serviceName:service?.name??''});onClose();setQuote(null);setAccepted(false);await onSaved();}
  catch(e){const detail=(e as {details?:{reason?:string;depositQuote?:DepositAdjustmentQuote;notApplied?:boolean}}).details;
   if((!action.pending||detail?.notApplied===true)&&detail?.reason==='deposit_quote_reconfirmation_required'&&detail.depositQuote){setQuote(detail.depositQuote);setAccepted(false);}
   else setError(errorMessage(e));}
 }
 return <Modal isOpen={open||!!action.pending} onOpenChange={value=>{if(!value&&!action.busy&&!action.pending)onClose();}} title={replace?text('replaceService'):t('schedule.adAddOn')} size="sm"
  footer={<><Button variant="outline" isDisabled={action.busy||!!action.pending} onPress={onClose}>{t('cancel')}</Button>
   <GuardedButton permission="appointment.write" className="max-w-full !whitespace-normal h-auto min-h-10" isPending={action.busy}
    isDisabled={!writable||!action.pending&&(!editable||!serviceId||replace&&!targetItemId||!!currentQuote&&!accepted)} onPress={()=>void submit()}>{text(action.pending?'retry':currentQuote?'approve':'review')}</GuardedButton></>}>
  <div className="space-y-3">
   {action.pending&&<p role="status" className="text-sm">{text('unknown')}</p>}
   {replace&&<label className="block space-y-1 text-sm"><span>{text('originalService')}</span><select value={targetItemId} disabled={locked} onChange={e=>{
     setTargetItemId(e.target.value);const item=eligible.find(i=>i.itemId===e.target.value);setServiceId(item?.serviceId??'');setStaffId(item?.staffId??'');changed();
    }} className="w-full rounded-xl border px-3 py-2.5">{eligible.map(item=><option key={item.itemId} value={item.itemId}>{item.serviceName}</option>)}
    {action.pending&&!eligible.some(i=>i.itemId===targetItemId)&&<option value={targetItemId}>{text('originalService')}</option>}</select></label>}
   <label className="block space-y-1 text-sm"><span>{t('schedule.adServiceItem')}</span><select value={serviceId} disabled={locked}
    onChange={e=>{setServiceId(e.target.value);changed();}} className="w-full rounded-xl border px-3 py-2.5">
    <option value="">{t('schedule.adChooseService')}</option>{services.filter(s=>!s.isAddon&&s.staffCount===1).map(s=><option key={s.id} value={s.id}>{s.name} · {new Intl.NumberFormat(language,{style:'currency',currency:appointment.deposit!.currency}).format(s.priceCents/100)}</option>)}
    {action.pending&&!services.some(s=>s.id===serviceId)&&<option value={serviceId}>{String(action.pending.meta?.serviceName??'')}</option>}
   </select></label>
   <label className="block space-y-1 text-sm"><span>{t('schedule.adStaffLabel')}</span><select value={staffId} disabled={locked} onChange={e=>{setStaffId(e.target.value);changed();}} className="w-full rounded-xl border px-3 py-2.5">
    <option value="">{t('schedule.adUnassignedStaff')}</option>{staff.map(s=><option key={s.membershipId} value={s.membershipId}>{s.name}</option>)}
   </select></label>
   {!replace&&guests.length>1&&<label className="block space-y-1 text-sm"><span>{text('guest')}</span><select value={guestIndex} disabled={locked} onChange={e=>{setGuestIndex(Number(e.target.value));changed();}} className="w-full rounded-xl border px-3 py-2.5">
    {guests.map(g=><option key={g.guestIndex} value={g.guestIndex}>{depositText(language,'guestLabel').replace('{n}',String(g.guestIndex+1))}</option>)}</select></label>}
   {currentQuote&&<DepositAdjustmentReview quote={currentQuote} language={language} accepted={accepted} onAccepted={setAccepted} disabled={locked}/>}
   {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>
 </Modal>;
}
