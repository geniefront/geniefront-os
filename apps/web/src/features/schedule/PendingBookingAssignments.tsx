import {useRef,useState} from 'react';
import {toast} from '@heroui/react';
import {useLanguage} from '@/LanguageContext';
import {useCan} from '@/lib/permissions';
import {useErrorMessage} from '@/lib/errorMessage';
import {Button} from '@/components/ui/Button';
import {useRescheduleAppointment} from './api';
export function PendingBookingAssignments({appointmentId,date,items,staff,onChanged}:{
 appointmentId:string;date:string;
 items:Array<{itemId:string;serviceName:string;staffId:string|null;startsAt:string;status?:string}>;
 staff:Array<{membershipId:string;name:string;isBookable?:boolean}>;
 onChanged:()=>void;
}) {
 const {t}=useLanguage(),canAssign=useCan('appointment.write'),errorMessage=useErrorMessage();
 const mutation=useRescheduleAppointment(date),lock=useRef(false);
 const [selected,setSelected]=useState<Record<string,string>>({});
 const pending=items.filter(i=>!i.staffId&&i.status!=='cancelled');
 if(!pending.length||!canAssign)return null;
 async function assign(item:typeof items[number]) {
  const membershipId=selected[item.itemId];if(!membershipId||lock.current)return;
  lock.current=true;
  try {await mutation.mutateAsync({appointmentId,itemId:item.itemId,startsAt:item.startsAt,membershipId});onChanged();}
  catch(error){toast.danger(errorMessage(error));}finally{lock.current=false;}
 }
 return <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
  <h4 className="text-sm font-semibold">{t('settings.bookingManualAssign')}</h4>
  {pending.map((item,index)=><div key={item.itemId} className="flex flex-wrap items-center gap-2">
   <span className="min-w-0 flex-1 text-sm">{index+1}. {item.serviceName}</span>
   <select aria-label={`${t('settings.bookingManualAssign')}: ${index+1}. ${item.serviceName}`} disabled={mutation.isPending} value={selected[item.itemId]??''} onChange={e=>setSelected({...selected,[item.itemId]:e.target.value})} className="max-w-full rounded-lg border bg-white p-2 text-sm">
    <option value="">{t('schedule.adChooseStaff')}</option>
    {staff.filter(s=>s.isBookable!==false&&s.membershipId!=='unassigned').map(s=><option key={s.membershipId} value={s.membershipId}>{s.name}</option>)}
   </select>
   <Button size="sm" disabled={mutation.isPending||!selected[item.itemId]} onClick={()=>void assign(item)}>{t('settings.bookingAssign')}</Button>
  </div>)}
 </section>;
}
