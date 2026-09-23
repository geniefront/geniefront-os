import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageError } from '@/components/ui/QueryState';
import {HoursPeriodsEditor, type DayHours} from './HoursPeriodsEditor';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { apiGet, runCommand } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { SaveStatus, useSetupDraft } from './autosave';
type Hours=Record<string,DayHours|null>;
export function StaffBookingSchedule({id}:{id:string}) {
 const {t}=useLanguage(),{membershipId}=useSession(),qc=useQueryClient();
 const key=['staff-booking-schedules',membershipId];
 const query=useQuery({queryKey:key,queryFn:()=>apiGet<{hours:Hours;schedules:Record<string,Hours>}>('/v1/desk/staff/booking-schedules')});
 const draft=useSetupDraft(query.data?(query.data.schedules[id]??query.data.hours):null,async hours=>{
  await runCommand('staff.saveBookingSchedule',{membershipId:id,hours},membershipId!);await qc.invalidateQueries({queryKey:key});
 }, `setup-staff-schedule:${membershipId}:${id}`);
 if(query.isError)return <PageError error={query.error} onRetry={()=>query.refetch()}/>;
 if(!draft.value)return <p><LoadingSpinner label={t('setupReadinessLoading')} /></p>;
 return <details className="rounded-xl border p-3"><summary className="cursor-pointer font-semibold">{t('voiceStaffSchedule')}</summary><p className="my-2 text-sm text-slate-500">{t('voiceStaffScheduleHint')}</p>
 {['mon','tue','wed','thu','fri','sat','sun'].map(day=>{const h=draft.value![day];return <div key={day} className="my-2 flex flex-wrap items-center gap-2"><label className="flex w-28 gap-2"><input type="checkbox" checked={!!h} onChange={e=>draft.set(old=>({...old,[day]:e.target.checked?(query.data?.hours[day]??{open:'09:00',close:'17:00'}):null}))}/>{t(`voiceDay_${day}`)}</label>{h&&<HoursPeriodsEditor label={t(`voiceDay_${day}`)} value={h} onChange={next=>draft.set(old=>({...old,[day]:next}))}/>}</div>})}<SaveStatus {...draft}/></details>;
}
