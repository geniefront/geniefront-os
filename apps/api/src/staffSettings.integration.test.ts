import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withTenant,closeDb} from '@gf/db';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {loadBookingStaff} from './queries/bookingStaff';
import './handlers/staff';
import './handlers/phone';
const orgId='11111111-1111-4111-8111-111111111111',locationId='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant={orgId,locationId,membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>,staff:string;
const run=async(name:string,input:unknown)=> (await dispatch<any>(name,input,ctx,{idempotencyKey:randomUUID()})).result;
beforeAll(async()=>{
 const [actor]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=${locationId} and r.key='manager' limit 1`);
 ctx=await buildContext({userId:actor!.user_id,membershipId:actor!.id});
 staff=(await run('staff.saveProfile',{name:'Time off integration',isBookable:true})).membershipId;
 await withTenant(ctx,tx=>tx`update locations set settings=jsonb_set(settings,'{capacity}', '{"use_recurring_staff":true,"booking_mode":"staff"}'::jsonb) where id=${locationId}`);
});
afterAll(closeDb);
it('persists leave through the command bus, excludes the employee, and restores their schedule',async()=>{
 const day='2030-10-01',id=randomUUID();
 expect((await withTenant(ctx,tx=>loadBookingStaff(tx,locationId,day))).some(s=>s.id===staff)).toBe(true);
 await run('staff.saveTimeOff',{membershipId:staff,id,startDate:day,endDate:day,note:'Vacation'});
 expect((await withTenant(ctx,tx=>loadBookingStaff(tx,locationId,day))).some(s=>s.id===staff)).toBe(false);
 await run('staff.saveTimeOff',{membershipId:staff,id,startDate:day,endDate:day,remove:true});
 expect((await withTenant(ctx,tx=>loadBookingStaff(tx,locationId,day))).some(s=>s.id===staff)).toBe(true);
});
it('rejects cross-shop leave and self-deactivation in both commands',async()=>{
 await expect(run('staff.saveTimeOff',{membershipId:randomUUID(),id:randomUUID(),startDate:'2030-10-01',endDate:'2030-10-01'})).rejects.toMatchObject({code:'NOT_FOUND'});
 await expect(run('staff.setEmployment',{membershipId:ctx.membershipId,status:'resigned'})).rejects.toMatchObject({details:{reason:'protected_owner_or_self'}});
 await expect(run('staff.saveProfile',{membershipId:ctx.membershipId,name:'Amy',status:'resigned'})).rejects.toMatchObject({details:{reason:'protected_owner_or_self'}});
});
it('blocks leave and deletion for a reserved appointment, then retains history after deactivation',async()=>{
 const item=await withTenant(ctx,async tx=>{
  const [customer]=await tx`select id from customers where org_id=${orgId} limit 1`;
  const [service]=await tx`select id from services where location_id=${locationId} limit 1`;
  const [a]=await tx`insert into appointments(org_id,location_id,customer_id,business_date,status,source,starts_at,ends_at) values(${orgId},${locationId},${customer!.id},'2030-10-01','booked','desk','2030-10-01T15:00:00Z','2030-10-01T16:00:00Z') returning id`;
  const [i]=await tx`insert into appointment_items(org_id,location_id,appointment_id,service_id,reserved_membership_id,starts_at,ends_at,price_cents_snapshot,duration_min) values(${orgId},${locationId},${a!.id},${service!.id},${staff},'2030-10-01T15:00:00Z','2030-10-01T16:00:00Z',4500,60) returning id`;
  return i!.id;
 });
 await expect(run('staff.saveTimeOff',{membershipId:staff,id:randomUUID(),startDate:'2030-10-01',endDate:'2030-10-01'})).rejects.toMatchObject({details:{reason:'staff_has_upcoming_appointments'}});
 await expect(run('staff.setEmployment',{membershipId:staff,status:'resigned'})).rejects.toMatchObject({details:{reason:'staff_has_upcoming_appointments'}});
 await withTenant(ctx,tx=>tx`update appointment_items set status='cancelled' where id=${item}`);
 await run('staff.setEmployment',{membershipId:staff,status:'resigned'});
 const [member]=await withTenant(ctx,tx=>tx`select status from memberships where id=${staff}`);
 expect(member!.status).toBe('left');
 expect(await withTenant(ctx,tx=>tx`select id from appointment_items where id=${item}`)).toHaveLength(1);
});
