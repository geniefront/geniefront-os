import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {withTenant,closeDb,jsonb,readOnlineBooking} from '@gf/db';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {appointmentDepositPolicy} from './commerce/depositPolicy';
import {depositGuestBalances} from './commerce/depositGuests';
import {loadDepositRetentionQuote} from './commerce/depositRetention';
import {loadAppointmentDetail} from './queries/appointmentDetail';
import {loadCommerceDay} from './queries/commerceDay';
import {resolveDate} from './handlers/dayclose';
import './handlers/setup';import './handlers/billing';import './handlers/appointment';import './handlers/appointmentDeposits';
import './handlers/appointmentGuestCancellation';import './handlers/appointmentDepositRetention';import './handlers/commerce';
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>,serviceId:string,secondServiceId:string,serial=0;
const run=async<T=Record<string,unknown>>(name:string,input:unknown,key=randomUUID())=>(await dispatch<T>(name,input,ctx,{idempotencyKey:key})).result;
const policy=async(retain=true)=>run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,
  cancelCutoffHours:48,retainDepositAfterCutoff:retain,cancellationPolicyNotice:'QA unused deposit may be retained after the original cutoff'});
async function paid(group=false,retain=true,hours?:number,email=false,serviceTotalCents=group?17000:10000){
  await policy(retain);
  const [loc]=await withTenant(tenant,tx=>tx`select settings from locations where id=${tenant.locationId}`);
  const version=appointmentDepositPolicy(readOnlineBooking(loc!.settings)).version;
  const startsAt=new Date(Date.now()+(hours??1+serial++)*3600000).toISOString();
  const h=await run<{holdId:string;appointmentId:string}>('commerce.holdAppointment',{businessKey:randomUUID(),depositConsent:{accepted:true,policyVersion:version,amountCents:2000,serviceTotalCents},
    appointment:{customerId:null,walkInName:'Retention isolated QA',source:'desk',partySize:group?2:1,override:{reason:'desk_coordination'},
      items:[{serviceId,startsAt,details:{publicGuestIndex:0}},...(group?[{serviceId:secondServiceId,startsAt,details:{publicGuestIndex:1}}]:[])],
      ...(email?{guest:{manageToken:`mt_${randomUUID()}`,bookingSmsConsent:false,customer:{name:'Retained notice QA',email:'retained-notice@example.test',phoneE164:'+12025550991'}}}:{})}});
  const p=await run<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Retention isolated receipt '+h.holdId});
  return {...h,...p,version};
}
const cancel=async(h:{appointmentId:string},reason='guest_changed_mind')=>run('appointment.cancel',{appointmentId:h.appointmentId,reason,keepStaffTurn:false});
const retain=async(h:{holdId:string},amountCents=2000,guestIndices=[0],key=randomUUID())=>{
  const quote=await withTenant(tenant,tx=>loadDepositRetentionQuote(tx,ctx,h.holdId));
  return run<{retentionId:string;amountCents:number;status:string}>('commerce.retainAppointmentDeposit',
    {holdId:h.holdId,amountCents,guestIndices,expectedGuestBalances:guestIndices.map(guestIndex=>({guestIndex,availableCents:quote.guests.find(g=>g.guestIndex===guestIndex)?.availableCents??0})),reason:'Owner reviewed original late cancellation policy'},key);
};
const balance=async(id:string)=>{
  const [f]=await withTenant(tenant,tx=>tx`select h.status,h.reserved_cents,a.deposit_status,
    (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as balance,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collections,
    (select count(*)::int from commerce_deposit_retentions where hold_id=h.id) as decisions
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${id}`);return f;
};
beforeAll(async()=>{
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.COMMERCE_STRIPE_MODE='test';process.env.STRIPE_SECRET_KEY='sk_test_retention_fixture';
  const [owner]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id
    join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
  ctx=await buildContext({userId:owner!.user_id,membershipId:owner!.id});
  await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  // Isolate finance from venue-hours and staff-calendar integration tests; capacity validation remains enabled.
  const hours=Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'00:00',close:'23:59'}]));
  await withTenant(tenant,tx=>tx`update locations set business_hours=${jsonb(hours)}::jsonb,
    settings=jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb) where id=${tenant.locationId}`);
  serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Retention QA 100'},durationMin:30,basePriceCents:10000})).serviceId;
  secondServiceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Retention QA 70'},durationMin:30,basePriceCents:7000})).serviceId;
});
afterAll(closeDb);

it('retains only after a reasoned owner decision and preserves partial-refund versus retained accounting',async()=>{
  const h=await paid();await cancel(h);expect(await balance(h.holdId)).toMatchObject({status:'review',balance:2000,decisions:0});
  await policy(false); // Current policy cannot rewrite the purchased contract.
  const key=randomUUID(),a=await retain(h,1000,[0],key);expect((await dispatch('commerce.retainAppointmentDeposit',{holdId:h.holdId,amountCents:1000,guestIndices:[0],expectedGuestBalances:[{guestIndex:0,availableCents:2000}],reason:'Owner reviewed original late cancellation policy'},ctx,{idempotencyKey:key})).result).toEqual(a);
  expect(await balance(h.holdId)).toMatchObject({status:'review',balance:1000,reserved_cents:0,collections:1,decisions:1});
  const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:h.paymentId,amountCents:1000,reason:'Owner refunds unretained remainder'});
  await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:'Unretained cash returned QA'});
  expect(await balance(h.holdId)).toMatchObject({status:'retained',deposit_status:'retained',balance:0,decisions:1});
  const [facts]=await withTenant(tenant,tx=>tx`select policy_version,recorded_by,amount_cents from commerce_deposit_retentions where id=${a.retentionId}`);
  expect(facts).toEqual({policy_version:h.version,recorded_by:ctx.membershipId,amount_cents:1000});
});

it('does not authorize retention by enabling a policy after purchase or by a future no-show label',async()=>{
  const earlier=await paid(false,false);await policy(true);await cancel(earlier);
  await expect(retain(earlier)).rejects.toMatchObject({details:{reason:'deposit_retention_policy_not_accepted'}});
  const noShow=await paid();await cancel(noShow,'no_show');
  await expect(retain(noShow)).rejects.toMatchObject({details:{reason:'deposit_retention_no_eligible_balance'}});
  const timely=await paid(false,true,60);await cancel(timely);
  await expect(retain(timely)).rejects.toMatchObject({details:{reason:'deposit_retention_no_eligible_balance'}});
  expect((await balance(timely.holdId))!.reserved_cents).toBe(2000);
});

it('splits a late guest review into an immutable decline, retained amount and still-refundable remainder',async()=>{
  const h=await paid(true);const result=await run<{refunds:Array<{refundId:string}>}>('appointment.cancelGuests',{
    appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:1176,reason:'One guest cancelled late'});
  const old=result.refunds[0]!.refundId;await retain(h,800);
  const refunds=await withTenant(tenant,tx=>tx`select id,status,amount_cents,declined_by,retention_id from commerce_refunds where payment_id=${h.paymentId} order by created_at,id`);
  expect(refunds).toHaveLength(2);expect(refunds.find(r=>r.id===old)).toMatchObject({status:'declined',amount_cents:1176,declined_by:ctx.membershipId});
  const remaining=refunds.find(r=>r.id!==old)!;expect(remaining).toMatchObject({status:'review',amount_cents:376});
  expect(await balance(h.holdId)).toMatchObject({balance:1200,reserved_cents:376,decisions:1});
  await expect(run('commerce.approveGuestRefund',{refundId:old,reason:'Cannot approve declined request'})).rejects.toMatchObject({details:{reason:'refund_not_pending_review'}});
  await run('commerce.approveGuestRefund',{refundId:remaining.id,reason:'Refund the unretained part'});
  await run('commerce.confirmOfflineRefund',{refundId:remaining.id,reference:'Guest remainder cash returned QA'});
  expect(await balance(h.holdId)).toMatchObject({status:'paid',balance:824,reserved_cents:0});
  const guests=await withTenant(tenant,tx=>depositGuestBalances(tx,ctx,h.holdId));
  expect(guests!.find(g=>g.guestIndex===1)!.availableCents).toBe(824);
  expect(guests!.find(g=>g.guestIndex===0)!.availableCents).toBe(0);
  await expect(retain(h,824,[1])).rejects.toMatchObject({details:{reason:'deposit_retention_no_eligible_balance'}});
});

it('retains a cancelled guest without changing the other guest or submitting the declined refund to Stripe',async()=>{
  const h=await paid(true);await run('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:1176,reason:'Guest late cancellation'});
  await retain(h,1176);expect(await balance(h.holdId)).toMatchObject({status:'paid',balance:824,reserved_cents:0,decisions:1});
  const [fact]=await withTenant(tenant,tx=>tx`select party_size,status,(select count(*)::int from commerce_tasks where kind='refund'
    and subject_id in(select id from commerce_refunds where payment_id=${h.paymentId})) as tasks from appointments where id=${h.appointmentId}`);
  expect(fact).toEqual({party_size:1,status:'booked',tasks:0});
});

it('uses the original guest cancellation time after the remaining group actually reschedules',async()=>{
  const h=await paid(true);await run('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:1176,reason:'Guest cancelled after original cutoff'});
  await run('appointment.reschedule',{appointmentId:h.appointmentId,startsAt:new Date(Date.now()+90*3600000).toISOString(),override:{reason:'desk_coordination'}});
  const quote=await withTenant(tenant,tx=>loadDepositRetentionQuote(tx,ctx,h.holdId));expect(quote.guests).toEqual([{guestIndex:0,availableCents:1176}]);
  await retain(h,1176);expect(await balance(h.holdId)).toMatchObject({balance:824,reserved_cents:0,status:'paid'});
});

it('keeps a remaining zero-price guest confirmed when all allocated money belonged to the cancelled guest',async()=>{
  const free=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Free remaining guest QA'},durationMin:30,basePriceCents:0})).serviceId;
  const original=secondServiceId;secondServiceId=free;
  let h:Awaited<ReturnType<typeof paid>>;
  try{h=await paid(true,true,undefined,false,10000);}finally{secondServiceId=original;}
  await run('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:2000,reason:'Paid guest cancels late; free guest remains'});
  await retain(h,2000);expect(await balance(h.holdId)).toMatchObject({status:'paid',deposit_status:'paid',balance:0,reserved_cents:0});
  const [a]=await withTenant(tenant,tx=>tx`select status,party_size,(select sum(price_cents_snapshot)::int from appointment_items where appointment_id=a.id and status='booked') as active_service_cents
    from appointments a where id=${h.appointmentId}`);
  expect(a).toEqual({status:'booked',party_size:1,active_service_cents:0});
});

it('serializes retention against refund reservation and prevents over-retention under distinct command keys',async()=>{
  const h=await paid();await cancel(h);
  const attempts=await Promise.allSettled([retain(h,1200),retain(h,1200)]);expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  expect(await balance(h.holdId)).toMatchObject({balance:800,decisions:1});
  const other=await paid();await cancel(other);
  const race=await Promise.allSettled([retain(other),run('commerce.requestRefund',{paymentId:other.paymentId,amountCents:2000,reason:'Competing refund'})]);
  expect(race.filter(a=>a.status==='fulfilled')).toHaveLength(1);const fact=(await balance(other.holdId))!;
  expect(fact.balance-fact.reserved_cents).toBe(0);expect(fact.decisions).toBeLessThanOrEqual(1);
});

it('requires a dedicated permission and employee, rejects frozen or live guests, and hides money from technicians',async()=>{
  const h=await paid();await cancel(h);
  await expect(dispatch('commerce.retainAppointmentDeposit',{holdId:h.holdId,guestIndices:[0],amountCents:2000,expectedGuestBalances:[{guestIndex:0,availableCents:2000}],reason:'Unauthorized'},
    {...ctx,permissions:new Set(['commerce.read'])},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await expect(dispatch('commerce.retainAppointmentDeposit',{holdId:h.holdId,guestIndices:[0],amountCents:2000,expectedGuestBalances:[{guestIndex:0,availableCents:2000}],reason:'No employee'},
    {...ctx,membershipId:null},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await withTenant(tenant,tx=>tx`update commerce_appointment_holds set commerce_frozen=true where id=${h.holdId}`);
  await expect(retain(h)).rejects.toMatchObject({details:{reason:'deposit_not_retainable'}});
  const live=await paid();await expect(retain(live)).rejects.toMatchObject({details:{reason:'deposit_retention_no_eligible_balance'}});
  const detail=await withTenant(tenant,tx=>loadAppointmentDetail(tx,{...ctx,permissions:new Set(['appointment.read'])},live.appointmentId));
  expect(detail!.deposit).toBeUndefined();
});

it('protects decision and decline history with append-only grants, triggers and tenant isolation',async()=>{
  const h=await paid(true);await run('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:1176,reason:'Immutable late cancellation'});
  const r=await retain(h,1176);
  await expect(withTenant(tenant,tx=>tx`update commerce_deposit_retentions set amount_cents=1 where id=${r.retentionId}`)).rejects.toMatchObject({code:'42501'});
  await expect(withTenant(tenant,tx=>tx`delete from commerce_deposit_retentions where id=${r.retentionId}`)).rejects.toMatchObject({code:'42501'});
  await expect(withTenant(tenant,tx=>tx`update commerce_refunds set status='review',declined_at=null,declined_by=null,decline_reason=null,retention_id=null where payment_id=${h.paymentId}`)).rejects.toMatchObject({code:'23001'});
  const hidden=await withTenant({...tenant,locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'},tx=>tx`select id from commerce_deposit_retentions where id=${r.retentionId}`);
  expect(hidden).toHaveLength(0);
  const quote=await withTenant(tenant,tx=>loadDepositRetentionQuote(tx,ctx,h.holdId));expect(quote.guests).toHaveLength(0);
});

it('rejects stale reviewed balances and queues one explicit retention notice with the original terms',async()=>{
  const h=await paid(false,true,undefined,true);await cancel(h);
  const input={holdId:h.holdId,guestIndices:[0],amountCents:2000,expectedGuestBalances:[{guestIndex:0,availableCents:1900}],reason:'Reviewed retained notification QA'};
  await expect(run('commerce.retainAppointmentDeposit',input)).rejects.toMatchObject({details:{reason:'deposit_retention_quote_changed'}});
  input.expectedGuestBalances[0]!.availableCents=2000;
  const key=randomUUID(),r=await run<{retentionId:string}>('commerce.retainAppointmentDeposit',input,key);await run('commerce.retainAppointmentDeposit',input,key);
  const notices=await withTenant(tenant,tx=>tx`select kind,body_text from email_outbox where entity_type='appointment_deposit_retention' and entity_id=${r.retentionId}`);
  expect(notices).toHaveLength(1);expect(notices[0]!.kind).toBe('appointment_deposit_retained');
  expect(notices[0]!.body_text).toContain('已保留定金: US$20.00');expect(notices[0]!.body_text).toContain('48 小时');
  expect(notices[0]!.body_text).not.toContain('预约已确认');
});

it('releases a retained amount in two original-source refunds without rewriting its decision or claiming pending money returned',async()=>{
 const day=()=>withTenant(tenant,async tx=>{const result=await loadCommerceDay(tx,tenant.locationId,await resolveDate(tx,tenant.locationId));return result.currencies.find(c=>c.currency==='usd');});
 const beforeDay=await day();
 const h=await paid(false,true,undefined,true);await cancel(h);const original=await retain(h,800);
 const remainder=await run<{refundId:string}>('commerce.requestRefund',{paymentId:h.paymentId,amountCents:1200,reason:'Unretained portion returned'});
 await run('commerce.confirmOfflineRefund',{refundId:remainder.refundId,reference:'QA original remainder receipt'});
 const before=await withTenant(tenant,tx=>tx`select md5(row_to_json(r)::text) as hash from commerce_deposit_retentions r where id=${original.retentionId}`);
 const key=randomUUID(),input={retentionId:original.retentionId,expectedRemainingCents:800,amountCents:300,reason:'Manager revises the original retention decision'};
 const first=await run<{releaseId:string;refundId:string;status:string}>('commerce.releaseDepositRetention',input,key);
 expect(first.status).toBe('pending');expect(await balance(h.holdId)).toMatchObject({status:'refund_pending',balance:300,reserved_cents:300,decisions:1});
 expect(await run('commerce.releaseDepositRetention',input,key)).toEqual(first);
 await expect(run('commerce.releaseDepositRetention',{...input,amountCents:400},key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
 await expect(run('commerce.releaseDepositRetention',input)).rejects.toMatchObject({details:{reason:'deposit_retention_release_changed'}});
 let detail=await withTenant(tenant,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));
 expect(detail!.deposit!.retainedCents).toBe(500);expect(detail!.deposit!.retentions![0]!.releases[0]).toMatchObject({amountCents:300,refundStatus:'pending',refundId:first.refundId});
 await run('commerce.confirmOfflineRefund',{refundId:first.refundId,reference:'QA first released cash returned'});
 expect(await balance(h.holdId)).toMatchObject({status:'retained',balance:0,reserved_cents:0});
 const final=await run<{refundId:string}>('commerce.releaseDepositRetention',{...input,expectedRemainingCents:500,amountCents:500});
 await run('commerce.confirmOfflineRefund',{refundId:final.refundId,reference:'QA final released cash returned'});
 expect(await balance(h.holdId)).toMatchObject({status:'refunded',deposit_status:'refunded',balance:0,reserved_cents:0,decisions:1});
 detail=await withTenant(tenant,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail!.deposit!.retainedCents).toBe(0);
 expect(await withTenant(tenant,tx=>tx`select md5(row_to_json(r)::text) as hash from commerce_deposit_retentions r where id=${original.retentionId}`)).toEqual(before);
 const [counts]=await withTenant(tenant,tx=>tx`select (select sum(amount_cents)::int from commerce_refunds where payment_id=${h.paymentId} and status='succeeded') as refunded,
  (select count(*)::int from commerce_deposit_retention_releases where retention_id=${original.retentionId}) as releases,
  (select count(*)::int from email_outbox where entity_type='appointment_deposit_retention_release' and entity_id=${first.releaseId}) as notices`);
 expect(counts).toEqual({refunded:2000,releases:2,notices:1});
 const afterDay=await day();expect(afterDay!.depositRetainedCents).toBe(beforeDay?.depositRetainedCents??0);expect(afterDay!.offlineCashRefundedCents-(beforeDay?.offlineCashRefundedCents??0)).toBe(2000);
});

it('uses the exact released guest shares even when other guest balances have changed',async()=>{
 const h=await paid(true);await cancel(h);const original=await retain(h,1000,[0,1]);
 await run('commerce.requestRefund',{paymentId:h.paymentId,amountCents:500,depositGuestIndices:[0],reason:'Guest zero refund from unretained balance'});
 const release=await run<{releaseId:string;refundId:string}>('commerce.releaseDepositRetention',{retentionId:original.retentionId,expectedRemainingCents:1000,amountCents:500,reason:'Release proportional original retained shares'});
 const [facts]=await withTenant(tenant,tx=>tx`select r.guest_allocation,f.deposit_guest_allocation from commerce_deposit_retention_releases r join commerce_refunds f on f.retention_release_id=r.id where r.id=${release.releaseId}`);
 expect(facts!.guest_allocation).toEqual([{guestIndex:0,amountCents:294},{guestIndex:1,amountCents:206}]);expect(facts!.deposit_guest_allocation).toEqual(facts!.guest_allocation);
 const guests=await withTenant(tenant,tx=>depositGuestBalances(tx,ctx,h.holdId));expect(guests!.map(g=>g.availableCents)).toEqual([88,412]);
 expect(await balance(h.holdId)).toMatchObject({balance:1500,reserved_cents:1000});
});

it('serializes competing releases, requires both permissions, and enforces immutable complete database facts',async()=>{
 const h=await paid();await cancel(h);const original=await retain(h);
 const input={retentionId:original.retentionId,expectedRemainingCents:2000,amountCents:1200,reason:'Reviewed partial release'};
 for(const permissions of [new Set(['commerce.refund'] as const),new Set(['commerce.retainDeposit'] as const)])await expect(dispatch('commerce.releaseDepositRetention',input,{...ctx,permissions},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 const race=await Promise.allSettled([run<{releaseId:string}>('commerce.releaseDepositRetention',input),run<{releaseId:string}>('commerce.releaseDepositRetention',input)]);
 expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);const release=race.find(r=>r.status==='fulfilled')!;if(release.status!=='fulfilled')throw new Error('One release expected');
 await expect(withTenant(tenant,tx=>tx`update commerce_deposit_retention_releases set reason='Rewritten history' where id=${release.value.releaseId}`)).rejects.toMatchObject({code:'42501'});
 await expect(withTenant(tenant,tx=>tx`update commerce_refunds set retention_release_id=null where retention_release_id=${release.value.releaseId}`)).rejects.toMatchObject({code:'23001'});
 await expect(withTenant(tenant,tx=>tx`insert into commerce_deposit_retention_releases(org_id,location_id,retention_id,hold_id,payment_id,amount_cents,guest_allocation,reason,recorded_by)
  values(${tenant.orgId},${tenant.locationId},${original.retentionId},${h.holdId},${h.paymentId},100,'[{"guestIndex":0,"amountCents":100}]'::jsonb,'Missing linked refund',${ctx.membershipId!})`)).rejects.toMatchObject({code:'23001'});
 await expect(withTenant(tenant,tx=>tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,entry,amount_cents,reference,guest_allocation)
  values(${tenant.orgId},${tenant.locationId},${h.holdId},${h.paymentId},'retention_released',100,${`release:${randomUUID()}`},'[{"guestIndex":0,"amountCents":100}]'::jsonb)`)).rejects.toMatchObject({code:'23001'});
 expect(await withTenant({...tenant,locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'},tx=>tx`select id from commerce_deposit_retention_releases where id=${release.value.releaseId}`)).toHaveLength(0);
 expect(await balance(h.holdId)).toMatchObject({balance:1200,reserved_cents:1200,decisions:1});
});

it('keeps a failed refund released and recoverable without restoring the original retention or refunding twice',async()=>{
 const h=await paid();await cancel(h);const retained=await retain(h);
 const released=await run<{refundId:string}>('commerce.releaseDepositRetention',{retentionId:retained.retentionId,expectedRemainingCents:2000,amountCents:2000,reason:'Withdraw the entire retention'});
 await dispatchSystem('commerce.completeRefund',{refundId:released.refundId,stripeRefundId:null,status:'failed',stripeAccountId:null,livemode:false,amountCents:2000},ctx,{idempotencyKey:randomUUID()});
 expect(await balance(h.holdId)).toMatchObject({status:'review',balance:2000,reserved_cents:0,decisions:1});
 const detail=await withTenant(tenant,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail!.deposit!.retainedCents).toBe(0);expect(detail!.deposit!.retentions![0]!.releases[0]!.refundStatus).toBe('failed');
 const retry=await run<{refundId:string}>('commerce.requestRefund',{paymentId:h.paymentId,amountCents:2000,reason:'Return released funds after confirmed refund failure'});
 await run('commerce.confirmOfflineRefund',{refundId:retry.refundId,reference:'QA release failure recovery receipt'});
 expect(await balance(h.holdId)).toMatchObject({status:'refunded',balance:0,reserved_cents:0,decisions:1});
 const [totals]=await withTenant(tenant,tx=>tx`select (select count(*)::int from commerce_deposit_retention_releases where retention_id=${retained.retentionId}) as releases,
  (select sum(amount_cents)::int from commerce_refunds where payment_id=${h.paymentId} and status='succeeded') as returned`);
 expect(totals).toEqual({releases:1,returned:2000});
});
