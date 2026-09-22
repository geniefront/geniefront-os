import { useAttemptKey } from '@/lib/idempotency';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { TimeOff } from './StaffTimeOff';
import { useState } from 'react';
import { CalendarDays, ChevronRight, Crown, Plus, Search, Trash2, Users } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { StaffEditor } from '@/features/setup/StaffEditor';
import { useSetupSave } from '@/features/setup/autosave';
import type { StaffItem } from '@/features/settings/types';
import { useSaveStaffProfile, useSetEmploymentStatus } from './api';
import { StaffTimeOff } from './StaffTimeOff';
import { Field, Toggle } from '@/features/setup/primitives';
import { useStaffSettingsCopy } from './staffSettingsCopy';

export function StaffSettings({staff,voiceOnly}:{staff:StaffItem[];voiceOnly:boolean}) {
 const c=useStaffSettingsCopy(),{t}=useLanguage(),{membershipId,context}=useSession(),saves=useSetupSave();
 const schedule=useQuery({queryKey:['staff-booking-schedules',membershipId],queryFn:()=>apiGet<{timeOff:Record<string,TimeOff[]>}>('/v1/desk/staff/booking-schedules')});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:context?.timezone??'America/New_York'}).format(new Date());
 const leaveFor=(id:string)=>(schedule.data?.timeOff?.[id]??[]).filter(l=>l.endDate>=today).sort((a,b)=>a.startDate.localeCompare(b.startDate));
 const [search,setSearch]=useState(''),[selected,setSelected]=useState<StaffItem|null>(null),[tab,setTab]=useState<'profile'|'leave'>('profile');
 const [adding,setAdding]=useState(false),[name,setName]=useState(''),[bookable,setBookable]=useState(true),[deleting,setDeleting]=useState<StaffItem|null>(null),[err,setErr]=useState('');
 const save=useSaveStaffProfile(),remove=useSetEmploymentStatus(),addAttempt=useAttemptKey();
 const filtered=staff.filter(s=>(s.name+' '+(s.phoneE164??'')).toLowerCase().includes(search.toLowerCase()));
 const protectedMember=(s:StaffItem)=>s.membershipId===membershipId||s.roleKeys.includes('owner');
 const close=async()=>{if(await saves?.flush()){setSelected(null);setErr('');}};
 const errorText=(error:unknown)=>{const reason=(error as {details?:{reason?:string}})?.details?.reason;return reason==='staff_has_upcoming_appointments'?c.conflict:reason==='protected_owner_or_self'?c.ownerProtected:c.failed;};
 return <div className="space-y-5">
  <div className="grid gap-3 sm:grid-cols-3">{[[c.team,String(staff.length)],[c.bookable,String(staff.filter(s=>s.isBookable).length)],[c.upcoming,String(staff.filter(s=>leaveFor(s.membershipId).length).length)]].map(([label,value])=><div key={label} className="rounded-2xl border border-slate-200 bg-white px-5 py-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-xl font-semibold text-slate-900">{value}</p></div>)}</div>
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
   <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 p-5"><div><h3 className="font-semibold text-slate-950">{c.team}</h3><p className="mt-1 text-sm text-slate-500">{c.listHint}</p></div><Button className="gap-2" onClick={()=>{setAdding(true);setErr('');}}><Plus size={16}/>{t('setupAddStaff')}</Button></div>
   <div className="relative m-5"><Search size={17} className="absolute left-3 top-3 text-slate-400"/><Input aria-label={c.search} placeholder={c.search} value={search} onChange={e=>setSearch(e.target.value)} className="pl-10"/></div>
   <div className="divide-y divide-slate-100">{filtered.map(member=><div key={member.membershipId} className="flex flex-wrap items-center gap-4 px-5 py-5">
    <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-teal-50 font-semibold text-teal-800">{member.name.slice(0,1)}</div>
    <div className="min-w-40 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-slate-900">{member.name}</strong>{member.roleKeys.includes('owner')&&<span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800"><Crown size={12}/>{c.owner}</span>}{member.membershipId===membershipId&&<span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{c.you}</span>}</div><p className="mt-2 text-xs text-slate-500">{member.phoneE164||c.noPhone}</p>{leaveFor(member.membershipId)[0]&&<p className="mt-1 text-xs text-amber-700">{c.leaveTitle} · {leaveFor(member.membershipId)[0]!.startDate} — {leaveFor(member.membershipId)[0]!.endDate}</p>}</div>
    <span className={`rounded-full px-3 py-1 text-xs ${member.isBookable?'bg-teal-50 text-teal-700':'bg-slate-100 text-slate-500'}`}>{member.isBookable?c.acceptsBookings:c.noBookings}</span>
    <div className="flex flex-wrap items-center gap-1"><Button variant="ghost" size="sm" className="gap-2" onClick={()=>{setSelected(member);setTab('leave');setErr('');}}><CalendarDays size={15}/>{c.leaveTitle}</Button><Button variant="ghost" size="sm" className="gap-1" onClick={()=>{setSelected(member);setTab('profile');setErr('');}}>{c.manage}<ChevronRight size={15}/></Button><Button variant="ghost" size="sm" aria-label={`${c.deleteStaff} ${member.name}`} disabled={protectedMember(member)} title={protectedMember(member)?c.ownerProtected:c.deleteStaff} onClick={()=>{setDeleting(member);setErr('');}}><Trash2 size={15} className={protectedMember(member)?'text-slate-300':'text-red-500'}/></Button></div>
   </div>)}</div>
   {!filtered.length&&<p className="p-8 text-center text-sm text-slate-500">{c.empty}</p>}
   <p className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 text-xs leading-5 text-slate-500"><Crown size={14}/>{c.ownerProtected}</p>
  </section>
  <Modal isOpen={!!selected} onOpenChange={open=>{if(!open)void close();}} title={selected?.name??''} size="lg" footer={<Button variant="secondary" onClick={()=>void close()}>{c.done}</Button>}>
   <div className="mb-5 flex gap-2 border-b border-slate-100 pb-3"><Button variant={tab==='profile'?'default':'ghost'} onClick={async()=>{if(await saves?.flush())setTab('profile');}}>{c.profile}</Button><Button variant={tab==='leave'?'default':'ghost'} onClick={async()=>{if(await saves?.flush())setTab('leave');}}>{c.leaveTitle}</Button></div>
   {selected&&(tab==='profile'?<StaffEditor staff={selected} voiceOnly={voiceOnly}/>:<StaffTimeOff id={selected.membershipId}/>)}
  </Modal>
  <Modal isOpen={adding} isDismissDisabled={save.isPending} onOpenChange={open=>{if(!open&&!save.isPending){setAdding(false);setName('');}}} title={t('setupAddStaff')} size="md" footer={<Button disabled={save.isPending||!name.trim()} onClick={async()=>{try{await save.mutateAsync({name:name.trim(),isBookable:bookable,maxConcurrentAppointments:1,idempotencyKey:addAttempt.take({name:name.trim(),bookable})});addAttempt.settle({name:name.trim(),bookable});setAdding(false);setName('');setErr('');}catch(e){setErr(errorText(e));}}}>{save.isPending?c.saving:c.add}</Button>}>
   <div className="space-y-4"><Field label={t('setupFieldStaffName')}><Input autoFocus value={name} onChange={e=>setName(e.target.value)}/></Field><Toggle checked={bookable} onChange={setBookable} label={t('setupToggleBookableLabel')} description={t('setupToggleBookableDesc')}/>{err&&<p role="alert" className="text-sm text-red-600">{err}</p>}</div>
  </Modal>
  <Modal isOpen={!!deleting} isDismissDisabled={remove.isPending} onOpenChange={open=>{if(!open&&!remove.isPending)setDeleting(null);}} title={`${c.deleteStaff} · ${deleting?.name??''}`} size="md" footer={<><Button variant="secondary" onClick={()=>setDeleting(null)} disabled={remove.isPending}>{c.keep}</Button><Button className="bg-red-600 text-white" disabled={remove.isPending} onClick={async()=>{if(!deleting)return;try{await remove.mutateAsync({membershipId:deleting.membershipId,status:'resigned'});setDeleting(null);}catch(e){setErr(errorText(e));}}}>{remove.isPending?c.saving:c.confirmDelete}</Button></>}>
   <p className="text-sm leading-7 text-slate-600">{c.deleteHint}</p>{err&&<p role="alert" className="mt-3 text-sm text-red-600">{err}</p>}
  </Modal>
 </div>;
}
