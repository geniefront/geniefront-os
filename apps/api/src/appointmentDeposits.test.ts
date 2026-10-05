import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {withTenant,closeDb,jsonb,readOnlineBooking} from '@gf/db';
import {appointmentDepositPolicy} from './commerce/depositPolicy';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {runCommerceTask} from './commerce/worker';
import {commerceStripeClient} from './commerce/client';
import {metadataOf,expireCommerceCheckout} from './commerce/provider';
import {resolveHostedShop} from './public/publicAuth';
import {loadManagedBookingDetail} from './public/managedDetail';
import {loadAppointmentDetail} from './queries/appointmentDetail';
import {applyDepositToTicket} from './handlers/appointmentDepositPayments';
import {businessDateOf,wallMinuteToInstant} from '@gf/scheduling';
import './handlers/commerce';
import './handlers/appointmentDeposits';
import './handlers/setup';
import './handlers/billing';
import './handlers/ticket';
import './handlers/kiosk';
import './handlers/bundle';

const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>,serviceId:string,resourceId:string,staffId:string;
interface Hold{holdId:string;appointmentId:string;status:string;amountCents:number;serviceTotalCents:number;expiresAt:string;currency:string;}
const run=async<T=Hold>(name:string,input:unknown,key=randomUUID())=>(await dispatch<T>(name,input,ctx,{idempotencyKey:key})).result;
const expiry=async(h:Hold)=>(await dispatchSystem<{expired:boolean}>('commerce.expireAppointmentHold',{holdId:h.holdId},ctx,{idempotencyKey:randomUUID()})).result;
const future=(hours=40)=>new Date(Date.now()+hours*3600000).toISOString();
const input=(startsAt=future(),resource:string|null=null)=>({businessKey:randomUUID(),appointment:{customerId:null,
  walkInName:'Deposit isolated QA',source:'desk',override:{reason:'desk_coordination'},items:[{serviceId,startsAt,resourceId:resource}]}});
const hold=async(startsAt=future(),resource:string|null=null)=>run('commerce.holdAppointment',input(startsAt,resource));
const due=async(h:Hold)=>withTenant(tenant,async tx=>{
  await tx`update commerce_appointment_holds set expires_at=now()-interval '1 second' where id=${h.holdId}`;
  await tx`update commerce_tasks set retry_at=now()-interval '1 second' where kind='expire_deposit' and subject_id=${h.holdId}`;
});
beforeAll(async()=>{
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';
  process.env.STRIPE_SECRET_KEY='sk_test_deposit_fixture';process.env.COMMERCE_STRIPE_MODE='test';
  process.env.MANAGE_TOKEN_WRAP_KEY='deposit-test-key-at-least-thirty-two-characters';process.env.BOOKING_MANAGE_PAGE_ENABLED='1';
  await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_DepositFixture',livemode:false,chargesEnabled:true,payoutsEnabled:true,
    detailsSubmitted:true,capabilities:{card_payments:'active'}},{...tenant,userId:null,actorKind:'system',permissions:new Set(),locale:'en',timezone:'UTC'},
    {idempotencyKey:randomUUID()});
  const [owner]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m
    join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id
    where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
  ctx=await buildContext({userId:owner!.user_id,membershipId:owner!.id});
  await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  // These fixtures isolate resource capacity from the recurring-staff calendar, which has its own integration suite.
  await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb),'{online_booking}',
    ${jsonb({enabled:true,deposit_required:true,deposit_amount_cents:2000,min_minutes_ahead:0,cancel_cutoff_hours:4,
      cancellation_policy_notice:'QA refundable before cutoff'})}::jsonb) where id=${tenant.locationId}`);
  serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Deposit QA service'},durationMin:30,basePriceCents:10000})).serviceId;
  const [staff]=await withTenant(tenant,tx=>tx`select membership_id as id from staff_profiles where location_id=${tenant.locationId} and is_bookable limit 1`);
  staffId=staff!.id;
  const [r]=await withTenant(tenant,async tx=>{
    const [type]=await tx`insert into resource_types(org_id,location_id,key,name)
      values(${tenant.orgId},${tenant.locationId},'deposit-qa',${jsonb({en:'Deposit QA room'})}::jsonb) returning id`;
    return tx`insert into resources(org_id,location_id,resource_type_id,name,capacity)
      values(${tenant.orgId},${tenant.locationId},${type!.id},'Deposit QA one seat',1) returning id`;
  });resourceId=r!.id;
});
afterAll(closeDb);

it('creates one real provisional appointment with a 15-minute database deadline and a locked service quote',async()=>{
  const start=Date.now(),payload=input(),h=await run('commerce.holdAppointment',payload);
  expect(h).toMatchObject({status:'pending',amountCents:2000,serviceTotalCents:10000,currency:'usd'});
  expect(Date.parse(h.expiresAt)-start).toBeGreaterThan(14*60000);expect(Date.parse(h.expiresAt)-start).toBeLessThan(16*60000);
  const replay=await run('commerce.holdAppointment',payload);expect(replay).toEqual(h);
  const [fact]=await withTenant(tenant,tx=>tx`select a.deposit_status,a.status,
    (select count(*)::int from appointment_items where appointment_id=a.id and status='booked') as items,
    (select count(*)::int from commerce_tasks where kind='expire_deposit' and subject_id=${h.holdId}) as tasks,
    (select count(*)::int from commerce_payments) as payments,h.policy_snapshot
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(fact).toMatchObject({deposit_status:'pending',status:'booked',items:1,tasks:1,payments:0,
    policy_snapshot:{fixedAmountCents:2000,cancelCutoffHours:4,retainAfterCutoff:false}});
  await expect(run('commerce.holdAppointment',{...payload,appointment:{...payload.appointment,notes:'Changed financial request'}}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_key_reused'}});
  expect(await expiry(h)).toEqual({expired:false});
});
it('allows at most one same-slot hold and releases the real capacity for a subsequent booking',async()=>{
  const startsAt=future(44),results=await Promise.allSettled([hold(startsAt,resourceId),hold(startsAt,resourceId)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({code:'RESOURCE_CONFLICT'});
  const h=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Hold>).value;
  await due(h);expect(await expiry(h)).toEqual({expired:true});expect(await expiry(h)).toEqual({expired:false});
  const [fact]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as hold_status,
    (select count(*)::int from appointment_items where appointment_id=a.id and status='booked') as active_items
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(fact).toEqual({status:'cancelled',deposit_status:'expired',hold_status:'expired',active_items:0});
  const replacement=await hold(startsAt,resourceId);expect(replacement.status).toBe('pending');
});
it('stores exactly one amount policy and applies cent-precise service percentages without changing earlier purchases',async()=>{
  await run('catalog.saveService',{serviceId,name:{en:'Deposit QA service'},durationMin:30,basePriceCents:10003});
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000});
  const h=await hold(future(70));expect(h).toMatchObject({amountCents:2001,serviceTotalCents:10003});
  const [rule]=await withTenant(tenant,tx=>tx`select deposit_method,deposit_percent_bps,deposit_amount_cents from location_scheduling_rules where location_id=${tenant.locationId}`);
  expect(rule).toEqual({deposit_method:'percentage',deposit_percent_bps:2000,deposit_amount_cents:0});
  await expect(withTenant(tenant,tx=>tx`update location_scheduling_rules set deposit_percent_bps=null where location_id=${tenant.locationId}`))
    .rejects.toMatchObject({code:'23514'});
  await expect(run('location.saveOnlineBooking',{enabled:true,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000,depositAmountCents:2000}))
    .rejects.toMatchObject({details:{reason:'invalid_deposit_policy'}});
  await expect(run('location.saveOnlineBooking',{enabled:true,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,depositPercentBps:2000}))
    .rejects.toMatchObject({details:{reason:'invalid_deposit_policy'}});
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000});
  await run('catalog.saveService',{serviceId,name:{en:'Deposit QA service'},durationMin:30,basePriceCents:10000});
  const [stored]=await withTenant(tenant,tx=>tx`select amount_cents,service_total_cents,policy_snapshot from commerce_appointment_holds where id=${h.holdId}`);
  expect(stored).toMatchObject({amount_cents:2001,service_total_cents:10003,policy_snapshot:{method:'percentage',percentBps:2000,fixedAmountCents:null}});
  await expect(withTenant(tenant,tx=>tx`update commerce_appointment_holds set amount_cents=2002 where id=${h.holdId}`)).rejects.toMatchObject({code:'23001'});
  await expect(withTenant(tenant,tx=>tx`update commerce_appointment_holds set policy_snapshot=jsonb_set(policy_snapshot,'{cancelCutoffHours}','72'::jsonb) where id=${h.holdId}`))
    .rejects.toMatchObject({code:'23001'});
});
it('requires and preserves a versioned customer acknowledgement for retention policies',async()=>{
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,
    retainDepositAfterCutoff:true,cancellationPolicyNotice:'QA retain only after frontdesk review'});
  const body=input(future(73));
  await expect(run('commerce.holdAppointment',body)).rejects.toMatchObject({details:{reason:'deposit_policy_consent_required'}});
  const [loc]=await withTenant(tenant,tx=>tx`select settings from locations where id=${tenant.locationId}`);
  const policy=appointmentDepositPolicy(readOnlineBooking(loc!.settings));
  const h=await run('commerce.holdAppointment',{...body,depositConsent:{accepted:true,policyVersion:policy.version,serviceTotalCents:10000,amountCents:2000}});
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,
    retainDepositAfterCutoff:false,cancellationPolicyNotice:'QA refundable before cutoff'});
  const [stored]=await withTenant(tenant,tx=>tx`select policy_snapshot from commerce_appointment_holds where id=${h.holdId}`);
  expect(stored!.policy_snapshot).toMatchObject({version:policy.version,retainAfterCutoff:true,cancellationPolicyNotice:'QA retain only after frontdesk review',
    consent:{accepted:true,method:'staff_confirmation'}});
  expect(Date.parse(stored!.policy_snapshot.consent.at)).toBeLessThanOrEqual(Date.now());
});
it('persists deterministic per-guest service and deposit shares from the real booking items',async()=>{
  const other=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Second guest deposit QA'},durationMin:30,basePriceCents:7000})).serviceId;
  const payload=input(future(76));
  const h=await run('commerce.holdAppointment',{...payload,appointment:{...payload.appointment,partySize:2,items:[
    {...payload.appointment.items[0],details:{publicGuestIndex:0}},
    {...payload.appointment.items[0],serviceId:other,details:{publicGuestIndex:1}},
  ]}});
  expect(h).toMatchObject({amountCents:2000,serviceTotalCents:17000});
  const [stored]=await withTenant(tenant,tx=>tx`select policy_snapshot from commerce_appointment_holds where id=${h.holdId}`);
  expect(stored!.policy_snapshot.guestAllocation).toEqual({method:'service_price',guests:[
    {guestIndex:0,serviceTotalCents:10000,amountCents:1176},{guestIndex:1,serviceTotalCents:7000,amountCents:824}]});
});
it('serializes different command keys with one permanent booking business key',async()=>{
  const payload=input(future(48));const [a,b]=await Promise.all([run('commerce.holdAppointment',payload),run('commerce.holdAppointment',payload)]);
  expect(a.holdId).toBe(b.holdId);expect(a.appointmentId).toBe(b.appointmentId);
  const [n]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_appointment_holds where business_key=${payload.businessKey}`);expect(n!.n).toBe(1);
});
it('records one offline receipt and immutable cash liability without using any Stripe credential',async()=>{
  const h=await hold(future(49)),receipt={holdId:h.holdId,amountCents:2000,method:'cash',reference:'Deposit QA receipt'};
  const [a,b]=await Promise.all([run<{orderId:string;paymentId:string;assetId:string;status:string}>('commerce.recordOfflineDeposit',receipt),
    run<{orderId:string;paymentId:string;assetId:string;status:string}>('commerce.recordOfflineDeposit',receipt)]);
  expect(a).toEqual(b);expect(a).toMatchObject({status:'fulfilled',assetId:h.holdId});
  await expect(run('commerce.recordOfflineDeposit',{...receipt,reference:'Changed receipt'}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_receipt_changed'}});
  const [fact]=await withTenant(tenant,tx=>tx`select a.deposit_status,h.status,p.provider,p.method,p.amount_cents,p.external_reference,p.livemode,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as ledger_rows,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as available
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id join commerce_payments p on p.order_id=h.order_id where h.id=${h.holdId}`);
  expect(fact).toEqual({deposit_status:'paid',status:'paid',provider:'offline',method:'cash',amount_cents:2000,
    external_reference:'Deposit QA receipt',livemode:false,ledger_rows:1,available:2000});
  await due(h);expect(await expiry(h)).toEqual({expired:false});
  await expect(withTenant(tenant,tx=>tx`update commerce_deposit_ledger set amount_cents=3000 where hold_id=${h.holdId}`)).rejects.toMatchObject({code:'42501'});
});
it('rejects expired or mismatched offline payment receipts without creating a paid fact',async()=>{
  const h=await hold(future(50));
  await expect(run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:1999,method:'card',reference:'Wrong amount'}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_amount_mismatch'}});
  await due(h);
  await expect(run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'card',reference:'Late offline receipt'}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_hold_not_payable'}});
  const [fact]=await withTenant(tenant,tx=>tx`select order_id from commerce_appointment_holds where id=${h.holdId}`);expect(fact!.order_id).toBeNull();
});
it('cancels before the saved cutoff with one reserved offline refund and leaves cash unchanged until actually returned',async()=>{
  const h=await hold(future(53)),receipt=await run<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Cancellation QA receipt'});
  // Editing store policy must not rewrite an already purchased contract.
  await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(settings,'{online_booking,cancel_cutoff_hours}','72'::jsonb) where id=${tenant.locationId}`);
  const key=randomUUID(),body={appointmentId:h.appointmentId,reason:'guest_changed_mind',keepStaffTurn:false};
  await run('appointment.cancel',body,key);await run('appointment.cancel',body,key);
  const [fact]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.reserved_cents,
    (select count(*)::int from commerce_refunds where payment_id=${receipt.paymentId}) as refunds,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as cash_liability
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(fact).toEqual({status:'cancelled',deposit_status:'refund_pending',reserved_cents:2000,refunds:1,cash_liability:2000});
  const [r]=await withTenant(tenant,tx=>tx`select id from commerce_refunds where payment_id=${receipt.paymentId}`);
  await run('commerce.confirmOfflineRefund',{refundId:r!.id,reference:'Cancellation cash returned QA'});
  const [balance]=await withTenant(tenant,tx=>tx`select sum(amount_cents)::int as n from commerce_deposit_ledger where hold_id=${h.holdId}`);expect(balance!.n).toBe(0);
  await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(settings,'{online_booking,cancel_cutoff_hours}','4'::jsonb) where id=${tenant.locationId}`);
});
it('leaves late cancellations and no-shows for frontdesk review without automatically forfeiting or refunding money',async()=>{
  for(const reason of ['guest_changed_mind','no_show']){
    const h=await hold(future(reason==='no_show'?60:2));
    const receipt=await run<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:`Review QA ${reason}`});
    await run('appointment.cancel',{appointmentId:h.appointmentId,reason,keepStaffTurn:false});
    const [fact]=await withTenant(tenant,tx=>tx`select h.status,h.reserved_cents,a.deposit_status,
      (select count(*)::int from commerce_refunds where payment_id=${receipt.paymentId}) as refunds,
      (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as cash_liability
      from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
    expect(fact).toEqual({status:'review',reserved_cents:0,deposit_status:'review',refunds:0,cash_liability:2000});
    await run('commerce.requestRefund',{paymentId:receipt.paymentId,amountCents:2000,reason:'Manager approves unused deposit refund'});
  }
});
it('keeps a failed cancellation refund visible for review and allows an authorized replacement refund',async()=>{
  const h=await hold(future(61)),paid=await run<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Failed cancellation refund QA'});
  await run('appointment.cancel',{appointmentId:h.appointmentId,reason:'guest_changed_mind',keepStaffTurn:false});
  const [r]=await withTenant(tenant,tx=>tx`select id from commerce_refunds where payment_id=${paid.paymentId}`);
  await dispatchSystem('commerce.completeRefund',{refundId:r!.id,stripeRefundId:null,status:'failed',stripeAccountId:null,livemode:false,amountCents:2000},ctx,{idempotencyKey:randomUUID()});
  const [facts]=await withTenant(tenant,tx=>tx`select h.status,h.reserved_cents,a.deposit_status,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as liability
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
  expect(facts).toEqual({status:'review',reserved_cents:0,deposit_status:'review',liability:2000});
  await run('commerce.requestRefund',{paymentId:paid.paymentId,amountCents:2000,reason:'Manager retries failed cancellation refund'});
});
it('reserves unused deposit cash across concurrent refunds and appends each confirmed refund once',async()=>{
  const h=await hold(future(51));
  const paid=await run<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'external',reference:'External deposit receipt'});
  const request={paymentId:paid.paymentId,amountCents:1200,reason:'Unused deposit QA refund'},key=randomUUID();
  const refund=await run<{refundId:string}>('commerce.requestRefund',request,key);await run('commerce.requestRefund',request,key);
  await expect(run('commerce.requestRefund',{...request,amountCents:1000})).rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'refund_exceeds_payment'}});
  await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:'Deposit refund external receipt'});
  await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:'Deposit refund external receipt'});
  const [fact]=await withTenant(tenant,tx=>tx`select h.reserved_cents,h.status,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as available,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='refund') as refunds
    from commerce_appointment_holds h where h.id=${h.holdId}`);expect(fact).toEqual({reserved_cents:0,status:'paid',available:800,refunds:1});
  const rest=await run<{refundId:string}>('commerce.requestRefund',{...request,amountCents:800});
  await run('commerce.confirmOfflineRefund',{refundId:rest.refundId,reference:'Remaining deposit refund receipt'});
  const [final]=await withTenant(tenant,tx=>tx`select a.deposit_status,h.status,(select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as available
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
  expect(final).toEqual({deposit_status:'refunded',status:'refunded',available:0});
});
it('defers the actual guest confirmation outbox until offline payment fulfillment and keeps it unique',async()=>{
  const guestCtx={...ctx,userId:null,membershipId:null,actorKind:'api' as const};
  // A controlled booking window isolates confirmation timing from the hours/calendar tests.
  const hours=Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'00:00',close:'23:59'}]));
  await withTenant(tenant,tx=>tx`update locations set business_hours=${jsonb(hours)}::jsonb where id=${tenant.locationId}`);
  const calendarDate=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
  const payload=input(wallMinuteToInstant(calendarDate,ctx.timezone,14*60).toISOString());
  const h=(await dispatch<Hold>('commerce.holdAppointment',{...payload,appointment:{...payload.appointment,source:'web',
    guest:{manageToken:`mt_${randomUUID()}`,bookingSmsConsent:false,customer:{name:'Deposit email QA',email:'deposit-qa@example.test',phoneE164:'+12025550996'}}}},
    guestCtx,{idempotencyKey:randomUUID()})).result;
  const notices=()=>withTenant(tenant,tx=>tx`select id from email_outbox where entity_id=${h.appointmentId} and kind='appointment_confirm' and to_email='deposit-qa@example.test'`);
  expect(await notices()).toHaveLength(0);
  const receipt={holdId:h.holdId,amountCents:2000,method:'card',reference:'Guest deposit QA external terminal receipt'};
  await run('commerce.recordOfflineDeposit',receipt);await run('commerce.recordOfflineDeposit',receipt);
  expect(await notices()).toHaveLength(1);
});
it('blocks service and check-in before creating any ticket or queue side effect',async()=>{
  const h=await hold(future(0.1));
  for(const [name,payload] of [['ticket.open',{customerId:null,appointmentId:h.appointmentId,items:[{serviceId,membershipId:staffId}]}],
    ['queue.join',{appointmentId:h.appointmentId,source:'desk'}]] as const){
    await expect(run(name,payload)).rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_payment_required'}});
  }
  await expect(withTenant(tenant,tx=>tx`update appointments set status='in_service' where id=${h.appointmentId}`))
    .rejects.toMatchObject({code:'23001',hint:'DEPOSIT_PAYMENT_REQUIRED'});
  const [fact]=await withTenant(tenant,tx=>tx`select (select count(*)::int from tickets where appointment_id=${h.appointmentId}) as tickets,
    (select count(*)::int from walkin_queue where appointment_id=${h.appointmentId}) as queue`);expect(fact).toEqual({tickets:0,queue:0});
});
it('records manual cancellation separately and does not revive it during expiry',async()=>{
  const h=await hold(future(52));await run('appointment.cancel',{appointmentId:h.appointmentId,reason:'guest_changed_mind',keepStaffTurn:false});
  await due(h);expect(await expiry(h)).toEqual({expired:false});
  const [fact]=await withTenant(tenant,tx=>tx`select a.deposit_status,h.status from appointments a join commerce_appointment_holds h
    on h.appointment_id=a.id where a.id=${h.appointmentId}`);expect(fact).toEqual({deposit_status:'cancelled',status:'cancelled'});
});
it('expires all bundle components while retaining their original price and instance history',async()=>{
  const other=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Deposit QA second'},durationMin:30,basePriceCents:5000})).serviceId;
  const bundle=(await run<{bundleId:string}>('bundle.saveTemplate',{name:{en:'Deposit QA bundle'},priceCents:12000,
    components:[{serviceId,qty:1,seq:0},{serviceId:other,qty:1,seq:1}]})).bundleId;
  const h=await run('commerce.holdAppointment',{businessKey:randomUUID(),appointment:{customerId:null,source:'desk',override:{reason:'desk_coordination'},
    bundleSelections:[{bundleId:bundle,startsAt:future(56),extraDiscountCents:1000}]}});
  expect(h.serviceTotalCents).toBe(11000);await due(h);await expiry(h);
  const items=await withTenant(tenant,tx=>tx`select status,price_cents_snapshot from appointment_items where appointment_id=${h.appointmentId}`);
  expect(items).toHaveLength(2);expect(items.every(i=>i.status==='cancelled')).toBe(true);
  expect(items.reduce((n,i)=>n+i.price_cents_snapshot,0)).toBe(11000);
  const [instance]=await withTenant(tenant,tx=>tx`select status,bundle_price_cents from order_bundle_instances where appointment_id=${h.appointmentId}`);
  expect(instance).toEqual({status:'cancelled',bundle_price_cents:12000});
});
it('keeps expiry operational with new sales disabled, a frozen SaaS plan, and no Stripe key; concurrent workers finish once',async()=>{
  const payload=input(future(60)),h=await run('commerce.holdAppointment',payload);await due(h);
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:false,membershipsEnabled:false});
  await dispatchSystem('billing.syncSubscription',{plan:'voice_booking',subscriptionStatus:'past_due'},ctx);
  const [task]=await withTenant(tenant,tx=>tx`select id from commerce_tasks where kind='expire_deposit' and subject_id=${h.holdId}`);
  const enabled=process.env.GF_CUSTOMER_COMMERCE_ENABLED,secret=process.env.STRIPE_SECRET_KEY,commerceSecret=process.env.COMMERCE_STRIPE_SECRET_KEY;
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='0';delete process.env.STRIPE_SECRET_KEY;delete process.env.COMMERCE_STRIPE_SECRET_KEY;
  try{
    const results=await Promise.all([runCommerceTask(ctx,task!.id),runCommerceTask(ctx,task!.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [fact]=await withTenant(tenant,tx=>tx`select h.status,t.status as task_status from commerce_appointment_holds h
      join commerce_tasks t on t.subject_id=h.id and t.kind='expire_deposit' where h.id=${h.holdId}`);
    expect(fact).toEqual({status:'expired',task_status:'done'});
  }finally{
    for(const [key,value] of [['GF_CUSTOMER_COMMERCE_ENABLED',enabled],['STRIPE_SECRET_KEY',secret],['COMMERCE_STRIPE_SECRET_KEY',commerceSecret]]){
      if(value===undefined)delete process.env[key!];else process.env[key!]=value;
    }
    await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
    await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb) where id=${tenant.locationId}`);
    await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  }
});
it('enforces tenant scope, expiry system-only access, and overbook field permissions',async()=>{
  const h=await hold(future(64));
  await expect(run('commerce.expireAppointmentHold',{holdId:h.holdId})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  const foreign={...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'};
  expect(await withTenant(foreign,tx=>tx`select id from commerce_appointment_holds where id=${h.holdId}`)).toHaveLength(0);
  await expect(dispatchSystem('commerce.expireAppointmentHold',{holdId:h.holdId},foreign,{idempotencyKey:randomUUID()}))
    .rejects.toMatchObject({code:'NOT_FOUND'});
  const withoutOverride={...ctx,permissions:new Set(['appointment.write'] as const)};
  await expect(dispatch('commerce.holdAppointment',input(future(68)),withoutOverride,{idempotencyKey:randomUUID()}))
    .rejects.toMatchObject({code:'PERMISSION_DENIED',details:{need:'appointment.overbook'}});
});

interface OnlineOrder{orderId:string;paymentId:string;assetId:string|null;status:string;}
async function onlineHold(hours:number,startsAt=future(hours)){
  const base=input(startsAt,resourceId);
  const payload={...base,appointment:{...base.appointment,items:base.appointment.items.map(i=>({...i,membershipId:staffId}))}};
  const h=await run('commerce.holdAppointment',payload);
  const order=await run<OnlineOrder>('commerce.startDepositCheckout',{holdId:h.holdId});return {h,order,payload};
}
const pay=async(order:OnlineOrder)=> (await dispatchSystem<OnlineOrder>('commerce.recordPayment',{orderId:order.orderId,
  stripeAccountId:'acct_DepositFixture',livemode:false,eventId:`evt_${randomUUID()}`,eventType:'checkout.session.completed',
  sessionId:`cs_${order.orderId}`,paymentIntentId:`pi_${order.orderId}`,amountCents:2000,currency:'usd'},ctx,{idempotencyKey:randomUUID()})).result;
it('waives only an unpaid live hold with explicit permission, reason, an immutable actor record and no cash fact',async()=>{
  const h=await hold(future(101)),body={holdId:h.holdId,reason:'Manager approves QA deposit waiver'};
  await expect(dispatch('commerce.waiveAppointmentDeposit',body,ctx)).rejects.toMatchObject({code:'VALIDATION_FAILED',messageKey:'error.IDEMPOTENCY_KEY_REQUIRED'});
  await expect(run('commerce.waiveAppointmentDeposit',{...body,reason:' '})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(dispatch('commerce.waiveAppointmentDeposit',body,{...ctx,permissions:new Set(['appointment.write'])},{idempotencyKey:randomUUID()}))
    .rejects.toMatchObject({code:'PERMISSION_DENIED',details:{need:'commerce.waiveDeposit'}});
  const foreign={...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'};
  await expect(dispatch('commerce.waiveAppointmentDeposit',body,foreign,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await run('commerce.waiveAppointmentDeposit',body)).toEqual({holdId:h.holdId,appointmentId:h.appointmentId,status:'waived'});
  await run('commerce.waiveAppointmentDeposit',body);
  await expect(run('commerce.waiveAppointmentDeposit',{...body,reason:'Overwrite original reason'})).rejects.toMatchObject({details:{reason:'deposit_waiver_changed'}});
  const [facts]=await withTenant(tenant,tx=>tx`select h.status,h.waived_by,h.waiver_reason,h.waived_at is not null as timestamp_recorded,h.order_id,
    a.status as appointment_status,a.deposit_status,(select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as money_rows,
    (select count(*)::int from appointment_items where appointment_id=a.id and status='booked') as active_items
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
  expect(facts).toEqual({status:'waived',waived_by:ctx.membershipId,waiver_reason:body.reason,timestamp_recorded:true,order_id:null,
    appointment_status:'booked',deposit_status:'waived',money_rows:0,active_items:1});
  await expect(withTenant(tenant,tx=>tx`update commerce_appointment_holds set waiver_reason='Changed SQL reason' where id=${h.holdId}`)).rejects.toMatchObject({code:'23001'});
  await due(h);expect(await expiry(h)).toEqual({expired:false});
  const detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));
  expect(detail.deposit).toMatchObject({status:'waived',waivable:false,availableCents:0,waiverReason:body.reason});
  const tech={...ctx,permissions:new Set(['appointment.read'] as const)};
  expect((await withTenant(tech,tx=>loadAppointmentDetail(tx,tech,h.appointmentId))).deposit).toBeUndefined();
});
it('rejects waivers of expired or already paid deposits without altering their money',async()=>{
  const expired=await hold(future(102));await due(expired);
  await expect(run('commerce.waiveAppointmentDeposit',{holdId:expired.holdId,reason:'Too late'})).rejects.toMatchObject({details:{reason:'deposit_hold_not_waivable'}});
  const {h,order}=await onlineHold(103);await pay(order);
  await expect(run('commerce.waiveAppointmentDeposit',{holdId:h.holdId,reason:'Cannot waive collected money'})).rejects.toMatchObject({details:{reason:'deposit_hold_not_waivable'}});
  const [fact]=await withTenant(tenant,tx=>tx`select h.status,h.waived_at,(select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as balance
    from commerce_appointment_holds h where h.id=${h.holdId}`);
  expect(fact).toEqual({status:'paid',waived_at:null,balance:2000});
});
it('refunds an in-flight online payment after a waiver exactly once while preserving the confirmed appointment and full service price',async()=>{
  const {h,order}=await onlineHold(104),body={holdId:h.holdId,reason:'Approved before payment completion'};
  await run('commerce.waiveAppointmentDeposit',body);
  const [cancelled]=await withTenant(tenant,tx=>tx`select o.status,p.status as payment_status,
    (select count(*)::int from commerce_tasks where kind='expire_checkout' and subject_id=o.id) as expiry_tasks
    from commerce_orders o join commerce_payments p on p.order_id=o.id where o.id=${order.orderId}`);
  expect(cancelled).toEqual({status:'canceled',payment_status:'failed',expiry_tasks:1});
  expect(await pay(order)).toMatchObject({status:'refund_pending',assetId:h.holdId});await pay(order);await run('commerce.waiveAppointmentDeposit',body);
  const [facts]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as hold_status,h.reserved_cents,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as collections,
    (select count(*)::int from commerce_refunds where payment_id=${order.paymentId}) as refunds,
    (select sum(price_cents_snapshot)::int from appointment_items where appointment_id=a.id and status='booked') as service_price
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(facts).toEqual({status:'booked',deposit_status:'waived',hold_status:'refund_pending',reserved_cents:2000,collections:1,refunds:1,service_price:10000});
  const [refund]=await withTenant(tenant,tx=>tx`select id from commerce_refunds where payment_id=${order.paymentId}`);
  const completion={refundId:refund!.id,stripeRefundId:`re_${refund!.id}`,status:'succeeded',stripeAccountId:'acct_DepositFixture',livemode:false,amountCents:2000};
  await dispatchSystem('commerce.completeRefund',completion,ctx,{idempotencyKey:randomUUID()});
  await dispatchSystem('commerce.completeRefund',completion,ctx,{idempotencyKey:randomUUID()});
  const [final]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as hold_status,h.reserved_cents,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as balance,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='refund') as refund_rows
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(final).toEqual({status:'booked',deposit_status:'waived',hold_status:'refunded',reserved_cents:0,balance:0,refund_rows:1});
  const shop=await resolveHostedShop('golden-foot');
  const summary=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop!,h.appointmentId,'en'));
  expect(summary).toMatchObject({status:'booked',deposit:{status:'waived',financialStatus:'refunded',availableCents:0,checkoutUrl:null,serviceRemainingCents:10000}});
});
it('keeps a failed post-waiver refund reviewable without blocking the waived booking and retries the original money once',async()=>{
  const {h,order}=await onlineHold(105);await run('commerce.waiveAppointmentDeposit',{holdId:h.holdId,reason:'Waiver failure-injection QA'});await pay(order);
  const [r]=await withTenant(tenant,tx=>tx`select id from commerce_refunds where payment_id=${order.paymentId}`);
  await dispatchSystem('commerce.completeRefund',{refundId:r!.id,stripeRefundId:null,status:'failed',stripeAccountId:'acct_DepositFixture',livemode:false,amountCents:2000},ctx,{idempotencyKey:randomUUID()});
  const [fact]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as hold_status,h.reserved_cents,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as balance
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(fact).toEqual({status:'booked',deposit_status:'waived',hold_status:'review',reserved_cents:0,balance:2000});
  const retry=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:1000,reason:'Retry part of failed post-waiver refund'});
  await dispatchSystem('commerce.completeRefund',{refundId:retry.refundId,stripeRefundId:`re_${retry.refundId}`,status:'succeeded',stripeAccountId:'acct_DepositFixture',livemode:false,amountCents:1000},ctx,{idempotencyKey:randomUUID()});
  const [partial]=await withTenant(tenant,tx=>tx`select status from commerce_appointment_holds where id=${h.holdId}`);expect(partial!.status).toBe('review');
  await expect(withTenant(ctx,tx=>applyDepositToTicket(tx,ctx,{holdId:h.holdId,amountCents:1000},{id:randomUUID(),appointmentId:h.appointmentId},10000,'combined')))
    .rejects.toMatchObject({details:{reason:'deposit_not_available_for_ticket'}});
  const remaining=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:1000,reason:'Return remaining post-waiver money'});
  await dispatchSystem('commerce.completeRefund',{refundId:remaining.refundId,stripeRefundId:`re_${remaining.refundId}`,status:'succeeded',stripeAccountId:'acct_DepositFixture',livemode:false,amountCents:1000},ctx,{idempotencyKey:randomUUID()});
  const [final]=await withTenant(tenant,tx=>tx`select deposit_status from appointments where id=${h.appointmentId}`);expect(final!.deposit_status).toBe('waived');
});
it('serializes payment versus waiver with one collected fact and never cancels the booking',async()=>{
  const {h,order}=await onlineHold(106);
  const results=await Promise.allSettled([run('commerce.waiveAppointmentDeposit',{holdId:h.holdId,reason:'Concurrent approval QA'}),pay(order)]);
  expect(results[1]!.status).toBe('fulfilled');
  const [fact]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.waived_at is not null as waived,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collections,
    (select count(*)::int from commerce_refunds where payment_id=${order.paymentId}) as refunds
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(fact!.status).toBe('booked');expect(fact!.collections).toBe(1);
  expect(fact!.refunds).toBe(fact!.waived?1:0);expect(fact!.deposit_status).toBe(fact!.waived?'waived':'paid');
});
it('confirms a public booking on reasoned waiver once without a paid ledger or a second payment confirmation',async()=>{
  const calendarDate=new Date(Date.now()+6*86400000).toISOString().slice(0,10),base=input(wallMinuteToInstant(calendarDate,ctx.timezone,14*60).toISOString());
  const h=await run('commerce.holdAppointment',{...base,appointment:{...base.appointment,source:'web',guest:{manageToken:`mt_${randomUUID()}`,bookingSmsConsent:false,
    customer:{name:'Waiver outbox QA',email:'waiver-qa@example.test',phoneE164:'+12025550995'}}}});
  const notices=()=>withTenant(tenant,tx=>tx`select id from email_outbox where entity_id=${h.appointmentId} and kind='appointment_confirm' and to_email='waiver-qa@example.test'`);
  expect(await notices()).toHaveLength(0);
  const body={holdId:h.holdId,reason:'Manager confirms public booking without upfront payment'};
  await run('commerce.waiveAppointmentDeposit',body);await run('commerce.waiveAppointmentDeposit',body);
  expect(await notices()).toHaveLength(1);
  expect(await withTenant(tenant,tx=>tx`select id from commerce_deposit_ledger where hold_id=${h.holdId}`)).toHaveLength(0);
});
it('locks one online payment to the original hold and confirms only the verified paid fact',async()=>{
  const {h,order}=await onlineHold(80);
  expect(order.status).toBe('pending');expect(order.assetId).toBeNull();
  expect(await run('commerce.startDepositCheckout',{holdId:h.holdId})).toEqual(order);
  await expect(run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Cannot double collect'}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const confirmed=await pay(order);expect(confirmed).toMatchObject({status:'fulfilled',assetId:h.holdId});await pay(order);
  const [fact]=await withTenant(tenant,tx=>tx`select h.status,(select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as rows
    from commerce_appointment_holds h where h.id=${h.holdId}`);expect(fact).toEqual({status:'paid',rows:1});
});
it('reacquires a released slot with the same appointment and unchanged price after late payment',async()=>{
  // Stay outside the seed's 14-day booking horizon; the success case must not rely on a soft overbook override.
  const date=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
  const {h,order}=await onlineHold(84,wallMinuteToInstant(date,ctx.timezone,14*60).toISOString());
  const before=await withTenant(tenant,tx=>tx`select id,price_cents_snapshot from appointment_items where appointment_id=${h.appointmentId}`);
  await due(h);await expiry(h);
  const confirmed=await pay(order);expect(confirmed.status).toBe('fulfilled');
  const after=await withTenant(tenant,tx=>tx`select id,price_cents_snapshot from appointment_items where appointment_id=${h.appointmentId} and status='booked'`);
  expect(after).toEqual(before);
  const [appt]=await withTenant(tenant,tx=>tx`select status,deposit_status from appointments where id=${h.appointmentId}`);
  expect(appt).toEqual({status:'booked',deposit_status:'paid'});
});
it('keeps late collected money but queues a full refund when another booking owns the released capacity',async()=>{
  const startsAt=future(88),{h,order}=await onlineHold(88,startsAt);await due(h);await expiry(h);
  const competing=await hold(startsAt,resourceId);
  const paid=await pay(order);expect(paid.status).toBe('refund_pending');await pay(order);
  const [fact]=await withTenant(tenant,tx=>tx`select h.status,h.reserved_cents,a.status as appointment_status,
    (select count(*)::int from commerce_refunds where payment_id=${order.paymentId}) as refunds,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as collected
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
  expect(fact).toEqual({status:'refund_pending',reserved_cents:2000,appointment_status:'cancelled',refunds:1,collected:2000});
  const [r]=await withTenant(tenant,tx=>tx`select id from commerce_refunds where payment_id=${order.paymentId}`);
  const result={refundId:r!.id,stripeRefundId:`re_${randomUUID()}`,status:'succeeded',stripeAccountId:'acct_DepositFixture',livemode:false,amountCents:2000};
  await dispatchSystem('commerce.completeRefund',result,ctx,{idempotencyKey:randomUUID()});
  await dispatchSystem('commerce.completeRefund',result,ctx,{idempotencyKey:randomUUID()});
  const [balance]=await withTenant(tenant,tx=>tx`select sum(amount_cents)::int as n from commerce_deposit_ledger where hold_id=${h.holdId}`);expect(balance!.n).toBe(0);
  const [other]=await withTenant(tenant,tx=>tx`select status from appointments where id=${competing.appointmentId}`);expect(other!.status).toBe('booked');
});
it('expires the actual mapped Session when a hold times out and recovers a lost Session id by tenant metadata',async()=>{
  const {h,order}=await onlineHold(92);await due(h);await expiry(h);
  const session={id:`cs_${order.orderId}`,livemode:false,client_reference_id:order.orderId,metadata:metadataOf(ctx,order.orderId),
    amount_total:2000,currency:'usd',status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/qa',expires_at:Math.floor(Date.now()/1000)+3600};
  const stripe=commerceStripeClient();
  const list=vi.spyOn(stripe.checkout.sessions,'list').mockReturnValue({[Symbol.asyncIterator]:async function*(){yield session;}} as never);
  const expired=vi.spyOn(stripe.checkout.sessions,'expire').mockResolvedValue({...session,status:'expired',url:null} as never);
  try{
    const result=await expireCommerceCheckout(ctx,order.orderId);expect(result.session?.status).toBe('expired');
    expect(expired).toHaveBeenCalledWith(session.id,{},expect.objectContaining({stripeAccount:'acct_DepositFixture',idempotencyKey:`gf-commerce-expire:${order.orderId}`}));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({created:expect.any(Object)}),{stripeAccount:'acct_DepositFixture'});
  }finally{list.mockRestore();expired.mockRestore();}
});
it('applies $20 already-paid deposit to a $100 service without discounting it, and restores the original deposit on service refunds',async()=>{
  // Keep this service settlement on the venue's current business day, including midnight/cutoff boundaries.
  const [loc]=await withTenant(tenant,tx=>tx`select timezone,business_day_cutoff::text as cutoff from locations where id=${tenant.locationId}`);
  const now=new Date(),date=businessDateOf(now,loc!.timezone,loc!.cutoff);
  const [cutoffHour,cutoffMinute]=loc!.cutoff.split(':').map(Number);
  const nextCutoff=wallMinuteToInstant(date,loc!.timezone,1440+cutoffHour!*60+cutoffMinute!);
  const startsAt=new Date(now.getTime()+Math.min(2*60000,(nextCutoff.getTime()-now.getTime())/2));
  expect(businessDateOf(startsAt,loc!.timezone,loc!.cutoff)).toBe(date);
  const h=await hold(startsAt.toISOString());
  await run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Already paid deposit receipt'});
  await withTenant(tenant,tx=>tx`update location_checkout_settings set checkout_timing='after_service_combined',sales_tax_rate_percent=0 where location_id=${tenant.locationId}`);
  const ticket=await run<{ticketId:string}>('ticket.open',{appointmentId:h.appointmentId,customerId:null,items:[{serviceId,membershipId:staffId}]});
  await withTenant(tenant,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);
  const input={ticketId:ticket.ticketId,payments:[{method:'cash',amountCents:8000}],depositApplication:{holdId:h.holdId,amountCents:2000}},key=randomUUID();
  const closed=await run<{totalCents:number}>('ticket.pay',input,key);await run('ticket.pay',input,key);expect(closed.totalCents).toBe(10000);
  const [fact]=await withTenant(tenant,tx=>tx`select t.subtotal_cents,t.discount_cents,t.total_cents,
    (select sum(amount_cents)::int from payments where ticket_id=t.id and method='cash') as new_cash,
    (select sum(amount_cents)::int from payments where ticket_id=t.id and method='deposit') as deposit,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${h.holdId}) as remaining
    from tickets t where t.id=${ticket.ticketId}`);
  expect(fact).toEqual({subtotal_cents:10000,discount_cents:0,total_cents:10000,new_cash:8000,deposit:2000,remaining:0});
  const shop=await resolveHostedShop('golden-foot');
  const detail=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop,h.appointmentId,'en'));
  expect(detail!.deposit).toMatchObject({appliedCents:2000,availableCents:0,serviceRemainingCents:0});
  const reason={ticketId:ticket.ticketId,refundAmountCents:2000,refundTipCents:0,refundMethod:'original_payment',reason:'other',notes:'Partial service refund QA'},refundKey=randomUUID();
  await run('ticket.refund',reason,refundKey);await run('ticket.refund',reason,refundKey);
  const [part]=await withTenant(tenant,tx=>tx`select cash_cents,deposit_cents from ticket_refunds where ticket_id=${ticket.ticketId}`);
  expect(part).toEqual({cash_cents:1600,deposit_cents:400});
  const [purchase]=await withTenant(tenant,tx=>tx`select p.id from commerce_payments p join commerce_appointment_holds h on h.order_id=p.order_id where h.id=${h.holdId}`);
  const unused=await run<{refundId:string}>('commerce.requestRefund',{paymentId:purchase!.id,amountCents:400,reason:'Return the restored unused deposit'});
  await run('commerce.confirmOfflineRefund',{refundId:unused.refundId,reference:'Restored deposit returned QA'});
  const partial=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop,h.appointmentId,'en'));
  expect(partial!.deposit).toMatchObject({status:'paid',appliedCents:1600,refundedCents:400,availableCents:0,serviceRemainingCents:0});
  await run('ticket.refund',{...reason,refundAmountCents:8000});
  const [restored]=await withTenant(tenant,tx=>tx`select sum(amount_cents)::int as n,
    count(*) filter(where entry='restored')::int as restorations from commerce_deposit_ledger where hold_id=${h.holdId}`);
  expect(restored).toEqual({n:1600,restorations:2});
});

it('moves an unpaid reservation with its original quote, deadline and payment; replaces stale notices and confirms once after payment',async()=>{
  const date=new Date(Date.now()+31*86400000).toISOString().slice(0,10);
  const startsAt=wallMinuteToInstant(date,ctx.timezone,14*60).toISOString();
  const movedAt=wallMinuteToInstant(date,ctx.timezone,15*60).toISOString();
  const base=input(startsAt,resourceId);
  const h=await run('commerce.holdAppointment',{...base,appointment:{...base.appointment,source:'web',guest:{manageToken:`mt_${randomUUID()}`,bookingSmsConsent:false,
    customer:{name:'Pending reschedule QA',email:'deposit-reschedule@example.test',phoneE164:'+12025550991'}}}});
  const order=await run<OnlineOrder>('commerce.startDepositCheckout',{holdId:h.holdId});
  await withTenant(tenant,tx=>tx`update customers set locale='en' where id=(select customer_id from appointments where id=${h.appointmentId})`);
  await run('commerce.sendDepositNotice',{holdId:h.holdId,reason:'Send original payment request'});
  const original=await withTenant(tenant,tx=>tx`select h.amount_cents,h.service_total_cents,h.policy_snapshot,h.expires_at::text,h.order_id,o.snapshot,
    p.id as payment_id,p.amount_cents as payment_amount from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id
    join commerce_payments p on p.order_id=o.id where h.id=${h.holdId}`);
  const key=randomUUID(),change={appointmentId:h.appointmentId,startsAt:movedAt,override:{reason:'desk_coordination'}};
  await run('appointment.reschedule',change,key);await run('appointment.reschedule',change,key);
  const unchanged=await withTenant(tenant,tx=>tx`select h.amount_cents,h.service_total_cents,h.policy_snapshot,h.expires_at::text,h.order_id,o.snapshot,
    p.id as payment_id,p.amount_cents as payment_amount from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id
    join commerce_payments p on p.order_id=o.id where h.id=${h.holdId}`);
  expect(unchanged).toEqual(original);
  const notices=await withTenant(tenant,tx=>tx`select kind,status,body_text,last_error from email_outbox where entity_id=${h.appointmentId} order by created_at,id`);
  expect(notices.filter(n=>n.kind==='appointment_confirm'||n.kind==='appointment_changed')).toHaveLength(0);
  expect(notices.filter(n=>n.kind==='appointment_deposit_pending')).toHaveLength(2);
  expect(notices.filter(n=>n.status==='failed')).toMatchObject([{last_error:'deposit_schedule_changed'}]);
  const pending=notices.find(n=>n.status==='pending')!;
  expect(pending.body_text).toContain('still awaiting deposit payment');
  const formatted=new Intl.DateTimeFormat('en',{timeZone:ctx.timezone,dateStyle:'medium',timeStyle:'short'});
  expect(pending.body_text).toContain(`Appointment time: ${formatted.format(new Date(movedAt))}`);
  expect(pending.body_text).toContain(`Previous appointment time: ${formatted.format(new Date(startsAt))}`);
  expect(pending.body_text).toContain(`Pay before: ${formatted.format(new Date(h.expiresAt))}`);
  expect(await run('commerce.startDepositCheckout',{holdId:h.holdId})).toEqual(order);
  // Even if the previous instructions were delivered, the new occurrence needs its own pending notice.
  await withTenant(tenant,tx=>tx`update email_outbox set status='sent' where entity_id=${h.appointmentId} and kind='appointment_deposit_pending' and status='pending'`);
  const finalTime=wallMinuteToInstant(date,ctx.timezone,16*60).toISOString(),secondKey=randomUUID();
  await run('appointment.reschedule',{...change,startsAt:finalTime},secondKey);
  await run('appointment.reschedule',{...change,startsAt:finalTime},secondKey);
  const later=await withTenant(tenant,tx=>tx`select status,body_text from email_outbox where entity_id=${h.appointmentId} and kind='appointment_deposit_pending'`);
  expect(later).toHaveLength(3);expect(later.filter(n=>n.status==='sent')).toHaveLength(1);
  expect(later.filter(n=>n.status==='pending')).toHaveLength(1);
  expect(later.find(n=>n.status==='pending')!.body_text).toContain(`Appointment time: ${formatted.format(new Date(finalTime))}`);
  await pay(order);await pay(order);
  const [final]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,a.starts_at::text,
    (select count(*)::int from commerce_deposit_ledger where hold_id=${h.holdId} and entry='collected') as collections,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm' and to_email='deposit-reschedule@example.test') as confirmations,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending' and status='pending') as pending_notices
    from appointments a where a.id=${h.appointmentId}`);
  expect(final).toMatchObject({status:'booked',deposit_status:'paid',collections:1,confirmations:1,pending_notices:0});
  expect(new Date(final!.starts_at).toISOString()).toBe(finalTime);
});
it('rejects changing an elapsed unpaid reservation before its expiry worker runs without moving the original capacity',async()=>{
  const h=await hold(future(900),resourceId);await due(h);
  const before=await withTenant(tenant,tx=>tx`select starts_at::text,ends_at::text,status from appointment_items where appointment_id=${h.appointmentId}`);
  await expect(run('appointment.reschedule',{appointmentId:h.appointmentId,startsAt:future(902),override:{reason:'desk_coordination'}}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_hold_not_payable'}});
  expect(await withTenant(tenant,tx=>tx`select starts_at::text,ends_at::text,status from appointment_items where appointment_id=${h.appointmentId}`)).toEqual(before);
  expect(await expiry(h)).toEqual({expired:true});
});
it('rolls back a conflicting unpaid reschedule while keeping its payment request and original slot',async()=>{
  const oldTime=future(910),occupiedTime=future(911),h=await hold(oldTime,resourceId);
  await hold(occupiedTime,resourceId);
  const before=await withTenant(tenant,tx=>tx`select h.*,a.starts_at::text from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
  await expect(run('appointment.reschedule',{appointmentId:h.appointmentId,startsAt:occupiedTime,override:{reason:'desk_coordination'}}))
    .rejects.toMatchObject({code:'RESOURCE_CONFLICT'});
  expect(await withTenant(tenant,tx=>tx`select h.*,a.starts_at::text from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`)).toEqual(before);
});
