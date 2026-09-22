import type postgres from 'postgres';
import { wallMinuteToInstant, dayWindows } from '@gf/scheduling';
export type WeeklyHours = Record<string, {open:string;close:string;periods?:Array<{open:string;close:string}>}|null>;
export function recurringWindows(settings: Record<string, any>, hours: WeeklyHours, date: string, ids: string[], shifts: Array<{membership_id:string;start_min:number;end_min:number;status:string}>) {
  const day = ['sun','mon','tue','wed','thu','fri','sat'][new Date(`${date}T12:00:00Z`).getUTCDay()]!;
  const recurring = settings.capacity?.use_recurring_staff === true || settings.capacity?.booking_mode === 'location';
  return ids.flatMap(id => {
    const explicit = shifts.filter(s=>s.membership_id===id);
    const schedule = settings.staff_booking_schedules?.[id] ?? hours;
    let windows = explicit.length
      ? explicit.filter(s=>s.status==='published').map(s=>({id,startMin:s.start_min,endMin:s.end_min}))
      : recurring ? dayWindows(date,schedule).map(w=>({id,startMin:w.openMin,endMin:w.closeMin})) : [];
    // Subtract local calendar days, including the tail of an overnight shift.
    for (const leave of settings.staff_time_off?.[id] ?? []) {
      const startMin = (Date.parse(leave.startDate)-Date.parse(date))/60000;
      const endMin = (Date.parse(leave.endDate)-Date.parse(date))/60000+1440;
      windows = windows.flatMap(w=>{
        if(w.endMin<=startMin||w.startMin>=endMin)return [w];
        return [...(w.startMin<startMin?[{...w,endMin:startMin}]:[]),...(w.endMin>endMin?[{...w,startMin:endMin}]:[])];
      });
    }
    return windows;
  });
}
export async function loadBookingStaff(tx: postgres.TransactionSql, locationId:string, date:string) {
 const [loc]=await tx<{settings:Record<string,any>;business_hours:WeeklyHours;timezone:string}[]>`select settings,business_hours,timezone from locations where id=${locationId}`;
 const staff=await tx<{id:string}[]>`select sp.membership_id as id from staff_profiles sp join memberships m on m.id=sp.membership_id where sp.location_id=${locationId} and sp.is_bookable and m.status='active'`;
 const shifts=await tx<{membership_id:string;start_min:number;end_min:number;status:string}[]>`select membership_id,start_min,end_min,status from shifts where location_id=${locationId} and business_date=${date}`;
 if(!loc)return [];
 return recurringWindows(loc.settings,loc.business_hours,date,staff.map(s=>s.id),shifts).map(w=>({...w,startsAt:wallMinuteToInstant(date,loc.timezone,w.startMin),endsAt:wallMinuteToInstant(date,loc.timezone,w.endMin)}));
}

export async function enforceScheduledBooking(tx:postgres.TransactionSql, locationId:string,date:string,settings:Record<string,any>,item:{startsAt:Date;endsAt:Date;membershipId?:string|null},existing:Array<{startsAt:Date;endsAt:Date;membershipId:string|null;groupKey?:string|null}>,preloaded?:Awaited<ReturnType<typeof loadBookingStaff>>) {
 if(!settings.capacity?.use_recurring_staff)return;
 const {AppError,ERROR_CODES}=await import('@gf/contracts');
 const {checkCapacity,bookingLimits,readBookingPolicy}=await import('@gf/scheduling');
 const windows=preloaded??await loadBookingStaff(tx,locationId,date);
 const onDuty=windows.filter(w=>w.startsAt<=item.startsAt&&w.endsAt>=item.endsAt);
 const count=new Set(onDuty.map(w=>w.id)).size;
 const fail=()=>{throw new AppError(ERROR_CODES.RESOURCE_CONFLICT,{details:{reason:'staff_or_capacity_unavailable'}});};
 if(!count || (item.membershipId&&!onDuty.some(w=>w.id===item.membershipId)))fail();
 const policy=readBookingPolicy(settings),limit=bookingLimits(policy,count,false).locationLimit;
 if(checkCapacity({proposed:item,staff:item.membershipId?{membershipId:item.membershipId,maxConcurrent:1,isBookable:true,existing:existing.filter(e=>e.membershipId===item.membershipId)}:null,location:{maxConcurrentPerSlot:limit,onDutyBookableCount:count,existing}}).length)fail();
 if(!item.membershipId) {
   const extra=policy.bufferEnabled?policy.bufferExtra:0;
   if(!extra||checkCapacity({proposed:item,staff:null,location:{maxConcurrentPerSlot:extra,onDutyBookableCount:count,existing:existing.filter(e=>!e.membershipId)}}).length)fail();
 }
}
