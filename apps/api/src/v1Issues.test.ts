import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { withTenant, closeDb } from '@gf/db';
import { type CommandContext, type Permission } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/customer';
import './handlers/ticket';
import './handlers/kiosk';
import './handlers/marketing';
import { loadAppointmentDetail } from './queries/appointmentDetail';
import { loadStaffDirectory } from './queries/staffList';
import { loadStaffToday } from './queries/staff';
import { loadCustomerDetail, loadCustomerList } from './queries/customer';
import { loadReport, reportToCsv } from './queries/money';
import { loadDayMoney } from './handlers/dayclose';
import { registerFormsRoutes } from './routes/forms';
import { registerAuthRoutes } from './auth/routes';
import { issuePhoneSelection, verifyPhoneSelection } from './auth/phoneSelection';
import { checkPhoneCode } from './auth/phoneOtp';
vi.mock('./auth/phoneOtp', () => ({ checkPhoneCode: vi.fn(), sendPhoneCode: vi.fn(), verifyConfigured: () => true }));
const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
const spa = { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null };
let ctx: CommandContext, tech: CommandContext;
let customer: string;
const run = <T = any>(name: string, input: unknown, context = ctx, key = randomUUID()) => dispatch<T>(name,input,context,{idempotencyKey:key});
const perms = (...permissions: Permission[]): CommandContext => ({...ctx,permissions:new Set(permissions)});
async function fixtureTicket(date: string, subtotal = 10000, tax = 0, total = subtotal + tax, method = 'card', customerId = customer) {
 return withTenant(ctx, async tx => {
  const [t] = await tx<{id:string}[]>`insert into tickets(org_id,location_id,business_date,status,customer_id,subtotal_cents,tax_cents,total_cents,closed_at)
   values(${ctx.orgId},${ctx.locationId},${date},'closed',${customerId},${subtotal},${tax},${total},now()) returning id`;
  await tx`insert into payments(org_id,location_id,ticket_id,method,amount_cents,tip_cents)
   values(${ctx.orgId},${ctx.locationId},${t!.id},${method},${total},0)`;
  return t!.id;
 });
}
beforeAll(async()=>{
 process.env['APP_JWT_SECRET']='v1-regression-only-32-character-secret';
 process.env['FORM_ENCRYPTION_KEY']='000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
 const rows=await withTenant(tenant,tx=>tx<{id:string;user_id:string;key:string}[]>`select m.id,m.user_id,r.key from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and m.user_id is not null`);
 const manager=rows.find(r=>r.key==='manager')!; const staff=rows.find(r=>r.key==='tech' && !rows.some(other=>other.id===r.id && ['manager','owner'].includes(other.key)))!;
 const owner=await buildContext({userId:manager.user_id,membershipId:manager.id});
 ctx={...owner,permissions:new Set([...owner.permissions,'ticket.refund'])};
 tech=await buildContext({userId:staff.user_id,membershipId:staff.id});
 customer=(await run('customer.saveProfile',{name:'V1 audit guest',phoneE164:'+16175550191'})).result.customerId;
});
afterAll(closeDb);
describe('v1 issues regression',()=>{
 it('#3 rejects negative tip allocations for both close and pay before any writes',async()=>{
  for(const command of ['ticket.close','ticket.pay']) {
   await expect(run(command,{ticketId:randomUUID(),payments:[{method:'card',amountCents:6000,tipCents:1000}],tipSplits:[{staffMembershipId:randomUUID(),amountCents:1500},{staffMembershipId:randomUUID(),amountCents:-500}]})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  }
 });
 it('#4 checks discount on close, pay and group checkout',async()=>{
  for(const name of ['ticket.close','ticket.pay','ticket.closeGroup']) {
   const id=randomUUID();
   const payload={ticketId:id,groupId:randomUUID(),ticketIds:[id],discountCents:500,payments:[{method:'cash',amountCents:100}]};
   await expect(run(name,payload,perms('ticket.write'))).rejects.toMatchObject({code:'PERMISSION_DENIED',details:{need:'ticket.discount'}});
  }
 });
 it('#5 enforces refund permission independently of void permission',async()=>{
  const id=await fixtureTicket('2001-01-01'); const input={ticketId:id,refundAmountCents:1000,refundMethod:'original_payment',reason:'other'};
  await expect(run('ticket.refund',input,perms('ticket.void'))).rejects.toMatchObject({code:'PERMISSION_DENIED',details:{need:'ticket.refund'}});
  expect(await withTenant(ctx,tx=>tx`select id from ticket_refunds where ticket_id=${id}`)).toHaveLength(0);
  await expect(run('ticket.refund',input,perms('ticket.refund'))).resolves.toMatchObject({result:{refundedCents:1000}});
 });
 it('#9 separates directory basics, own pay, all pay and HR fields',async()=>{
  await withTenant(ctx,tx=>tx`update staff_profiles set notes='private HR note' where membership_id=${ctx.membershipId}`);
  const own=await withTenant(tech,tx=>loadStaffDirectory(tx,tech));
  expect(own.staff.find(s=>s.id===ctx.membershipId)).toMatchObject({payroll:null,phone:'',hireDate:''});
  expect(own.staff.find(s=>s.id===ctx.membershipId)?.note).toBeUndefined();
  expect(own.staff.find(s=>s.id===tech.membershipId)?.payroll).not.toBeNull();
  const readOnly=await withTenant(tech,tx=>loadStaffDirectory(tx,{...tech,permissions:new Set(['ticket.read'])}));
  expect(readOnly.staff.every(s=>s.payroll===null)).toBe(true);
  const pay=await withTenant(ctx,tx=>loadStaffDirectory(tx,perms('payroll.view_all')));
  expect(pay.staff.every(s=>s.payroll!==null)).toBe(true);
  expect(pay.staff.every(s=>s.note===undefined)).toBe(true);
  const admin=await withTenant(ctx,tx=>loadStaffDirectory(tx,ctx));
  expect(admin.staff.find(s=>s.id===ctx.membershipId)?.note).toBe('private HR note');
 });
 it('#13 masks unlinked walk-in contact for actual tech memberships',async()=>{
  const [q]=await withTenant(ctx,tx=>tx<{id:string}[]>`insert into walkin_queue(org_id,location_id,customer_id,walk_in_name,business_date,status,ticket_number)
   values(${ctx.orgId},${ctx.locationId},${customer},'Guest',current_date,'waiting',999) returning id`);
  const low=await withTenant(tech,tx=>loadAppointmentDetail(tx,tech,q!.id));
  expect(low.customer.phone).not.toBe('+16175550191');expect(low.customer.phone).toContain('0191');
  const high=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,q!.id));expect(high.customer.phone).toBe('+16175550191');
 });
 it('#14 preserves historical sales and books each refund on its own date',async()=>{
  const date='2001-01-02';const id=await fixtureTicket(date);
  const report=()=>withTenant(ctx,tx=>loadReport(tx,ctx,date,date));
  const [now]=await withTenant(ctx,tx=>tx<{d:string}[]>`select (now() at time zone timezone - (business_day_cutoff - time '00:00'))::date::text as d from locations where id=${ctx.locationId}`);
  const today=now!.d; const before=await withTenant(ctx,tx=>loadReport(tx,ctx,today,today));
  for(const amount of [2000,8000]) await run('ticket.refund',{ticketId:id,refundAmountCents:amount,reason:'other'});
  expect((await report()).summary.totalCents).toBe(10000);
  const after=await withTenant(ctx,tx=>loadReport(tx,ctx,today,today));
  expect(after.summary.totalCents-before.summary.totalCents).toBe(-10000);
  expect(after.summary.cardCents-before.summary.cardCents).toBe(-10000);
  expect(reportToCsv(after)).toContain((after.summary.totalCents/100).toFixed(2));
 });
 it('#15 fully reverses inclusive tax, including cumulative partial refunds',async()=>{
  const id=await fixtureTicket('2001-01-03',11000,1000,11000);
  for(const amount of [4000,7000]) await run('ticket.refund',{ticketId:id,refundAmountCents:amount,reason:'other'});
  const [r]=await withTenant(ctx,tx=>tx<{amount:number;service:number;tax:number}[]>`select sum(amount_cents)::int as amount,sum(service_cents)::int as service,sum(tax_cents)::int as tax from ticket_refunds where ticket_id=${id}`);
  expect(r).toEqual({amount:11000,service:10000,tax:1000});
 });
 it('#17 does not count customer credit as card payments',async()=>{
  const date='2001-01-04';await fixtureTicket(date,5000,0,5000,'customer_credit');
  const report=await withTenant(ctx,tx=>loadReport(tx,ctx,date,date));
  const daily=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,date));
  expect(report.summary.cardCents).toBe(0);expect(daily.customerCreditPaidCents).toBe(5000);
 });
 it('#8 uses the last carry instead of the largest historical balance',async()=>{
  await withTenant(ctx,tx=>tx`insert into tip_payouts(org_id,location_id,business_date,membership_id,owed_cents,paid_cents,carry_in_cents,carry_out_cents,paid_by)
   values(${ctx.orgId},${ctx.locationId},'2001-02-01',${tech.membershipId},1000,0,0,1000,${ctx.membershipId}),
   (${ctx.orgId},${ctx.locationId},'2001-02-02',${tech.membershipId},1000,1000,1000,0,${ctx.membershipId})`);
  const today=await withTenant(tech,tx=>loadStaffToday(tx,tech,'2001-02-03',tech.membershipId!));
  expect(today.earnings.cashTipOwedCents).toBe(0);
 });
 it('#16 merges assets without updating ledger identity or amounts',async()=>{
  const source=(await run('customer.saveProfile',{name:'Asset source'})).result.customerId;
  const target=(await run('customer.saveProfile',{name:'Asset target'})).result.customerId;
  await run('giftcard.issue',{faceValueCents:1000,salePriceCents:1000,purchaserCustomerId:source,holderCustomerId:source});
  await run('loyalty.adjustPoints',{customerId:source,pointsDelta:50,reason:'audit points'});
  await withTenant(ctx,tx=>tx`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,customer_id,entry,amount_cents,balance_after_cents)
   values(${ctx.orgId},${ctx.locationId},'store_credit',${source},${source},'adjust',2000,2000)`);
  const before=await withTenant(ctx,tx=>tx`select id,subject_id,customer_id,amount_cents from customer_credit_ledger where customer_id=${source} order by id`);
  await run('customer.merge',{sourceCustomerId:source,targetCustomerId:target});
  const after=await withTenant(ctx,tx=>tx`select id,subject_id,customer_id,amount_cents from customer_credit_ledger where customer_id=${source} order by id`);
  expect(after).toEqual(before);
  expect((await withTenant(ctx,tx=>loadCustomerDetail(tx,ctx,target)))?.storeCreditBalanceCents).toBe(2000);
  await run('loyalty.adjustPoints',{customerId:target,pointsDelta:-20,reason:'use inherited points'});
  await expect(run('loyalty.adjustPoints',{customerId:target,pointsDelta:-31,reason:'no overdraft'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(run('customer.merge',{sourceCustomerId:target,targetCustomerId:source})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
 });
 it('#19 filters before pagination and keeps whole-store metrics stable',async()=>{
  await withTenant(ctx,tx=>tx`insert into customers(org_id,primary_location_id,display_name,vip_level)
    select ${ctx.orgId},${ctx.locationId},'AAA page guest '||n::text,0 from generate_series(1,210) n`);
  const vip=(await run('customer.saveProfile',{name:'ZZZZ outside first page',vipLevel:3})).result.customerId;
  const all=await withTenant(ctx,tx=>loadCustomerList(tx,ctx,{limit:200}));
  const filtered=await withTenant(ctx,tx=>loadCustomerList(tx,ctx,{limit:200,filterType:'vip'}));
  const searched=await withTenant(ctx,tx=>loadCustomerList(tx,ctx,{q:'ZZZZ',limit:1}));
  expect(all.rows.some(r=>r.id===vip)).toBe(false);expect(filtered.rows.some(r=>r.id===vip)).toBe(true);
  expect(filtered.metrics).toEqual(all.metrics);expect(searched.metrics).toEqual(all.metrics);
  expect(filtered.metrics.vipCount).toBe(filtered.total);
 });
 it('#18 resubmission forwards a stable request key and creates one version',async()=>{
  const template=(await run('catalog.saveFormTemplate',{key:'v_one_regression',title:{en:'Test'},questions:[{id:'note',type:'text',label:{en:'Note'}}],requiresSignature:false})).result.templateId;
  const app=Fastify(); app.setErrorHandler((e:any,_req,reply)=>reply.code(400).send({code:e.code,details:e.details}));
  registerFormsRoutes(app,async()=>ctx);
  const payload={templateId:template,customerId:customer,answers:{},signerName:'Guest'};
  const without=await app.inject({method:'POST',url:'/v1/desk/forms/re-submit',payload});
  expect(without.json().code).toBe('VALIDATION_FAILED');
  const headers={'idempotency-key':randomUUID()};
  const first=await app.inject({method:'POST',url:'/v1/desk/forms/re-submit',headers,payload});
  expect(first.statusCode).toBe(200);
  const second=await app.inject({method:'POST',url:'/v1/desk/forms/re-submit',headers,payload});
  expect(second.json().submissionId).toBe(first.json().submissionId);
  const submissions=await withTenant(ctx,tx=>tx`select id from form_submissions where template_id=${template}`);
  expect(submissions).toHaveLength(1);await app.close();
 });
 it('#11 consumes OTP once then uses a one-use location selection token',async()=>{
  const phone='+16175550222';
  await withTenant(ctx,tx=>tx`update staff_profiles set phone_e164=${phone} where membership_id=${tech.membershipId}`);
  const [other]=await withTenant(spa,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${spa.locationId} limit 1`);
  await withTenant(spa,tx=>tx`update staff_profiles set phone_e164=${phone} where membership_id=${other!.membership_id}`);
  vi.mocked(checkPhoneCode).mockResolvedValueOnce(true).mockResolvedValue(false);
  const app=Fastify(); app.setErrorHandler((e:any,_req,reply)=>reply.code(400).send({code:e.code}));registerAuthRoutes(app);
  const first=await app.inject({method:'POST',url:'/v1/auth/phone/verify',payload:{phone,code:'123456'}});
  expect(first.json().needsLocation).toBe(true);const selectionToken=first.json().selectionToken;
  const payload={selectionToken,locationId:spa.locationId};
  const second=await app.inject({method:'POST',url:'/v1/auth/phone/verify',payload});expect(second.statusCode).toBe(200);expect(second.json().token).toMatch(/^gfs_/);
  expect(checkPhoneCode).toHaveBeenCalledTimes(1);
  const replay=await app.inject({method:'POST',url:'/v1/auth/phone/verify',payload});expect(replay.json().code).toBe('UNAUTHENTICATED');
  await expect(verifyPhoneSelection(selectionToken+'tampered')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
  const token=await issuePhoneSelection(phone,[{orgId:ctx.orgId,locationId:ctx.locationId,membershipId:tech.membershipId!}]);
  vi.useFakeTimers();vi.setSystemTime(Date.now()+6*60_000);await expect(verifyPhoneSelection(token)).rejects.toMatchObject({code:'UNAUTHENTICATED'});vi.useRealTimers();
  await app.close();
 });
});
