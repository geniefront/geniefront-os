import { useAttemptKey } from '@/lib/idempotency';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Trash2 } from 'lucide-react';
import { useSession } from '@/lib/session';
import { apiGet, runCommand } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { PageError } from '@/components/ui/QueryState';
import { Field } from '@/features/setup/primitives';
import { useStaffSettingsCopy } from './staffSettingsCopy';
export type TimeOff={id:string;startDate:string;endDate:string;note:string};
export function StaffTimeOff({id}:{id:string}){
 const c=useStaffSettingsCopy(),{membershipId}=useSession(),qc=useQueryClient();
 const attempt=useAttemptKey();
 const [draftId,setDraftId]=useState(()=>crypto.randomUUID());
 const key=['staff-booking-schedules',membershipId];
 const query=useQuery({queryKey:key,queryFn:()=>apiGet<{timeOff:Record<string,TimeOff[]>}>('/v1/desk/staff/booking-schedules')});
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(leave:TimeOff,remove=false){
  if(busy)return;
  if(!leave.startDate||!leave.endDate||leave.startDate>leave.endDate||Date.parse(leave.endDate)-Date.parse(leave.startDate)>365*86400000){setError(c.invalid);return;}
  setBusy(true);setError('');
  const input={membershipId:id,...leave,remove};
  try{await runCommand('staff.saveTimeOff',input,membershipId!,attempt.take(input));attempt.settle(input);await qc.invalidateQueries({queryKey:key});if(!remove){setDraftId(crypto.randomUUID());setStart('');setEnd('');setNote('');}}
  catch(e){setError((e as {details?:{reason?:string}}).details?.reason==='staff_has_upcoming_appointments'?c.conflict:c.failed);}finally{setBusy(false);}
 }
 if(query.isError)return <PageError error={query.error} onRetry={()=>query.refetch()}/>;
 return <div className="space-y-5"><p className="rounded-xl bg-teal-50 p-4 text-sm leading-6 text-teal-900">{c.leaveHint}</p>
  <div className="grid gap-4 sm:grid-cols-2"><Field label={c.start}><Input type="date" value={start} onChange={e=>{setStart(e.target.value);if(!end||end<e.target.value)setEnd(e.target.value);}}/></Field><Field label={c.end}><Input type="date" min={start} value={end} onChange={e=>setEnd(e.target.value)}/></Field></div>
  <Field label={c.note}><Input maxLength={200} value={note} onChange={e=>setNote(e.target.value)}/></Field>
  {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
  <Button disabled={busy||!start||!end||query.isPending} className="gap-2" onClick={()=>void save({id:draftId,startDate:start,endDate:end,note})}><CalendarDays size={16}/>{busy?c.saving:c.saveLeave}</Button>
  <section className="border-t border-slate-200 pt-5"><h3 className="mb-3 text-sm font-semibold">{c.upcoming}</h3>{!(query.data?.timeOff?.[id]?.length)&&<p className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">{c.noLeave}</p>}{[...(query.data?.timeOff?.[id]??[])].sort((a,b)=>a.startDate.localeCompare(b.startDate)).map(leave=><div key={leave.id} className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-4"><div><p className="text-sm font-semibold">{leave.startDate} — {leave.endDate}</p>{leave.note&&<p className="mt-1 text-xs text-slate-500">{leave.note}</p>}</div><Button variant="ghost" size="sm" disabled={busy} aria-label={c.cancelLeave} onClick={()=>void save(leave,true)}><Trash2 size={15}/></Button></div>)}</section>
 </div>;
}
