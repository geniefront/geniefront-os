import { SaveStaffTimeOff, AppError, ERROR_CODES } from '@gf/contracts';
import { jsonb } from '@gf/db';
import type { HandlerArgs } from './bus';
import { lockBookingCapacity } from './handlers/appointment';

export async function saveStaffTimeOff({input,ctx,tx,audit}: HandlerArgs<typeof SaveStaffTimeOff.input._type>) {
 await lockBookingCapacity(tx,ctx.locationId);
 const [member]=await tx`select id from memberships where id=${input.membershipId} and location_id=${ctx.locationId} and status='active'`;
 if(!member)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [loc]=await tx<{settings:Record<string,any>;timezone:string}[]>`select settings,timezone from locations where id=${ctx.locationId} for update`;
 const all={...loc!.settings.staff_time_off};
 const before=all[input.membershipId]??[];
 if(!input.remove){
  const [conflict]=await tx`select ai.id from appointment_items ai join appointments a on a.id=ai.appointment_id where a.location_id=${ctx.locationId} and coalesce(ai.membership_id,ai.reserved_membership_id)=${input.membershipId} and ai.starts_at < ((${input.endDate}::date+1)::timestamp at time zone ${loc!.timezone}) and ai.ends_at > (${input.startDate}::date::timestamp at time zone ${loc!.timezone}) and ai.ends_at>now() and ai.status not in ('cancelled','no_show','completed') and a.status not in ('cancelled','no_show','completed') limit 1`;
  if(conflict)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'staff_has_upcoming_appointments'}});
 }
 const after=before.filter((v:{id:string})=>v.id!==input.id);
 if(!input.remove)after.push({id:input.id,startDate:input.startDate,endDate:input.endDate,note:input.note});
 if(after.length>100)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'too_many_time_off_ranges'}});
 all[input.membershipId]=after;
 await tx`update locations set settings=jsonb_set(settings,'{staff_time_off}',${jsonb(all)}::jsonb),updated_at=now() where id=${ctx.locationId}`;
 audit({entityType:'staff',entityId:input.membershipId,before,after});
 return {saved:true};
}
