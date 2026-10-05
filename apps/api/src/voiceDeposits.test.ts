import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import type Stripe from 'stripe';
import {withTenant,closeDb,jsonb} from '@gf/db';
import {addDays,businessDateOf,wallMinuteToInstant} from '@gf/scheduling';
import {buildContext} from './actor';
import {buildServer} from './server';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {__resetRateLimit} from './public/rateLimit';
import {__resetAiRateLimit} from './billing/aiAdmission';
import {commerceStripeClient} from './commerce/client';
import {runCommerceTask} from './commerce/worker';
import {flushEmails} from './email/flush';
import {loadAppointmentDetail} from './queries/appointmentDetail';

const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const phone='+12025550200',path=`/v1/voice/${encodeURIComponent(phone)}`,account='acct_VoiceDepositFixture';
const keys=generateKeyPairSync('ed25519');
let ctx:Awaited<ReturnType<typeof buildContext>>,app:ReturnType<typeof buildServer>,token:string,services:string[],staff:string[],date:string,timezone:string;
let checkoutSpy:{mockRestore:()=>void};
let caller=200;
const run=async<T=unknown>(name:string,input:unknown)=>(await dispatch<T>(name,input,ctx,{idempotencyKey:randomUUID()})).result;
const headers=()=>({authorization:`Bearer ${token}`});
const saveAccount=(ready:boolean)=>dispatchSystem('commerce.saveAccount',{stripeAccountId:account,livemode:false,chargesEnabled:ready,payoutsEnabled:ready,
  detailsSubmitted:ready,capabilities:{card_payments:ready?'active':'inactive'}},ctx,{idempotencyKey:randomUUID()});
beforeAll(async()=>{
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.COMMERCE_STRIPE_MODE='test';process.env.STRIPE_SECRET_KEY='sk_test_voice_deposit_fixture';
  process.env.BOOKING_BASE_URL='https://book.geniefront.com';process.env.BOOKING_MANAGE_PAGE_ENABLED='1';
  process.env.MANAGE_TOKEN_WRAP_KEY='voice-deposit-fixture-management-key-at-least-32-characters';
  vi.stubEnv('TELNYX_PUBLIC_KEY',keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'));
  const [m]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id
    join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
  ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});
  expect((await withTenant(ctx,tx=>tx`select current_user as role,(select rolbypassrls from pg_roles where rolname=current_user) as bypass`))[0])
    .toEqual({role:'app_user',bypass:false});
  timezone=ctx.timezone;date=addDays(businessDateOf(new Date(),timezone,'00:00'),35);
  await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,
    cancelCutoffHours:4,retainDepositAfterCutoff:false});
  await run('location.saveHours',{hours:Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'09:00',close:'20:00'}]))});
  await run('location.saveBookingPolicy',{mode:'location',baseCapacity:3,bufferEnabled:false,bufferExtra:1,requestBufferEnabled:false,requestBufferExtra:1});
  await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb) where id=${tenant.locationId}`);
  services=[];
  for(const [name,price] of [['Voice deposit A QA',10000],['Voice deposit B QA',7000]] as const)
    services.push((await run<{serviceId:string}>('catalog.saveService',{name:{en:name},durationMin:30,basePriceCents:price,taxable:false,onlineBookable:true})).serviceId);
  staff=await withTenant(tenant,async tx=>{const rows=await tx`select membership_id from staff_profiles where location_id=${tenant.locationId} and is_bookable`;
    for(const d of [date,addDays(date,1),addDays(date,3)])for(const s of rows)await tx`insert into shifts(org_id,location_id,membership_id,business_date,start_min,end_min,status)
      values(${tenant.orgId},${tenant.locationId},${s.membership_id},${d},540,1200,'published') on conflict do nothing`;
    return rows.map(r=>r.membership_id);});
  const line=await dispatch<{toolToken:string}>('location.savePhoneLine',{e164:phone,purpose:'ai_voice',active:true,aiAnswer:true,rotateToolToken:true},ctx,
    {systemOrigin:'voice_deposit_fixture'});token=line.result.toolToken;
  await saveAccount(true);
  checkoutSpy=vi.spyOn(commerceStripeClient().checkout.sessions,'create').mockImplementation(async(raw)=>{
    const input=raw as Stripe.Checkout.SessionCreateParams;
    return {id:`cs_test_voice_${input.client_reference_id}`,livemode:false,client_reference_id:input.client_reference_id,metadata:input.metadata,
      amount_total:2000,currency:'usd',status:'open',payment_status:'unpaid',mode:'payment',url:'https://checkout.stripe.com/voice-deposit-fixture',
      expires_at:Math.floor(Date.now()/1000)+86400} as never;
  });
  app=buildServer();await app.ready();
});
beforeEach(()=>{__resetRateLimit();__resetAiRateLimit();});
afterAll(async()=>{checkoutSpy?.mockRestore();vi.unstubAllEnvs();await app.close();await closeDb();});
async function prepare(two=true){
  const items=two?[{guestIndex:0,serviceId:services[0]},{guestIndex:1,serviceId:services[1]}]:[{guestIndex:0,serviceId:services[0]}];
  const response=await app.inject({method:'GET',url:`${path}/context-v2?${new URLSearchParams({date,itemsJson:JSON.stringify(items)})}`,headers:headers()});
  expect(response.statusCode).toBe(200);const offer=response.json().offers[0];expect(offer).toBeTruthy();
  const time=offer.times[0].split(/[-,/]/)[0];
  const input={slotToken:offer.slotToken,time,customerName:`Voice deposit guest ${caller}`,phoneE164:`+1202555${String(caller++).padStart(4,'0')}`,
    email:'voice-deposit-qa@example.test',priceConfirmed:true,confirmedTotalCents:offer.priceCents,
    depositConsent:{accepted:true,policyVersion:offer.deposit.policyVersion,serviceTotalCents:offer.deposit.serviceTotalCents,amountCents:offer.deposit.amountCents}};
  return {offer,input,submit:(extra:Record<string,unknown>={})=>app.inject({method:'POST',url:`${path}/bookings-v2`,headers:headers(),payload:{...input,...extra}})};
}
it('quotes a two-guest deposit and rejects missing, declined or stale consent without creating a booking or payment',async()=>{
  const p=await prepare();expect(p.offer.deposit).toMatchObject({required:true,amountCents:2000,serviceTotalCents:17000,currency:'USD',cancelCutoffHours:4,holdMinutes:15});
  const [before]=await withTenant(tenant,tx=>tx`select count(*)::int as n from appointments`);
  const absent=await p.submit({depositConsent:undefined});expect(absent.statusCode).toBe(400);expect(absent.json().details.reason).toBe('deposit_confirmation_required');
  expect((await p.submit({depositConsent:{...p.input.depositConsent,accepted:false}})).statusCode).toBe(400);
  const stale=await p.submit({depositConsent:{...p.input.depositConsent,amountCents:1999}});expect(stale.statusCode).toBe(400);expect(stale.json().details.reason).toBe('deposit_quote_changed');
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:false,membershipsEnabled:false});
  const disabled=await p.submit();expect(disabled.statusCode).toBe(400);expect(disabled.json().details.reason).toBe('deposit_quote_changed');
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  const [after]=await withTenant(tenant,tx=>tx`select count(*)::int as n from appointments`);expect(after!.n).toBe(before!.n);
});
it('holds once, queues deposit instructions without confirmation, and reads actual paid status after command replay',async()=>{
  const p=await prepare(),first=await p.submit();expect(first.statusCode).toBe(200);const result=first.json();
  expect(result).toMatchObject({ok:true,status:'pending_deposit',bookingConfirmed:false,deposit:{amountCents:2000,paymentAction:'email_link'}});
  expect(result.guidance).toContain('Do not say the booking is confirmed');expect(result).not.toHaveProperty('manageToken');
  const retry=await p.submit();expect(retry.json().appointmentId).toBe(result.appointmentId);expect(retry.json().replayed).toBe(true);
  const [h]=await withTenant(tenant,tx=>tx`select h.id,h.policy_snapshot,p.id as payment_id,p.order_id,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm') as confirmations,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending') as requests,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as money_rows
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id join commerce_payments p on p.order_id=h.order_id where a.id=${result.appointmentId}`);
  expect(h).toMatchObject({confirmations:0,requests:1,money_rows:0,policy_snapshot:{consent:{accepted:true,method:'voice_confirmation'},
    guestAllocation:{guests:[{guestIndex:0,amountCents:1176},{guestIndex:1,amountCents:824}]}}});
  await flushEmails(ctx);
  let delivery:string|undefined;
  for(let check=0;check<30;check++){
    const [row]=await withTenant(tenant,tx=>tx`select status from email_outbox where entity_id=${result.appointmentId} and kind='appointment_deposit_pending'`);
    delivery=row?.status;if(delivery==='captured')break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(delivery).toBe('captured');
  expect((await p.submit({depositConsent:{...p.input.depositConsent,amountCents:2001}})).statusCode).toBe(409);
  const [task]=await withTenant(tenant,tx=>tx`select id from commerce_tasks where subject_id=${h!.order_id} and kind='checkout'`);
  expect(await runCommerceTask(ctx,task!.id)).toBe(true);
  const [payment]=await withTenant(tenant,tx=>tx`select checkout_session_id from commerce_payments where id=${h!.payment_id}`);
  await dispatchSystem('commerce.recordPayment',{orderId:h!.order_id,stripeAccountId:account,livemode:false,eventId:`evt_${randomUUID()}`,
    eventType:'checkout.session.completed',sessionId:payment!.checkout_session_id,paymentIntentId:`pi_${randomUUID()}`,amountCents:2000,currency:'usd'},ctx,{idempotencyKey:randomUUID()});
  const paid=await p.submit();expect(paid.json()).toMatchObject({status:'confirmed',bookingConfirmed:true,replayed:true,deposit:{paymentAction:'none'}});
  const [facts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from commerce_deposit_ledger where hold_id=${h!.id} and entry='collected') as collected,
    (select count(*)::int from email_outbox where entity_id=${result.appointmentId} and kind='appointment_confirm') as confirmations,
    (select count(*)::int from email_outbox where entity_id=${result.appointmentId} and kind='appointment_deposit_pending' and status='pending') as stale_requests`);
  expect(facts).toEqual({collected:1,confirmations:1,stale_requests:0});
});
it('keeps a real pending hold for frontdesk cash when the merchant is unavailable, and requires a receipt and seller permission',async()=>{
  await saveAccount(false);const p=await prepare(false),response=await p.submit();expect(response.statusCode).toBe(200);const result=response.json();
  expect(result).toMatchObject({status:'pending_deposit',bookingConfirmed:false,deposit:{paymentAction:'frontdesk'}});
  const detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,result.appointmentId));
  expect(detail.deposit).toMatchObject({recordable:true,onlineCheckoutAvailable:false,emailAvailable:true});
  const [order]=await withTenant(tenant,tx=>tx`select order_id from commerce_appointment_holds where id=${result.deposit.holdId}`);expect(order!.order_id).toBeNull();
  await expect(dispatch('commerce.recordOfflineDeposit',{holdId:result.deposit.holdId,amountCents:2000,method:'cash',reference:'Unauthorized cash'},
    {...ctx,permissions:new Set(['appointment.write'])},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await expect(run('commerce.recordOfflineDeposit',{holdId:result.deposit.holdId,amountCents:2000,method:'cash',reference:''})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await run('commerce.recordOfflineDeposit',{holdId:result.deposit.holdId,amountCents:2000,method:'cash',reference:'Voice frontdesk cash receipt QA'});
  expect((await p.submit()).json()).toMatchObject({status:'confirmed',bookingConfirmed:true,replayed:true});
  await saveAccount(true);
});
it('offers frontdesk assistance without pretending a payment email was delivered when the caller has no email',async()=>{
  const p=await prepare(false),response=await p.submit({email:undefined});expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({bookingConfirmed:false,deposit:{paymentAction:'frontdesk',emailDelivery:'unavailable'}});
  await expect(run('commerce.sendDepositNotice',{holdId:response.json().deposit.holdId,reason:'Missing address'}))
    .rejects.toMatchObject({details:{reason:'customer_email_required'}});
  const [h]=await withTenant(tenant,tx=>tx`select order_id from commerce_appointment_holds where id=${response.json().deposit.holdId}`);expect(h!.order_id).toBeNull();
});
it('counts a shared two-therapist service once when quoting and allocating the voice deposit',async()=>{
  const shared=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Couples voice deposit QA'},durationMin:30,basePriceCents:12000,
    staffCount:2,guestCount:2,taxable:false,onlineBookable:true})).serviceId;
  const r=await app.inject({method:'GET',url:`${path}/context-v2?${new URLSearchParams({date,itemsJson:JSON.stringify([
    {guestIndex:0,guestIndices:[0,1],serviceId:shared}])})}`,headers:headers()});
  expect(r.statusCode).toBe(200);const offer=r.json().offers[0];expect(offer.deposit.serviceTotalCents).toBe(12000);
  const b=await app.inject({method:'POST',url:`${path}/bookings-v2`,headers:headers(),payload:{slotToken:offer.slotToken,time:offer.times[0].split(/[-,/]/)[0],
    customerName:'Shared voice deposit QA',phoneE164:'+12025550808',priceConfirmed:true,confirmedTotalCents:12000,
    depositConsent:{accepted:true,policyVersion:offer.deposit.policyVersion,serviceTotalCents:12000,amountCents:2000}}});
  expect(b.statusCode).toBe(200);const [h]=await withTenant(tenant,tx=>tx`select policy_snapshot from commerce_appointment_holds where appointment_id=${b.json().appointmentId}`);
  expect(h!.policy_snapshot.guestAllocation.guests).toEqual([{guestIndex:0,amountCents:1000,serviceTotalCents:6000},
    {guestIndex:1,amountCents:1000,serviceTotalCents:6000}]);
});
it('reports expired status on replay, suppresses stale deposit mail and releases the slot through the existing worker command',async()=>{
  await saveAccount(false);const p=await prepare(false),response=await p.submit();expect(response.statusCode).toBe(200);const result=response.json();
  await withTenant(tenant,tx=>tx`update commerce_appointment_holds set expires_at=now()-interval '1 second' where id=${result.deposit.holdId}`);
  await dispatchSystem('commerce.expireAppointmentHold',{holdId:result.deposit.holdId},ctx,{idempotencyKey:randomUUID()});
  expect((await p.submit()).json()).toMatchObject({status:'expired',bookingConfirmed:false,replayed:true,deposit:{paymentAction:'none'}});
  await flushEmails(ctx);
  const [stale]=await withTenant(tenant,tx=>tx`select count(*)::int as n from email_outbox where entity_id=${result.appointmentId}
    and kind='appointment_deposit_pending' and status in('pending','sending','sent')`);expect(stale!.n).toBe(0);
  const rows=await withTenant(tenant,tx=>tx`select status from appointment_items where appointment_id=${result.appointmentId}`);expect(rows.every(r=>r.status==='cancelled')).toBe(true);
  await saveAccount(true);
});
it('preserves the native requested-therapist buffer while recording guest shares under the same deposit transaction',async()=>{
  await saveAccount(false);
  await withTenant(tenant,tx=>tx`update staff_profiles set max_concurrent_appointments=1 where membership_id=${staff[0]!}`);
  await run('location.saveBookingPolicy',{mode:'location',baseCapacity:3,bufferEnabled:false,bufferExtra:1,requestBufferEnabled:true,requestBufferExtra:1});
  const r=await app.inject({method:'GET',url:`${path}/context?${new URLSearchParams({date:addDays(date,3),serviceId:services[0]!,membershipId:staff[0]!})}`,headers:headers()});
  expect(r.statusCode).toBe(200);const context=r.json(),slot=context.slots[0];expect(slot).toBeTruthy();
  const input={slotToken:slot.slotToken,customerName:'Native deposit one',phoneE164:'+12025550501',email:'native-deposit-qa@example.test',
    depositConsent:{accepted:true,policyVersion:context.deposit.policyVersion,serviceTotalCents:context.deposit.serviceTotalCents,amountCents:context.deposit.amountCents}};
  const send=(name:string)=>app.inject({method:'POST',url:`${path}/bookings`,headers:headers(),payload:{...input,customerName:name}});
  const first=await send('Native deposit one'),second=await send('Native deposit two');expect(first.statusCode).toBe(200);expect(second.statusCode).toBe(200);
  expect(first.json()).toMatchObject({status:'pending_deposit',bookingConfirmed:false});expect((await send('Native deposit three')).statusCode).toBe(409);
  const [item]=await withTenant(tenant,tx=>tx`select details,membership_id from appointment_items where appointment_id=${first.json().appointmentId}`);
  expect(item).toMatchObject({membership_id:staff[0],details:{publicGuestIndex:0}});
  await run('location.saveBookingPolicy',{mode:'location',baseCapacity:3,bufferEnabled:false,bufferExtra:1,requestBufferEnabled:false,requestBufferExtra:1});
  await saveAccount(true);
});
it('uses the same pending-deposit command for the signed legacy Telnyx route and never says the unpaid booking is confirmed',async()=>{
  const signed=(tool:string,body:object)=>{
    const raw=JSON.stringify({to:phone,shop_token:token,...body}),timestamp=String(Math.floor(Date.now()/1000));
    return app.inject({method:'POST',url:`/v1/telnyx/tools/${tool}`,payload:raw,headers:{'content-type':'application/json','telnyx-timestamp':timestamp,
      'telnyx-signature-ed25519':sign(null,Buffer.from(`${timestamp}|${raw}`),keys.privateKey).toString('base64')}});
  };
  const available=await signed('find_slots',{around:wallMinuteToInstant(addDays(date,1),timezone,600).toISOString(),service_heard:'Voice deposit A QA',party_size:1});
  expect(available.statusCode).toBe(200);const info=available.json(),slot=info.slots[0];expect(slot).toBeTruthy();expect(info.deposit.amountCents).toBe(2000);
  const input={slot_starts_at:slot.startsAt,service_heard:'Voice deposit A QA',caller_name:'Legacy deposit QA',from:'+12025550444',email:'legacy-deposit-qa@example.test',
    call_session_id:`legacy_${randomUUID()}`};
  expect((await signed('book_appointment',input)).json()).toMatchObject({ok:false,error:'deposit_confirmation_required'});
  const consent={accepted:true,policyVersion:info.deposit.policyVersion,serviceTotalCents:info.deposit.serviceTotalCents,amountCents:info.deposit.amountCents};
  const booked=await signed('book_appointment',{...input,depositConsent:consent});expect(booked.statusCode).toBe(200);
  expect(booked.json()).toMatchObject({ok:true,status:'pending_deposit',bookingConfirmed:false});
  expect(booked.json().say).not.toContain("You're all set");expect(booked.json().say).not.toContain('See you then');
  expect((await signed('book_appointment',{...input,depositConsent:consent})).json()).toMatchObject({appointmentId:booked.json().appointmentId,replayed:true});
});
