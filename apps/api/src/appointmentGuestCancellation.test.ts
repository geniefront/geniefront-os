import {randomUUID} from 'node:crypto';
import {buildServer} from './server';
import {publicContext} from './public/publicAuth';
import {hashManageToken} from './public/bookingToken';
import {managedPhoneDigest} from './public/managedCancellation';
import {__resetRateLimit} from './public/rateLimit';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {withTenant,closeDb,jsonb} from '@gf/db';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {applyDepositToTicket} from './handlers/appointmentDepositPayments';
import {depositGuestBalances} from './commerce/depositGuests';
import {loadAppointmentDetail} from './queries/appointmentDetail';
import {loadManagedBookingDetail} from './public/managedDetail';
import {resolveHostedShop} from './public/publicAuth';
import './handlers/commerce';import './handlers/appointmentDeposits';import './handlers/setup';import './handlers/billing';import './handlers/ticket';
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>,serviceId:string,otherServiceId:string,resources:string[],staffId:string;
interface Hold{holdId:string;appointmentId:string;amountCents:number;}
interface Cancelled{appointmentId:string;cancellationIds:string[];cancelledItemIds:string[];remainingGuests:number;refunds:Array<{refundId:string;amountCents:number;status:string}>;}
const run=async<T=unknown>(name:string,input:unknown,key=randomUUID())=>(await dispatch<T>(name,input,ctx,{idempotencyKey:key})).result;
const future=(hours=40)=>new Date(Date.now()+hours*3600000).toISOString();
const body=(startsAt=future())=>({businessKey:randomUUID(),appointment:{source:'desk',partySize:2,customerId:null,walkInName:'Guest cancellation isolated QA',
  override:{reason:'desk_coordination'},items:[
    {serviceId,startsAt,resourceId:resources[0],details:{publicGuestIndex:0}},
    {serviceId:otherServiceId,startsAt,resourceId:resources[1],details:{publicGuestIndex:1}},
  ]}});
async function paid(hours:number){const h=await run<Hold>('commerce.holdAppointment',body(future(hours)));
  const payment=await run<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:`Guest cancellation QA ${h.holdId}`});
  return {h,paymentId:payment.paymentId};}
const cancel=(h:Hold,guestIndices=[0],expectedRefundCents=1176,key=randomUUID())=>run<Cancelled>('appointment.cancelGuests',{
  appointmentId:h.appointmentId,guestIndices,expectedRefundCents,reason:'QA selected guest cancels'},key);
beforeAll(async()=>{
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.MANAGE_TOKEN_WRAP_KEY='guest-cancellation-test-key-at-least-thirty-two-characters';process.env.BOOKING_MANAGE_PAGE_ENABLED='1';
  const [owner]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id
    join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
  ctx=await buildContext({userId:owner!.user_id,membershipId:owner!.id});
  const [runtime]=await withTenant(ctx,tx=>tx`select current_user as role,(select rolbypassrls from pg_roles where rolname=current_user) as bypass`);
  expect(runtime).toEqual({role:'app_user',bypass:false});
  await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:ctx.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const cutoff=`${String((hour+12)%24).padStart(2,'0')}:00`;
  const hours=Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'00:00',close:'23:59'}]));
  await withTenant(tenant,tx=>tx`update locations set business_hours=${jsonb(hours)}::jsonb,business_day_cutoff=${cutoff}::time,
    settings=jsonb_set(jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb),'{online_booking}',
      ${jsonb({enabled:true,deposit_required:true,deposit_amount_cents:2000,min_minutes_ahead:0,cancel_cutoff_hours:4})}::jsonb)
    where id=${tenant.locationId}`);
  serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Guest A QA'},durationMin:30,basePriceCents:10000,taxable:false,onlineBookable:true})).serviceId;
  otherServiceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Guest B QA'},durationMin:30,basePriceCents:7000,taxable:false,onlineBookable:true})).serviceId;
  resources=await withTenant(tenant,async tx=>{const [type]=await tx`insert into resource_types(org_id,location_id,key,name)
    values(${tenant.orgId},${tenant.locationId},'guest-cancel-qa',${jsonb({en:'Guest cancellation QA'})}::jsonb) returning id`;
    const rows=await tx`insert into resources(org_id,location_id,resource_type_id,name,capacity)
      values(${tenant.orgId},${tenant.locationId},${type!.id},'Guest A room QA',1),(${tenant.orgId},${tenant.locationId},${type!.id},'Guest B room QA',1) returning id`;
    return rows.map(r=>r.id);});
  const [staff]=await withTenant(tenant,tx=>tx`select membership_id from staff_profiles where location_id=${tenant.locationId} and is_bookable limit 1`);staffId=staff!.membership_id;
});
afterAll(closeDb);
it('cancels one guest, reserves only their original deposit and releases their room without changing the remaining quote',async()=>{
  const {h,paymentId}=await paid(40),key=randomUUID(),result=await cancel(h,[0],1176,key);
  expect(result.remainingGuests).toBe(1);expect(result.cancelledItemIds).toHaveLength(1);
  expect(result.refunds).toEqual([{refundId:result.refunds[0]!.refundId,amountCents:1176,status:'pending'}]);
  expect(await cancel(h,[0],1176,key)).toEqual(result);await cancel(h);
  const [facts]=await withTenant(tenant,tx=>tx`select a.status,a.party_size,a.deposit_status,h.reserved_cents,
    (select sum(price_cents_snapshot)::int from appointment_items where appointment_id=a.id and status<>'cancelled') as service_cents,
    (select count(*)::int from commerce_refunds where payment_id=${paymentId}) as refunds,
    (select count(*)::int from appointment_guest_cancellations where appointment_id=a.id) as cancellations
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(facts).toEqual({status:'booked',party_size:1,deposit_status:'paid',reserved_cents:1176,service_cents:7000,refunds:1,cancellations:1});
  const detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));
  expect(detail.guests).toMatchObject([{guestIndex:0,status:'cancelled',refundableDepositCents:0,refundStatus:'pending'},
    {guestIndex:1,status:'active',serviceTotalCents:7000,refundableDepositCents:824}]);
  const shop=await resolveHostedShop('golden-foot');const managed=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop,h.appointmentId,'en'));
  expect(managed).toMatchObject({priceCents:7000,originalPriceCents:17000,deposit:{availableCents:824,serviceRemainingCents:6176,
    guestAllocation:{guests:[{guestIndex:0,cancelled:true,refundStatus:'pending'},{guestIndex:1,cancelled:false}]}}});
  const [allocation]=await withTenant(tenant,tx=>tx`select deposit_guest_allocation from commerce_refunds where id=${result.refunds[0]!.refundId}`);
  expect(allocation!.deposit_guest_allocation).toEqual([{guestIndex:0,amountCents:1176}]);
  await expect(withTenant(tenant,tx=>tx`insert into commerce_refunds(org_id,location_id,payment_id,amount_cents,reason,deposit_guest_allocation)
    values(${tenant.orgId},${tenant.locationId},${paymentId},100,'Invalid allocation QA','[{"guestIndex":0,"amountCents":99}]'::jsonb)`)).rejects.toMatchObject({code:'23514'});
  await expect(withTenant(tenant,tx=>tx`update commerce_refunds set deposit_guest_allocation='[{"guestIndex":1,"amountCents":1176}]'::jsonb where id=${result.refunds[0]!.refundId}`))
    .rejects.toMatchObject({code:'23001'});
  await expect(withTenant(tenant,tx=>tx`update appointment_guest_cancellations set reason='Rewrite history' where id=${result.cancellationIds[0]!}`))
    .rejects.toMatchObject({code:expect.stringMatching(/^(42501|23001)$/)});
  const replacement=body(future(40));replacement.appointment.partySize=1;replacement.appointment.items=[replacement.appointment.items[0]!];
  expect(await run<Hold>('commerce.holdAppointment',replacement)).toMatchObject({amountCents:2000});
  await run('commerce.confirmOfflineRefund',{refundId:result.refunds[0]!.refundId,reference:'Guest A returned cash QA'});
  expect(await withTenant(ctx,tx=>depositGuestBalances(tx,ctx,h.holdId))).toMatchObject([
    {guestIndex:0,availableCents:0,refundStatus:'succeeded'},{guestIndex:1,availableCents:824}]);
  const final=await cancel(h,[1],824);expect(final.remainingGuests).toBe(0);expect(final.refunds).toHaveLength(1);
  await run('commerce.confirmOfflineRefund',{refundId:final.refunds[0]!.refundId,reference:'Guest B returned cash QA'});
  const [end]=await withTenant(tenant,tx=>tx`select sum(amount_cents)::int as balance from commerce_deposit_ledger where hold_id=${h.holdId}`);expect(end!.balance).toBe(0);
});
it('preserves other guest money during late-cancellation review and requires an authorized reasoned approval before cash return',async()=>{
  const {h}=await paid(2),result=await cancel(h);expect(result.refunds[0]!.status).toBe('review');
  const refundId=result.refunds[0]!.refundId;
  await expect(run('commerce.confirmOfflineRefund',{refundId,reference:'Not approved'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(dispatch('commerce.approveGuestRefund',{refundId,reason:'Desk only'},{...ctx,permissions:new Set(['appointment.cancel'])},{idempotencyKey:randomUUID()}))
    .rejects.toMatchObject({code:'PERMISSION_DENIED'});
  const [before]=await withTenant(tenant,tx=>tx`select h.reserved_cents,a.deposit_status,a.status,
    (select count(*)::int from commerce_tasks where subject_id=${refundId} and kind='refund') as provider_tasks
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
  expect(before).toEqual({reserved_cents:1176,deposit_status:'paid',status:'booked',provider_tasks:0});
  const ticket=await run<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{appointmentId:h.appointmentId,customerId:null,
    items:[{serviceId:otherServiceId,membershipId:staffId}]});
  await run('ticket.startItem',{ticketItemId:ticket.ticketItemIds[0]!,membershipId:staffId});
  await run('ticket.finishItem',{ticketItemId:ticket.ticketItemIds[0]!,membershipId:staffId});
  await run('ticket.pay',{ticketId:ticket.ticketId,paymentStage:'combined',payments:[{method:'cash',amountCents:6176}],
    depositApplication:{holdId:h.holdId,amountCents:824}});
  const [application]=await withTenant(tenant,tx=>tx`select guest_allocation from commerce_deposit_ledger where hold_id=${h.holdId} and entry='applied'`);
  expect(application!.guest_allocation).toEqual([{guestIndex:1,amountCents:824}]);
  const [service]=await withTenant(tenant,tx=>tx`select subtotal_cents,discount_cents,(select sum(base_cents)::int from earnings where ticket_id=t.id) as commission_base
    from tickets t where id=${ticket.ticketId}`);expect(service).toEqual({subtotal_cents:7000,discount_cents:0,commission_base:7000});
  await run('commerce.approveGuestRefund',{refundId,reason:'Manager authorizes late QA refund'});
  await run('commerce.approveGuestRefund',{refundId,reason:'Manager authorizes late QA refund'});
  await run('commerce.confirmOfflineRefund',{refundId,reference:'Manager-approved cash return QA'});
  const [r]=await withTenant(tenant,tx=>tx`select status,approved_by,approval_reason from commerce_refunds where id=${refundId}`);
  expect(r).toEqual({status:'succeeded',approved_by:ctx.membershipId,approval_reason:'Manager authorizes late QA refund'});
  await run('ticket.refund',{ticketId:ticket.ticketId,refundAmountCents:7000,refundTipCents:0,refundMethod:'original_payment',reason:'other',notes:'QA full remaining service refund'});
  const [serviceRefund]=await withTenant(tenant,tx=>tx`select id from ticket_refunds where ticket_id=${ticket.ticketId}`);
  const [restored]=await withTenant(tenant,tx=>tx`select guest_allocation from commerce_deposit_ledger where hold_id=${h.holdId} and ticket_refund_id=${serviceRefund!.id}`);
  expect(restored!.guest_allocation).toEqual([{guestIndex:1,amountCents:824}]);
  const [source]=await withTenant(tenant,tx=>tx`select id from commerce_payments where order_id=(select order_id from commerce_appointment_holds where id=${h.holdId})`);
  const originalRefund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:source!.id,amountCents:824,depositGuestIndices:[1],reason:'Return restored guest B deposit QA'});
  await run('commerce.confirmOfflineRefund',{refundId:originalRefund.refundId,reference:'Restored guest B cash returned QA'});
  const [final]=await withTenant(tenant,tx=>tx`select (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as balance,reserved_cents
    from commerce_appointment_holds h where id=${h.holdId}`);expect(final).toEqual({balance:0,reserved_cents:0});
});
it('keeps a failed guest refund reserved in a fresh review record and does not expose it for service use',async()=>{
  const {h,paymentId}=await paid(44),result=await cancel(h),refundId=result.refunds[0]!.refundId;
  await dispatchSystem('commerce.completeRefund',{refundId,stripeRefundId:null,status:'failed',stripeAccountId:null,livemode:false,amountCents:1176},ctx,{idempotencyKey:randomUUID()});
  const refunds=await withTenant(tenant,tx=>tx`select id,status,review_required,amount_cents from commerce_refunds where payment_id=${paymentId} order by created_at,id`);
  expect(refunds.map(r=>r.status).sort()).toEqual(['failed','review']);
  const review=refunds.find(r=>r.status==='review')!;expect(review.amount_cents).toBe(1176);expect(review.review_required).toBe(true);
  const [h2]=await withTenant(tenant,tx=>tx`select reserved_cents from commerce_appointment_holds where id=${h.holdId}`);expect(h2!.reserved_cents).toBe(1176);
  await expect(withTenant(ctx,tx=>applyDepositToTicket(tx,ctx,{holdId:h.holdId,amountCents:825},{id:randomUUID(),appointmentId:h.appointmentId},7000,'combined')))
    .rejects.toMatchObject({details:{reason:'deposit_exceeds_available_balance'}});
  await run('commerce.approveGuestRefund',{refundId:review.id,reason:'Manager authorizes a fresh attempt'});
  await run('commerce.confirmOfflineRefund',{refundId:review.id,reference:'Retried cash return QA'});
  const [end]=await withTenant(tenant,tx=>tx`select reserved_cents from commerce_appointment_holds where id=${h.holdId}`);expect(end!.reserved_cents).toBe(0);
});
it('tracks a prior general partial refund and cancels only the remaining share, rejecting a stale quote',async()=>{
  const {h,paymentId}=await paid(48);
  const general=await run<{refundId:string}>('commerce.requestRefund',{paymentId,amountCents:800,reason:'General QA unused refund'});
  await run('commerce.confirmOfflineRefund',{refundId:general.refundId,reference:'General QA cash returned'});
  await expect(cancel(h)).rejects.toMatchObject({details:{reason:'deposit_guest_refund_quote_changed',amountCents:706}});
  const result=await cancel(h,[0],706);expect(result.refunds[0]!.amountCents).toBe(706);
  const [facts]=await withTenant(tenant,tx=>tx`select a.party_size,h.reserved_cents from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${h.appointmentId}`);
  expect(facts).toEqual({party_size:1,reserved_cents:706});
});
it('cancels an already waived guest without money and requires explicit reconfirmation before a pending price change',async()=>{
  const h=await run<Hold>('commerce.holdAppointment',body(future(52)));
  await expect(cancel(h,[0],0)).rejects.toMatchObject({details:{reason:'deposit_quote_reconfirmation_required'}});
  await run('commerce.waiveAppointmentDeposit',{holdId:h.holdId,reason:'Manager waives QA booking deposit'});
  expect((await cancel(h,[0],0)).refunds).toEqual([]);
  expect(await withTenant(tenant,tx=>tx`select id from commerce_deposit_ledger where hold_id=${h.holdId}`)).toHaveLength(0);
  const foreign={...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'};
  expect(await withTenant(foreign,tx=>tx`select id from appointment_guest_cancellations where appointment_id=${h.appointmentId}`)).toHaveLength(0);
  await expect(dispatch('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[1],expectedRefundCents:0,reason:'Foreign attempt'},foreign,{idempotencyKey:randomUUID()}))
    .rejects.toMatchObject({code:'NOT_FOUND'});
});
it('keeps shared execution services intact until all their participating guests are explicitly selected',async()=>{
  const service=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Shared couple cancellation QA'},durationMin:30,basePriceCents:10000,
    staffCount:2,guestCount:2,taxable:false})).serviceId;
  const staff=await withTenant(tenant,tx=>tx`select membership_id from staff_profiles where location_id=${tenant.locationId} and is_bookable limit 2`);
  const h=await run<Hold>('commerce.holdAppointment',{businessKey:randomUUID(),appointment:{source:'desk',partySize:2,customerId:null,
    override:{reason:'desk_coordination'},items:[{serviceId:service,startsAt:future(56),membershipId:staff[0]!.membership_id,
      additionalMembershipIds:[staff[1]!.membership_id],details:{publicGuestIndices:[0,1]}}]}});
  await run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Shared service cash QA'});
  await expect(cancel(h,[0],1000)).rejects.toMatchObject({details:{reason:'shared_service_requires_all_guests',guestIndices:[0,1]}});
  expect(await withTenant(tenant,tx=>tx`select id from appointment_guest_cancellations where appointment_id=${h.appointmentId}`)).toHaveLength(0);
  const all=await cancel(h,[1,0],2000);expect(all.remainingGuests).toBe(0);expect(all.cancelledItemIds).toHaveLength(2);
  expect(all.refunds).toEqual([{refundId:all.refunds[0]!.refundId,amountCents:2000,status:'pending'}]);
});
it('allows two simultaneous cancellation requests to reserve one guest share once and guards refund context in SQL',async()=>{
  const {h,paymentId}=await paid(60);
  const [one,two]=await Promise.all([cancel(h),cancel(h)]);expect(one.cancellationIds).toEqual(two.cancellationIds);
  const [fact]=await withTenant(tenant,tx=>tx`select reserved_cents,(select count(*)::int from commerce_refunds where payment_id=${paymentId}) as refunds
    from commerce_appointment_holds where id=${h.holdId}`);expect(fact).toEqual({reserved_cents:1176,refunds:1});
  await expect(withTenant(tenant,tx=>tx`insert into commerce_refunds(org_id,location_id,payment_id,amount_cents,reason,deposit_guest_allocation,guest_cancellation_id)
    values(${tenant.orgId},${tenant.locationId},${paymentId},1,'Wrong guest SQL QA','[{"guestIndex":1,"amountCents":1}]'::jsonb,${one.cancellationIds[0]!})`))
    .rejects.toMatchObject({code:'23001'});
});

async function customerHold(hours=72){
  const input=body(future(hours)),token=`mt_${randomUUID()}`;
  const h=await run<Hold>('commerce.holdAppointment',{...input,appointment:{...input.appointment,guest:{manageToken:token,
    bookingSmsConsent:false,customer:{name:'Customer guest cancellation QA',email:'guest-cancel@example.test',phoneE164:'+12025550134'}}}});
  await run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:`Public guest cancellation ${h.holdId}`});
  return {h,token};
}
it('authenticates customer partial cancellation by token and last4 and keeps customer provenance without a staff actor',async()=>{
  const {h,token}=await customerHold(),shop=await resolveHostedShop('golden-foot'),app=buildServer();await app.ready();__resetRateLimit();
  const input={manageToken:token,last4:'0134',requestId:randomUUID(),guestIndices:[0],expectedRefundCents:1176,reason:'Customer selects one guest'};
  const send=(extra:Record<string,unknown>={})=>app.inject({method:'POST',url:`/public/v1/bookings/${h.appointmentId}/cancel-guests`,
    headers:{origin:'https://book.geniefront.com','x-gf-public-key':shop.publicKey},payload:{...input,...extra}});
  try{
    expect((await send({manageToken:`mt_${randomUUID()}`})).statusCode).toBe(404);
    const wrong=await send({last4:'9999'});expect(wrong.statusCode).toBe(403);expect(wrong.json().details.reason).toBe('last4_mismatch');
    const stale=await send({expectedRefundCents:1175});expect(stale.statusCode).toBe(400);expect(stale.json().details.reason).toBe('deposit_guest_refund_quote_changed');
    expect(await withTenant(tenant,tx=>tx`select id from appointment_guest_cancellations where appointment_id=${h.appointmentId}`)).toHaveLength(0);
    const result=await send();expect(result.statusCode).toBe(200);expect(result.json()).toEqual({bookingId:h.appointmentId,status:'booked',remainingGuests:1,replayed:false});
    expect((await send()).json().replayed).toBe(true);
    expect((await send({reason:'Changed financial intent'})).statusCode).toBe(409);
    const [record]=await withTenant(tenant,tx=>tx`select created_by,actor_source from appointment_guest_cancellations where appointment_id=${h.appointmentId}`);
    expect(record).toEqual({created_by:null,actor_source:'customer'});
    const [audit]=await withTenant(tenant,tx=>tx`select actor_id,actor_kind from audit_log where command='appointment.cancelGuests' and entity_id=${h.appointmentId} order by at desc limit 1`);
    expect(audit).toEqual({actor_id:null,actor_kind:'api'});
    const [money]=await withTenant(tenant,tx=>tx`select reserved_cents from commerce_appointment_holds where id=${h.holdId}`);expect(money!.reserved_cents).toBe(1176);
    const detail=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop,h.appointmentId,'en'));
    expect(detail).toMatchObject({priceCents:7000,guests:[{guestIndex:0,status:'cancelled'},{guestIndex:1,status:'active',refundableDepositCents:824}]});
    const finalInput={requestId:randomUUID(),guestIndices:[1],expectedRefundCents:824};
    expect((await send(finalInput)).json()).toMatchObject({status:'cancelled',remainingGuests:0});
    expect((await send(finalInput)).json().replayed).toBe(true);
    // Existing outboxKind intentionally groups cancellation into appointment_changed.
    // One partial change + one final cancellation, with both command retries, produce two notices.
    const [notices]=await withTenant(tenant,tx=>tx`select count(*)::int as n
      from email_outbox where entity_id=${h.appointmentId} and entity_type like 'appointment:%' and kind='appointment_changed'`);
    expect(notices!.n).toBe(2);
  }finally{await app.close();}
});
it('rechecks customer token and phone under the command lock and rejects public contexts without the verified resource',async()=>{
  const {h,token}=await customerHold(76),shop=await resolveHostedShop('golden-foot'),publicCtx=publicContext(shop,'en');
  const input={appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:1176,reason:'Customer command QA'};
  await expect(dispatch('appointment.cancelGuests',input,publicCtx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  publicCtx.verifiedManagedBooking={appointmentId:h.appointmentId,manageTokenDigest:hashManageToken(token),verifiedPhoneDigest:managedPhoneDigest('+12025550134')};
  await expect(dispatch('appointment.cancelGuests',input,{...publicCtx,verifiedManagedBooking:{...publicCtx.verifiedManagedBooking,appointmentId:randomUUID()}},
    {idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
  await withTenant(tenant,tx=>tx`update appointments set manage_token_digest=${hashManageToken('revoked-token')} where id=${h.appointmentId}`);
  await expect(dispatch('appointment.cancelGuests',input,publicCtx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
  await withTenant(tenant,tx=>tx`update appointments set manage_token_digest=${hashManageToken(token)} where id=${h.appointmentId}`);
  await expect(dispatch('appointment.cancelGuests',input,{...publicCtx,verifiedManagedBooking:{...publicCtx.verifiedManagedBooking,verifiedPhoneDigest:managedPhoneDigest('+12025550000')}},
    {idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await withTenant(tenant,tx=>tx`select id from appointment_guest_cancellations where appointment_id=${h.appointmentId}`)).toHaveLength(0);
});
it('keeps the original cancellation deadline enforced for customer partial changes after store policy changes',async()=>{
  const {h,token}=await customerHold(1),shop=await resolveHostedShop('golden-foot'),publicCtx=publicContext(shop,'en');
  await withTenant(tenant,tx=>tx`update appointments set created_at=now()-interval '1 hour' where id=${h.appointmentId}`);
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositAmountCents:2000,cancelCutoffHours:0});
  publicCtx.verifiedManagedBooking={appointmentId:h.appointmentId,manageTokenDigest:hashManageToken(token),verifiedPhoneDigest:managedPhoneDigest('+12025550134')};
  await expect(dispatch('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:1176,reason:'Late public cancellation'},publicCtx,
    {idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED',details:{reason:'cancel_cutoff_passed'}});
  expect(await withTenant(tenant,tx=>tx`select id from appointment_guest_cancellations where appointment_id=${h.appointmentId}`)).toHaveLength(0);
});
