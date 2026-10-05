import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import type Stripe from 'stripe';
import {withTenant,closeDb,jsonb} from '@gf/db';
import {wallMinuteToInstant} from '@gf/scheduling';
import {buildContext} from './actor';
import {buildServer} from './server';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {commerceStripeClient} from './commerce/client';
import {__setTurnstileVerifierForTests} from './public/turnstile';
import {__resetRateLimit} from './public/rateLimit';
import {quoteAppointmentDeposit} from '@gf/payroll';

const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const origin='https://deposit-qa.example.test';
let ctx:Awaited<ReturnType<typeof buildContext>>,app:ReturnType<typeof buildServer>,publicKey:string,serviceId:string,staffId:string,timezone:string,date:string;
let createSpy:{mock:{calls:unknown[][]};mockRestore:()=>void};
const run=async<T=unknown>(name:string,input:unknown)=>(await dispatch<T>(name,input,ctx,{idempotencyKey:randomUUID()})).result;
beforeAll(async()=>{
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.STRIPE_SECRET_KEY='sk_test_public_deposit_fixture';process.env.COMMERCE_STRIPE_MODE='test';
  process.env.BOOKING_MANAGE_PAGE_ENABLED='1';process.env.BOOKING_BASE_URL='http://localhost:5296';
  process.env.MANAGE_TOKEN_WRAP_KEY='public-deposit-test-wrap-key-at-least-32-chars';
  process.env.SUPABASE_URL??='http://127.0.0.1:59999';
  __setTurnstileVerifierForTests(async()=>true);
  const [m]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id
    join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
  ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});
  await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_PublicDepositFixture',livemode:false,chargesEnabled:true,payoutsEnabled:true,
    detailsSubmitted:true,capabilities:{card_payments:'active'}},ctx,{idempotencyKey:randomUUID()});
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Public deposit QA'},durationMin:30,basePriceCents:10000,onlineBookable:true})).serviceId;
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositAmountCents:2000});
  await run('location.addWebOrigin',{origin});
  const [loc]=await withTenant(tenant,tx=>tx`select public_key,timezone from locations where id=${tenant.locationId}`);publicKey=loc!.public_key;timezone=loc!.timezone;
  const [staff]=await withTenant(tenant,tx=>tx`select membership_id as id from staff_profiles where location_id=${tenant.locationId} and is_bookable limit 1`);staffId=staff!.id;
  date=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
  await withTenant(tenant,async tx=>{
    // This controlled calendar keeps API validation real and isolates the financial state machine.
    await tx`update locations set settings=jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb) where id=${tenant.locationId}`;
    await tx`insert into shifts(org_id,location_id,membership_id,business_date,start_min,end_min,status)
      values(${tenant.orgId},${tenant.locationId},${staffId},${date},540,1260,'published') on conflict do nothing`;
  });
  createSpy=vi.spyOn(commerceStripeClient().checkout.sessions,'create').mockImplementation(async raw=>{
    const input=raw as Stripe.Checkout.SessionCreateParams;
    return {id:`cs_test_${input.client_reference_id}`,livemode:false,client_reference_id:input.client_reference_id,metadata:input.metadata,
      amount_total:2000,currency:'usd',status:'open',payment_status:'unpaid',mode:'payment',url:'https://checkout.stripe.com/qa-public-deposit',
      expires_at:Math.floor(Date.now()/1000)+86400} as never;
  });
  app=buildServer();await app.ready();
});
beforeEach(()=>__resetRateLimit());
afterAll(async()=>{createSpy?.mockRestore();__setTurnstileVerifierForTests(null);await app.close();await closeDb();});
const payload=(minute=720)=>({turnstileToken:'controlled-turnstile-fixture',customer:{name:'Public deposit buyer',phone:`+1202555${String(minute).padStart(4,'0')}`,email:'public-deposit-qa@example.test',smsOptIn:false,bookingSmsConsent:false},
  items:[{serviceId,staffId,addonIds:[],startsAt:wallMinuteToInstant(date,timezone,minute).toISOString()}],partySize:1,website:'',formElapsedMs:45000});
const post=async(body:object,key=randomUUID())=>{
  const shop=await app.inject({method:'GET',url:'/public/v1/hosted/shops/golden-foot?locale=en',headers:{origin}}),b=shop.json().onlineBooking;
  const consent={accepted:true,policyVersion:b.depositPolicyVersion,serviceTotalCents:10000,
    amountCents:quoteAppointmentDeposit(10000,b.depositMethod==='percentage'?{percentBps:b.depositPercentBps}:{fixedAmountCents:b.depositAmountCents})};
  return app.inject({method:'POST',url:'/public/v1/bookings',headers:{origin,'x-gf-public-key':publicKey,'idempotency-key':key},payload:{depositConsent:consent,...body}});
};
it('returns a protected pending-deposit reservation and the real Checkout adapter result without sending a booking confirmation',async()=>{
  const key=randomUUID(),body=payload(),response=await post(body,key);expect(response.statusCode).toBe(201);
  const result=response.json();expect(result.summary.deposit).toMatchObject({status:'pending',amountCents:2000,availableCents:0,checkoutUrl:'https://checkout.stripe.com/qa-public-deposit'});
  expect(result.summary.priceCents).toBe(10000);expect(createSpy).toHaveBeenCalledOnce();
  const params=createSpy.mock.calls[0]![0] as Stripe.Checkout.SessionCreateParams;
  expect(params.success_url?.includes('/l/golden-foot#g/')).toBe(true);expect(params.payment_intent_data?.metadata?.gf_domain).toBe('customer_commerce');
  const [count]=await withTenant(tenant,tx=>tx`select count(*)::int as n from email_outbox where entity_id=${result.bookingId} and kind='appointment_confirm'`);expect(count!.n).toBe(0);
  const replay=await post(body,key);expect(replay.statusCode).toBe(200);expect(replay.json().bookingId).toBe(result.bookingId);expect(createSpy).toHaveBeenCalledOnce();
  const changedAt=wallMinuteToInstant(date,timezone,750).toISOString(),requestId=randomUUID();
  const change=()=>app.inject({method:'POST',url:`/public/v1/bookings/${result.bookingId}/reschedule`,headers:{origin,'x-gf-public-key':publicKey},
    payload:{manageToken:result.manageToken,last4:body.customer.phone.slice(-4),startsAt:changedAt,requestId}});
  const changed=await change();expect(changed.statusCode).toBe(200);expect((await change()).statusCode).toBe(200);
  const waiting=await app.inject({method:'POST',url:'/public/v1/hosted/manage',headers:{origin},payload:{slug:'golden-foot',manageToken:result.manageToken,locale:'en'}});
  expect(waiting.statusCode).toBe(200);
  expect(waiting.json().booking.deposit).toMatchObject({status:'pending',amountCents:2000,availableCents:0,
    expiresAt:result.summary.deposit.expiresAt,checkoutUrl:result.summary.deposit.checkoutUrl});
  expect(createSpy).toHaveBeenCalledOnce();
  const [beforePay]=await withTenant(tenant,tx=>tx`select a.self_reschedule_count,a.starts_at::text,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm') as confirmations,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending') as pending_notices
    from appointments a where a.id=${result.bookingId}`);
  expect(beforePay).toMatchObject({self_reschedule_count:1,confirmations:0,pending_notices:2});
  expect(new Date(beforePay!.starts_at).toISOString()).toBe(changedAt);
  const [p]=await withTenant(tenant,tx=>tx`select p.order_id,p.checkout_session_id from commerce_payments p join commerce_appointment_holds h on h.order_id=p.order_id where h.appointment_id=${result.bookingId}`);
  await dispatchSystem('commerce.recordPayment',{orderId:p!.order_id,stripeAccountId:'acct_PublicDepositFixture',livemode:false,eventId:`evt_${randomUUID()}`,
    eventType:'checkout.session.completed',sessionId:p!.checkout_session_id,paymentIntentId:`pi_${randomUUID()}`,amountCents:2000,currency:'usd'},ctx,{idempotencyKey:randomUUID()});
  const managed=await app.inject({method:'POST',url:'/public/v1/hosted/manage',headers:{origin},payload:{slug:'golden-foot',manageToken:result.manageToken,locale:'en'}});
  expect(managed.statusCode).toBe(200);expect(managed.json().booking.deposit).toMatchObject({status:'paid',availableCents:2000,checkoutUrl:null});
});
it('requires explicit current-policy and exact-quote consent before creating a public deposit reservation',async()=>{
  const shop=await app.inject({method:'GET',url:'/public/v1/hosted/shops/golden-foot?locale=en',headers:{origin}}),policy=shop.json().onlineBooking;
  expect(policy).toMatchObject({depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,retainDepositAfterCutoff:false});
  const [before]=await withTenant(tenant,tx=>tx`select count(*)::int as n from appointments`);
  const missing=await app.inject({method:'POST',url:'/public/v1/bookings',headers:{origin,'x-gf-public-key':publicKey,'idempotency-key':randomUUID()},payload:payload(840)});
  expect(missing.statusCode).toBe(400);
  const bad={...payload(840),depositConsent:{accepted:true,policyVersion:policy.depositPolicyVersion,serviceTotalCents:10000,amountCents:1999}};
  expect((await post(bad)).statusCode).toBe(400);
  const stale={...bad,depositConsent:{...bad.depositConsent,policyVersion:'old-policy',amountCents:2000}};
  expect((await post(stale)).statusCode).toBe(400);
  const [after]=await withTenant(tenant,tx=>tx`select count(*)::int as n from appointments`);expect(after!.n).toBe(before!.n);
});
it('keeps public cancellation actions and the automatic refund on the original purchased cutoff after settings change',async()=>{
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  await withTenant(tenant,tx=>tx`insert into shifts(org_id,location_id,membership_id,business_date,start_min,end_min,status)
    values(${tenant.orgId},${tenant.locationId},${staffId},${tomorrow},540,1260,'published') on conflict do nothing`);
  const body={...payload(900),items:[{serviceId,staffId,addonIds:[],startsAt:wallMinuteToInstant(tomorrow,timezone,900).toISOString()}]};
  const created=await post(body);expect(created.statusCode).toBe(201);const result=created.json();
  const [p]=await withTenant(tenant,tx=>tx`select p.id,p.order_id,p.checkout_session_id from commerce_payments p join commerce_appointment_holds h on h.order_id=p.order_id where h.appointment_id=${result.bookingId}`);
  await dispatchSystem('commerce.recordPayment',{orderId:p!.order_id,stripeAccountId:'acct_PublicDepositFixture',livemode:false,eventId:`evt_${randomUUID()}`,
    eventType:'checkout.session.completed',sessionId:p!.checkout_session_id,paymentIntentId:`pi_${randomUUID()}`,amountCents:2000,currency:'usd'},ctx,{idempotencyKey:randomUUID()});
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositAmountCents:2000,cancelCutoffHours:72});
  const detail=await app.inject({method:'POST',url:'/public/v1/hosted/manage',headers:{origin},payload:{slug:'golden-foot',manageToken:result.manageToken,locale:'en'}});
  expect(detail.json().booking.policy.cancelCutoffHours).toBe(4);expect(detail.json().booking.actions.canCancel).toBe(true);
  const cancel=()=>app.inject({method:'POST',url:`/public/v1/bookings/${result.bookingId}/cancel`,headers:{origin,'x-gf-public-key':publicKey},
    payload:{manageToken:result.manageToken,last4:body.customer.phone.slice(-4)}});
  expect((await cancel()).statusCode).toBe(200);expect((await cancel()).statusCode).toBe(200);
  const [facts]=await withTenant(tenant,tx=>tx`select h.status,h.reserved_cents,
    (select count(*)::int from commerce_refunds where payment_id=${p!.id} and amount_cents=2000) as refunds,
    (select count(*)::int from commerce_tasks t join commerce_refunds r on r.id=t.subject_id where r.payment_id=${p!.id} and t.kind='refund') as tasks
    from commerce_appointment_holds h where h.appointment_id=${result.bookingId}`);
  expect(facts).toEqual({status:'refund_pending',reserved_cents:2000,refunds:1,tasks:1});
});
it('rolls back public reservation creation when the mapped merchant cannot accept payments',async()=>{
  await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_PublicDepositFixture',livemode:false,chargesEnabled:false,payoutsEnabled:false,detailsSubmitted:false,
    capabilities:{card_payments:'inactive'}},ctx,{idempotencyKey:randomUUID()});
  const body=payload(780),[before]=await withTenant(tenant,tx=>tx`select count(*)::int as n from appointments`);
  const response=await post(body);expect(response.statusCode).toBe(503);expect(response.json().details.reason).toBe('merchant_payments_unavailable');
  const [after]=await withTenant(tenant,tx=>tx`select count(*)::int as n from appointments`);expect(after!.n).toBe(before!.n);
});
