import Fastify from 'fastify';
import {registerTicketsRoutes} from './routes/tickets';
import {flushEmails} from './email/flush';
import {currentVoiceBooking} from './voice/deposit';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {expireStageDepositRequest} from '../../../packages/db/test/depositRequestClock';
import {withTenant,closeDb,jsonb,readOnlineBooking} from '@gf/db';
import type {DepositAdjustmentQuote} from '@gf/contracts';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {quoteAppointmentDeposit} from '@gf/payroll';
import {addDays,businessDateOf,wallMinuteToInstant} from '@gf/scheduling';
import {appointmentDepositPolicy} from './commerce/depositPolicy';
import {loadDepositAdjustmentQuote} from './commerce/depositAdjustmentQuote';
import {depositPaymentSources} from './commerce/depositSources';
import {depositGuestBalances} from './commerce/depositGuests';
import {loadAppointmentDetail} from './queries/appointmentDetail';
import {loadManagedBookingDetail} from './public/managedDetail';
import {resolveHostedShop} from './public/publicAuth';
import {applyDepositToTicket,restoreTicketDeposit} from './handlers/appointmentDepositPayments';
import './handlers/bookingPolicy';import './handlers/staff';import './handlers/appointmentDepositRetention';
import './handlers/commerce';import './handlers/appointmentDeposits';import './handlers/setup';import './handlers/billing';import './handlers/ticket';
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>,serviceId:string,extraId:string,smallId:string,staffId:string;
interface Hold{holdId:string;appointmentId:string;amountCents:number;serviceTotalCents:number;expiresAt:string;}
interface Order{orderId:string;paymentId:string;assetId:string|null;status:string;}
const run=async<T=unknown>(name:string,input:unknown,key=randomUUID())=>(await dispatch<T>(name,input,ctx,{idempotencyKey:key})).result;
let futureSlot=0;
// Web-source fixtures must stay inside shop hours regardless of the time the
// suite starts or a DST boundary. Keep distinct slots without drifting to 01:00.
const future=()=>{
 const index=futureSlot++,timezone='America/Los_Angeles';
 const date=addDays(businessDateOf(new Date(),timezone,'03:00'),10+Math.floor(index/4));
 return wallMinuteToInstant(date,timezone,600+(index%4)*120).toISOString();
};
async function hold(two=false,startsAt=future(),email=false){
 const [loc]=await withTenant(tenant,tx=>tx`select settings from locations where id=${tenant.locationId}`),policy=appointmentDepositPolicy(readOnlineBooking(loc!.settings));
 const total=two?15000:10000,amount=quoteAppointmentDeposit(total,policy.method==='percentage'?{percentBps:policy.percentBps!}:{fixedAmountCents:policy.fixedAmountCents!});
 return run<Hold>('commerce.holdAppointment',{businessKey:randomUUID(),depositConsent:{accepted:true,policyVersion:policy.version,serviceTotalCents:total,amountCents:amount},appointment:{source:email?'web':'desk',partySize:two?2:1,customerId:null,
 ...(email?{guest:{manageToken:`mt_${randomUUID()}`,bookingSmsConsent:false,customer:{name:'Adjustment mail QA',email:'adjustment-mail@example.test',phoneE164:'+12025550989'}}}:{}),
 walkInName:'Adjustment isolated QA',override:{reason:'desk_coordination'},items:[{serviceId,startsAt,details:email?{}:{publicGuestIndex:0}},...(two?[{serviceId:extraId,startsAt,details:{publicGuestIndex:1}}]:[])]}});}
const start=(h:Hold)=>run<Order>('commerce.startDepositCheckout',{holdId:h.holdId});
async function payment(orderId:string,amountCents:number){return (await dispatchSystem<Order>('commerce.recordPayment',{orderId,stripeAccountId:'acct_AdjustmentFixture',livemode:false,
 eventId:`evt_${randomUUID()}`,eventType:'checkout.session.completed',sessionId:`cs_${orderId}`,paymentIntentId:`pi_${orderId}`,amountCents,currency:'usd'},ctx,{idempotencyKey:randomUUID()})).result;}
async function preview(name:string,input:Record<string,unknown>){
 try{await run(name,input);throw new Error('Expected explicit quote confirmation');}
 catch(e){expect(e).toMatchObject({code:'VALIDATION_FAILED',details:{reason:'deposit_quote_reconfirmation_required'}});return (e as {details:{depositQuote:DepositAdjustmentQuote}}).details.depositQuote;}
}
async function add(h:Hold,service=extraId){const input={appointmentId:h.appointmentId,serviceId:service,guestIndex:0,override:{reason:'desk_coordination'}};
 const quote=await preview('appointment.addItem',input);const key=randomUUID();
 const result=await run('appointment.addItem',{...input,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}},key);
 expect(await run('appointment.addItem',{...input,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}},key)).toEqual(result);
 const requests=await withTenant(tenant,tx=>tx`select r.*,o.amount_cents,p.id as payment_id from commerce_deposit_requests r join commerce_orders o on o.id=r.order_id
  join commerce_payments p on p.order_id=r.order_id where r.hold_id=${h.holdId} order by r.created_at,r.order_id`);
 return {quote,result,request:requests.find(r=>r.state==='open')!};}
async function complete(refundId:string,amountCents:number,provider='stripe'){
 if(provider==='offline')return run('commerce.confirmOfflineRefund',{refundId,reference:`Return ${refundId}`});
 return dispatchSystem('commerce.completeRefund',{refundId,amountCents,status:'succeeded',stripeRefundId:`re_${refundId}`,stripeAccountId:'acct_AdjustmentFixture',livemode:false},ctx,{idempotencyKey:randomUUID()});
}
beforeAll(async()=>{
 process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.COMMERCE_STRIPE_MODE='test';process.env.STRIPE_SECRET_KEY='sk_test_adjustment_fixture';
 process.env.MANAGE_TOKEN_WRAP_KEY='adjustment-fixture-wrapping-key-at-least-thirty-two';process.env.BOOKING_MANAGE_PAGE_ENABLED='1';
 const [owner]=await withTenant(tenant,tx=>tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
 ctx=await buildContext({userId:owner!.user_id,membershipId:owner!.id});await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
 await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
 await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_AdjustmentFixture',livemode:false,chargesEnabled:true,payoutsEnabled:true,detailsSubmitted:true,capabilities:{card_payments:'active'}},ctx,{idempotencyKey:randomUUID()});
 await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000,cancelCutoffHours:4,retainDepositAfterCutoff:false});
 await run('location.saveHours',{hours:Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'00:00',close:'23:59'}]))});
 await run('location.saveBookingPolicy',{mode:'location',baseCapacity:10,bufferEnabled:false,bufferExtra:1,requestBufferEnabled:false,requestBufferExtra:1});
 await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb) where id=${tenant.locationId}`);
 serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Adjustment original QA'},durationMin:30,basePriceCents:10000,taxable:false})).serviceId;
 extraId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Adjustment extra QA'},durationMin:30,basePriceCents:5000,taxable:false})).serviceId;
 smallId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Adjustment small QA'},durationMin:30,basePriceCents:100,taxable:false})).serviceId;
 const [staff]=await withTenant(tenant,tx=>tx`select membership_id as id from staff_profiles where location_id=${tenant.locationId} and is_bookable limit 1`);staffId=staff!.id;
});
afterAll(closeDb);

it('replaces an unpaid quote only after exact confirmation and refunds a late obsolete charge without cancelling the replacement booking',async()=>{
 const h=await hold(),original=await start(h),base={appointmentId:h.appointmentId,serviceId:extraId,guestIndex:0,override:{reason:'desk_coordination'}};
 const q=await preview('appointment.addItem',base);expect(q).toMatchObject({serviceTotalCents:15000,requiredCents:3000,availableCents:0,requestCents:3000,purpose:'replacement',expiresAt:h.expiresAt});
 const [before]=await withTenant(tenant,tx=>tx`select (select count(*)::int from appointment_items where appointment_id=${h.appointmentId}) as items,
  (select count(*)::int from commerce_deposit_requests where hold_id=${h.holdId}) as requests,(select count(*)::int from commerce_deposit_requotes where hold_id=${h.holdId}) as quotes`);
 expect(before).toEqual({items:1,requests:1,quotes:0});
 const {request}=await add(h);expect(request).toMatchObject({purpose:'replacement',amount_cents:3000});
 expect(new Date(request.expires_at).toISOString()).toBe(h.expiresAt);
 const [originalContract]=await withTenant(tenant,tx=>tx`select amount_cents,service_total_cents,order_id from commerce_appointment_holds where id=${h.holdId}`);
 expect(originalContract).toEqual({amount_cents:2000,service_total_cents:10000,order_id:original.orderId});
 expect(await payment(original.orderId,2000)).toMatchObject({status:'refund_pending'});
 let detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail).toMatchObject({status:'booked',deposit:{status:'pending',amountCents:3000,availableCents:0}});
 expect(await payment(request.order_id,3000)).toMatchObject({status:'fulfilled'});await payment(request.order_id,3000);await payment(original.orderId,2000);
 const [refund]=await withTenant(tenant,tx=>tx`select id,amount_cents,reason from commerce_refunds where payment_id=${original.paymentId}`);
 expect(refund).toMatchObject({amount_cents:2000,reason:'deposit_payment_after_requote'});await complete(refund!.id,2000);
 detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail).toMatchObject({status:'booked',deposit:{status:'paid',availableCents:3000}});
 const sources=await withTenant(ctx,tx=>depositPaymentSources(tx,ctx,h.holdId));expect(sources.map(s=>({state:s.requestState,balance:s.balanceCents,available:s.availableCents})))
  .toEqual([{state:'superseded',balance:0,available:0},{state:'paid',balance:3000,available:3000}]);
});
it('adds a separately paid supplement without rewriting the original contract or charging from the service-change command',async()=>{
 const h=await hold(),original=await start(h);await payment(original.orderId,2000);
 const {quote,request}=await add(h);expect(quote).toMatchObject({serviceTotalCents:15000,requiredCents:3000,availableCents:2000,requestCents:1000,purpose:'supplement'});
 let detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail.deposit).toMatchObject({status:'paid',availableCents:2000,paymentRequest:{purpose:'supplement',amountCents:1000,state:'open'}});
 const shop=await resolveHostedShop('golden-foot');const managed=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop!,h.appointmentId,'en'));
 expect(managed).toMatchObject({status:'booked',deposit:{status:'paid',availableCents:2000,serviceRemainingCents:13000,additionalPayment:{amountCents:1000,state:'open'}}});
 await payment(request.order_id,1000);await payment(request.order_id,1000);
 detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail.deposit).toMatchObject({status:'paid',availableCents:3000});
 const guests=await withTenant(ctx,tx=>depositGuestBalances(tx,ctx,h.holdId));expect(guests).toMatchObject([{guestIndex:0,amountCents:3000,availableCents:3000}]);
 const [counts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from commerce_deposit_ledger where hold_id=${h.holdId} and entry='collected') as collections,
  (select count(*)::int from commerce_refunds where payment_id in(${original.paymentId},${request.payment_id})) as refunds`);expect(counts).toEqual({collections:2,refunds:0});
});
it('expires only an unpaid supplementary request and keeps the originally confirmed reservation and paid balance',async()=>{
 const h=await hold(),original=await start(h);await payment(original.orderId,2000);const {request}=await add(h);
 // This isolated fixture changes only the test deadline; the production guard remains enabled for all app operations.
 await expireStageDepositRequest(request.order_id);
 const expiry=await dispatchSystem('commerce.expireDepositRequest',{orderId:request.order_id},ctx,{idempotencyKey:randomUUID()});expect(expiry.result).toEqual({expired:true});
 const [retained]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as hold_status,
  (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as balance from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
 expect(retained).toEqual({status:'booked',deposit_status:'paid',hold_status:'paid',balance:2000});
 await run('appointment.cancel',{appointmentId:h.appointmentId,reason:'guest_changed_mind',keepStaffTurn:false});
 const [state]=await withTenant(tenant,tx=>tx`select r.state,o.status,p.status as payment_status from commerce_deposit_requests r join commerce_orders o on o.id=r.order_id join commerce_payments p on p.order_id=r.order_id where r.order_id=${request.order_id}`);
 expect(state).toEqual({state:'cancelled',status:'canceled',payment_status:'failed'});
 expect(await payment(request.order_id,1000)).toMatchObject({status:'refund_pending'});
 const [appt]=await withTenant(tenant,tx=>tx`select status from appointments where id=${h.appointmentId}`);expect(appt!.status).toBe('cancelled');
});
it('reconfirms the reduced pending amount when one guest cancels, preserving original guest indices and the initial contract',async()=>{
 const h=await hold(true),original=await start(h),body={appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:0,reason:'One unpaid guest leaves'};
 const quote=await preview('appointment.cancelGuests',body);expect(quote).toMatchObject({serviceTotalCents:5000,requiredCents:1000,requestCents:1000});
 const out=await run<{remainingGuests:number;refunds:unknown[]}>('appointment.cancelGuests',{...body,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}});
 expect(out).toMatchObject({remainingGuests:1,refunds:[]});
 const [request]=await withTenant(tenant,tx=>tx`select r.order_id,o.amount_cents,o.snapshot from commerce_deposit_requests r join commerce_orders o on o.id=r.order_id where r.hold_id=${h.holdId} and r.state='open'`);
 expect(request!.amount_cents).toBe(1000);expect(request!.snapshot.depositPolicy.guestAllocation.guests).toEqual([
  {guestIndex:0,serviceTotalCents:0,amountCents:0},{guestIndex:1,serviceTotalCents:5000,amountCents:1000}]);
 await payment(request!.order_id,1000);
 const [contract]=await withTenant(tenant,tx=>tx`select amount_cents,order_id from commerce_appointment_holds where id=${h.holdId}`);expect(contract).toEqual({amount_cents:3000,order_id:original.orderId});
 expect(await withTenant(ctx,tx=>depositGuestBalances(tx,ctx,h.holdId))).toMatchObject([{guestIndex:0,availableCents:0},{guestIndex:1,availableCents:1000}]);
});
it('rejects a second independently keyed service edit using a stale monetary quote instead of adding another service or request',async()=>{
 const h=await hold(),order=await start(h);await payment(order.orderId,2000);
 const input={appointmentId:h.appointmentId,serviceId:extraId,guestIndex:0,override:{reason:'desk_coordination'}},quote=await preview('appointment.addItem',input);
 const body={...input,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}};
 const results=await Promise.allSettled([run('appointment.addItem',body),run('appointment.addItem',body)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({details:{reason:'deposit_quote_reconfirmation_required'}});
 const [facts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from appointment_items where appointment_id=${h.appointmentId} and status='booked') as items,
  (select count(*)::int from commerce_deposit_requests where hold_id=${h.holdId} and state='open') as requests`);expect(facts).toEqual({items:2,requests:1});
});
it('records a supplementary offline receipt once and refuses a changed receipt or an amount from the original deposit',async()=>{
 const h=await hold();await run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:`Original ${h.holdId}`});
 const {request}=await add(h);const receipt={holdId:h.holdId,orderId:request.order_id,amountCents:1000,method:'external',reference:'Additional terminal receipt'};
 await expect(run('commerce.recordOfflineDeposit',{...receipt,amountCents:2000})).rejects.toMatchObject({details:{reason:'deposit_amount_mismatch'}});
 const one=await run<Order>('commerce.recordOfflineDeposit',receipt),two=await run<Order>('commerce.recordOfflineDeposit',receipt);expect(two).toEqual(one);
 await expect(run('commerce.recordOfflineDeposit',{...receipt,reference:'Another receipt'})).rejects.toMatchObject({details:{reason:'deposit_receipt_changed'}});
 expect((await withTenant(ctx,tx=>depositPaymentSources(tx,ctx,h.holdId))).reduce((n,p)=>n+p.availableCents,0)).toBe(3000);
});
it('does not authorize a refund against an exhausted original payment just because a supplement remains unused',async()=>{
 const h=await hold(false,new Date(Date.now()+10*60000).toISOString()),original=await start(h);await payment(original.orderId,2000);const {request}=await add(h);await payment(request.order_id,1000);
 const ticket=await run<{ticketId:string}>('ticket.open',{appointmentId:h.appointmentId,customerId:null,items:[{serviceId,membershipId:staffId},{serviceId:extraId,membershipId:staffId}]});
 await withTenant(ctx,tx=>applyDepositToTicket(tx,ctx,{holdId:h.holdId,amountCents:2000},{id:ticket.ticketId,appointmentId:h.appointmentId},15000,'service'));
 await expect(run('commerce.requestRefund',{paymentId:original.paymentId,amountCents:1,reason:'Cannot borrow another deposit source'})).rejects.toMatchObject({details:{reason:'refund_exceeds_unused_deposit'}});
 const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:request.payment_id,amountCents:1000,reason:'Return the unused supplementary payment'});await complete(refund.refundId,1000);
 const [spent]=await withTenant(tenant,tx=>tx`select payment_id,amount_cents from commerce_deposit_ledger where hold_id=${h.holdId} and entry='applied'`);
 expect(spent).toEqual({payment_id:original.paymentId,amount_cents:-2000});
 const [source]=await withTenant(tenant,tx=>tx`select deposit_commerce_payment_id from payments where ticket_id=${ticket.ticketId} and method='deposit'`);expect(source!.deposit_commerce_payment_id).toBe(original.paymentId);
});


it('preserves the old service and contract, exposes only policy excess after a cheaper replacement, and refunds its original payment',async()=>{
 const h=await hold(),original=await start(h);await payment(original.orderId,2000);
 const [old]=await withTenant(tenant,tx=>tx`select id from appointment_items where appointment_id=${h.appointmentId}`);
 const input={appointmentId:h.appointmentId,itemId:old!.id,serviceId:smallId};
 const quote=await preview('appointment.replaceItem',input);expect(quote).toMatchObject({serviceTotalCents:100,requiredCents:20,availableCents:2000,requestCents:0,excessCents:1980});
 await run('appointment.replaceItem',{...input,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}});
 const items=await withTenant(tenant,tx=>tx`select status,price_cents_snapshot from appointment_items where appointment_id=${h.appointmentId} order by seq`);
 expect(items).toEqual([{status:'cancelled',price_cents_snapshot:10000},{status:'booked',price_cents_snapshot:100}]);
 const current=await withTenant(ctx,tx=>loadDepositAdjustmentQuote(tx,ctx,h.holdId));
 await expect(run('commerce.refundExcessDeposit',{holdId:h.holdId,quoteHash:current.quote.quoteHash,amountCents:1981,reason:'Cannot refund beyond agreed policy excess'})).rejects.toMatchObject({details:{reason:'deposit_excess_quote_changed'}});
 const key=randomUUID(),body={holdId:h.holdId,quoteHash:current.quote.quoteHash,amountCents:1980,reason:'Customer approves policy excess refund'};
 const result=await run<{refunds:Array<{refundId:string;amountCents:number}>}>('commerce.refundExcessDeposit',body,key);expect(await run('commerce.refundExcessDeposit',body,key)).toEqual(result);
 expect(result.refunds).toHaveLength(1);await complete(result.refunds[0]!.refundId,1980);
 const [source]=await withTenant(tenant,tx=>tx`select payment_id,amount_cents from commerce_refunds where id=${result.refunds[0]!.refundId}`);expect(source).toEqual({payment_id:original.paymentId,amount_cents:1980});
 const detail=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(detail.deposit).toMatchObject({availableCents:20,adjustmentQuote:{excessCents:0,requestCents:0}});
 const [contract]=await withTenant(tenant,tx=>tx`select amount_cents,service_total_cents,order_id from commerce_appointment_holds where id=${h.holdId}`);expect(contract).toEqual({amount_cents:2000,service_total_cents:10000,order_id:original.orderId});
});
it('restores two original deposit payment sources according to the service refund allocation, without turning either into cash',async()=>{
 const h=await hold(false,new Date(Date.now()+12*60000).toISOString()),original=await start(h);await payment(original.orderId,2000);const {request}=await add(h);await payment(request.order_id,1000);
 await withTenant(tenant,tx=>tx`update location_checkout_settings set checkout_timing='after_service_combined',sales_tax_rate_percent=0 where location_id=${tenant.locationId}`);
 const ticket=await run<{ticketId:string}>('ticket.open',{appointmentId:h.appointmentId,customerId:null,items:[{serviceId,membershipId:staffId},{serviceId:extraId,membershipId:staffId}]});
 const items=await withTenant(tenant,tx=>tx`select id from ticket_items where ticket_id=${ticket.ticketId} order by seq`);
 for(const item of items){await run('ticket.startItem',{ticketItemId:item.id,membershipId:staffId,override:{reason:'desk_coordination'}});await run('ticket.finishItem',{ticketItemId:item.id,membershipId:staffId});}
 const payInput={ticketId:ticket.ticketId,payments:[{method:'cash',amountCents:12000}],depositApplication:{holdId:h.holdId,amountCents:3000}};
 await run('ticket.pay',payInput);
 const sources=await withTenant(tenant,tx=>tx`select deposit_commerce_payment_id,amount_cents from payments where ticket_id=${ticket.ticketId} and method='deposit' order by amount_cents desc`);
 expect(sources).toEqual([{deposit_commerce_payment_id:original.paymentId,amount_cents:2000},{deposit_commerce_payment_id:request.payment_id,amount_cents:1000}]);
 const refund={ticketId:ticket.ticketId,refundAmountCents:3000,refundTipCents:0,refundMethod:'original_payment',reason:'other',notes:'Return parts of both original deposit sources'};
 await run('ticket.refund',refund);
 const first=await withTenant(tenant,tx=>tx`select payment_id,amount_cents from commerce_deposit_ledger where hold_id=${h.holdId} and entry='restored' order by amount_cents desc`);
 expect(first).toEqual([{payment_id:original.paymentId,amount_cents:400},{payment_id:request.payment_id,amount_cents:200}]);
 await run('ticket.refund',{...refund,refundAmountCents:12000});
 const end=await withTenant(ctx,tx=>depositPaymentSources(tx,ctx,h.holdId));expect(end.map(s=>({id:s.paymentId,available:s.availableCents})))
  .toEqual([{id:original.paymentId,available:2000},{id:request.payment_id,available:1000}]);
 const [money]=await withTenant(tenant,tx=>tx`select sum(cash_cents)::int as cash,sum(deposit_cents)::int as deposits,sum(amount_cents)::int as total from ticket_refunds where ticket_id=${ticket.ticketId}`);
 expect(money).toEqual({cash:12000,deposits:3000,total:15000});
});
it('cancels a guest funded by two deposit payments and refunds each original source only for that guest',async()=>{
 const h=await hold(true),original=await start(h);await payment(original.orderId,3000);const {request}=await add(h);await payment(request.order_id,1000);
 const result=await run<{refunds:Array<{refundId:string;amountCents:number}>}>('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:3000,reason:'Cancel guest with two original payments'});
 expect(result.refunds.map(r=>r.amountCents)).toEqual([2000,1000]);
 for(const r of result.refunds)await complete(r.refundId,r.amountCents);
 const refunds=await withTenant(tenant,tx=>tx`select payment_id,amount_cents,deposit_guest_allocation from commerce_refunds where id=any(${result.refunds.map(r=>r.refundId)}::uuid[]) order by amount_cents desc`);
 expect(refunds).toEqual([{payment_id:original.paymentId,amount_cents:2000,deposit_guest_allocation:[{guestIndex:0,amountCents:2000}]},
  {payment_id:request.payment_id,amount_cents:1000,deposit_guest_allocation:[{guestIndex:0,amountCents:1000}]}]);
 expect(await withTenant(ctx,tx=>depositGuestBalances(tx,ctx,h.holdId))).toMatchObject([{guestIndex:0,availableCents:0},{guestIndex:1,availableCents:1000}]);
});
it('keeps quoting the original policy and rolls back the service change when a new online supplement cannot be collected',async()=>{
 const h=await hold(),original=await start(h);await payment(original.orderId,2000);
 await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'fixed',depositAmountCents:15000});
 const body={appointmentId:h.appointmentId,serviceId:extraId,guestIndex:0,override:{reason:'desk_coordination'}},quote=await preview('appointment.addItem',body);
 expect(quote).toMatchObject({requiredCents:3000,requestCents:1000});
 await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_AdjustmentFixture',livemode:false,chargesEnabled:false,payoutsEnabled:false,detailsSubmitted:false,capabilities:{card_payments:'inactive'}},ctx,{idempotencyKey:randomUUID()});
 try{await expect(run('appointment.addItem',{...body,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}})).rejects.toMatchObject({details:{reason:'merchant_payments_unavailable'}});
  const [facts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from appointment_items where appointment_id=${h.appointmentId}) as items,
   (select count(*)::int from commerce_deposit_requests where hold_id=${h.holdId}) as requests`);expect(facts).toEqual({items:1,requests:1});
 }finally{
  await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_AdjustmentFixture',livemode:false,chargesEnabled:true,payoutsEnabled:true,detailsSubmitted:true,capabilities:{card_payments:'active'}},ctx,{idempotencyKey:randomUUID()});
  await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000});
 }
});


it('keeps zero-required replacements confirmed without manufacturing payment and refunds any obsolete in-flight charge',async()=>{
 const free=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'No-charge changed service QA'},durationMin:30,basePriceCents:0,taxable:false})).serviceId;
 const h=await hold(),original=await start(h),[item]=await withTenant(tenant,tx=>tx`select id from appointment_items where appointment_id=${h.appointmentId}`);
 const body={appointmentId:h.appointmentId,itemId:item!.id,serviceId:free},quote=await preview('appointment.replaceItem',body);
 expect(quote).toMatchObject({serviceTotalCents:0,requiredCents:0,requestCents:0});
 await run('appointment.replaceItem',{...body,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}});
 const [before]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as financial_status,(select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as ledger
  from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${h.holdId}`);
 expect(before).toEqual({status:'booked',deposit_status:'not_required',financial_status:'not_required',ledger:0});
 await payment(original.orderId,2000);const [refund]=await withTenant(tenant,tx=>tx`select id from commerce_refunds where payment_id=${original.paymentId}`);await complete(refund!.id,2000);
 expect((await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId))).deposit).toMatchObject({status:'not_required',availableCents:0});
});
it('retains and releases selected guest money across two payments without moving money between the original sources',async()=>{
 await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000,retainDepositAfterCutoff:true,cancelCutoffHours:4});
 const h=await hold(true,new Date(Date.now()+2*3600000).toISOString()),original=await start(h);await payment(original.orderId,3000);
 const {request}=await add(h);await payment(request.order_id,1000);
 await run('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000,retainDepositAfterCutoff:false,cancelCutoffHours:4});
 await run('appointment.cancelGuests',{appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:3000,reason:'Late cancellation with two original payments'});
 const retained=await run<{retentionId:string;retentionIds?:string[]}>('commerce.retainAppointmentDeposit',{holdId:h.holdId,guestIndices:[0],expectedGuestBalances:[{guestIndex:0,availableCents:3000}],amountCents:2500,reason:'Approved original-policy retention'});
 expect(retained.retentionIds).toHaveLength(2);
 const decisions=await withTenant(tenant,tx=>tx`select id,payment_id,amount_cents from commerce_deposit_retentions where hold_id=${h.holdId} order by amount_cents desc`);
 expect(decisions.map(r=>({paymentId:r.payment_id,amount:r.amount_cents}))).toEqual([{paymentId:original.paymentId,amount:2000},{paymentId:request.payment_id,amount:500}]);
 for(const decision of decisions){const release=await run<{refundId:string}>('commerce.releaseDepositRetention',{retentionId:decision.id,expectedRemainingCents:decision.amount_cents,amountCents:decision.amount_cents,reason:'Return this original retained source'});await complete(release.refundId,decision.amount_cents);}
 const [remaining]=await withTenant(tenant,tx=>tx`select id,amount_cents from commerce_refunds where payment_id=${request.payment_id} and status='review'`);
 expect(remaining!.amount_cents).toBe(500);await run('commerce.approveGuestRefund',{refundId:remaining!.id,reason:'Approve remaining guest refund'});await complete(remaining!.id,500);
 const sources=await withTenant(ctx,tx=>depositPaymentSources(tx,ctx,h.holdId));expect(sources.map(s=>({paymentId:s.paymentId,balance:s.balanceCents,available:s.availableCents})))
  .toEqual([{paymentId:original.paymentId,balance:1000,available:1000},{paymentId:request.payment_id,balance:0,available:0}]);
 const [totals]=await withTenant(tenant,tx=>tx`select (select sum(amount_cents)::int from commerce_deposit_retentions where hold_id=${h.holdId}) as retained,
  (select sum(amount_cents)::int from commerce_deposit_retention_releases where hold_id=${h.holdId}) as released,
  (select -sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${h.holdId} and entry='refund') as refunded`);
 expect(totals).toEqual({retained:2500,released:2500,refunded:3000});
});
it('keeps the hold frozen until disputes on both original payment sources have been resolved',async()=>{
 const h=await hold(),original=await start(h);await payment(original.orderId,2000);const {request}=await add(h);await payment(request.order_id,1000);
 async function risk(orderId:string,amountCents:number,status:string,created:number){await dispatchSystem('commerce.recordRisk',{orderId,paymentIntentId:`pi_${orderId}`,stripeAccountId:'acct_AdjustmentFixture',livemode:false,
  kind:'dispute',externalId:`dp_${orderId}`,amountCents,currency:'usd',providerStatus:status,eventId:`evt_${randomUUID()}`,eventType:'charge.dispute.updated',eventCreated:created},ctx,{idempotencyKey:randomUUID()});}
 await risk(original.orderId,2000,'needs_response',100);await risk(request.order_id,1000,'needs_response',100);await risk(original.orderId,2000,'won',200);
 const [frozen]=await withTenant(tenant,tx=>tx`select commerce_frozen from commerce_appointment_holds where id=${h.holdId}`);expect(frozen!.commerce_frozen).toBe(true);
 await risk(request.order_id,1000,'won',200);
 const [unfrozen]=await withTenant(tenant,tx=>tx`select commerce_frozen from commerce_appointment_holds where id=${h.holdId}`);expect(unfrozen!.commerce_frozen).toBe(false);
 expect((await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId))).deposit?.availableCents).toBe(3000);
});
it('refuses cross-currency additions and missing financial permission without changing the original reservation',async()=>{
 const h=await hold(),order=await start(h);await payment(order.orderId,2000);const input={appointmentId:h.appointmentId,serviceId:extraId,guestIndex:0,override:{reason:'desk_coordination'}};
 await expect(dispatch('appointment.addItem',input,{...ctx,permissions:new Set(['appointment.write','appointment.overbook'])},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED',details:{need:'commerce.sell'}});
 await withTenant(tenant,tx=>tx`update locations set currency='CAD' where id=${tenant.locationId}`);
 try{await expect(run('appointment.addItem',input)).rejects.toMatchObject({details:{reason:'deposit_currency_mismatch'}});}
 finally{await withTenant(tenant,tx=>tx`update locations set currency='USD' where id=${tenant.locationId}`);}
 const [count]=await withTenant(tenant,tx=>tx`select count(*)::int as items from appointment_items where appointment_id=${h.appointmentId}`);expect(count!.items).toBe(1);
});
it('enforces request immutability, append-only quotes, original-payment ledger funding and tenant isolation in the database',async()=>{
 const h=await hold(),order=await start(h);
 await expect(withTenant(tenant,tx=>tx`update commerce_deposit_requests set expires_at=now()+interval '1 day' where order_id=${order.orderId}`)).rejects.toMatchObject({code:'23001'});
 await expect(withTenant(tenant,tx=>tx`update commerce_deposit_requests set state='paid' where order_id=${order.orderId}`)).rejects.toMatchObject({code:'23001'});
 await expect(withTenant(tenant,tx=>tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,entry,amount_cents,reference)
  values(${tenant.orgId},${tenant.locationId},${h.holdId},${order.paymentId},'collected',2000,'unpaid-fake-collection')`)).rejects.toMatchObject({code:'23001'});
 await add(h);const [quote]=await withTenant(tenant,tx=>tx`select id from commerce_deposit_requotes where hold_id=${h.holdId}`);
 await expect(withTenant(tenant,tx=>tx`update commerce_deposit_requotes set required_cents=1 where id=${quote!.id}`)).rejects.toMatchObject({code:expect.stringMatching(/^(42501|23001)$/)});
 const foreign={orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null};
 expect(await withTenant(foreign,tx=>tx`select id from commerce_deposit_requotes where hold_id=${h.holdId}`)).toHaveLength(0);
 expect(await withTenant(foreign,tx=>tx`select order_id from commerce_deposit_requests where hold_id=${h.holdId}`)).toHaveLength(0);
});
it('binds the approved service change to its original idempotency key and rejects changed money intent on replay',async()=>{
 const h=await hold(),order=await start(h);await payment(order.orderId,2000);
 const input={appointmentId:h.appointmentId,serviceId:extraId,guestIndex:0,override:{reason:'desk_coordination'}},quote=await preview('appointment.addItem',input),key=randomUUID();
 const accepted={...input,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}};
 const original=await run('appointment.addItem',accepted,key);expect(await run('appointment.addItem',accepted,key)).toEqual(original);
 await expect(run('appointment.addItem',{...accepted,serviceId:smallId},key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
});


it('delivers the current supplemental notice for a confirmed booking and suppresses an obsolete request during flush',async()=>{
 const h=await hold(false,future(),true),original=await start(h);await payment(original.orderId,2000);
 const {request}=await add(h);
 const voice=await withTenant(ctx,tx=>currentVoiceBooking(tx,ctx,h.appointmentId));
 expect(voice).toMatchObject({status:'confirmed',bookingConfirmed:true,deposit:{amountCents:3000,additionalPayment:{amountCents:1000,state:'open'}}});
 // Restore the obsolete notice to pending to exercise delivery-time validation after a prior claim/requeue race.
 await withTenant(tenant,tx=>tx`update email_outbox set status='pending',attempts=0,next_attempt_at=now() where entity_id=${h.appointmentId} and kind='appointment_deposit_pending'`);
 for(let i=0;i<10;i++)await flushEmails(tenant);
 const notices=await withTenant(tenant,tx=>tx`select commerce_order_id,status,last_error from email_outbox where entity_id=${h.appointmentId} and kind='appointment_deposit_pending'`);
 expect(notices.find(n=>n.commerce_order_id===request.order_id)).toMatchObject({status:'captured'});
 expect(notices.filter(n=>n.commerce_order_id!==request.order_id).every(n=>n.status==='failed'&&n.last_error==='deposit_request_superseded')).toBe(true);
 await payment(request.order_id,1000);await payment(request.order_id,1000);
 const [confirmation]=await withTenant(tenant,tx=>tx`select count(*)::int as count from email_outbox where entity_id=${h.appointmentId} and kind='appointment_confirm'`);
 expect(confirmation!.count).toBe(1);
 const paidVoice=await withTenant(ctx,tx=>currentVoiceBooking(tx,ctx,h.appointmentId));
 expect(paidVoice).toMatchObject({status:'confirmed',bookingConfirmed:true});expect(paidVoice.deposit?.additionalPayment).toBeUndefined();
});

it('offers the remaining supplement after the initial payment is fully refunded and returns late supplemental payment after service settlement',async()=>{
 const h=await hold(false,new Date(Date.now()+15*60000).toISOString()),original=await start(h);await payment(original.orderId,2000);
 const {request}=await add(h);await payment(request.order_id,1000);
 const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:original.paymentId,amountCents:2000,reason:'Return unused original payment'});await complete(refund.refundId,2000);
 const ticket=await run<{ticketId:string}>('ticket.open',{appointmentId:h.appointmentId,customerId:null,items:[{serviceId,membershipId:staffId},{serviceId:extraId,membershipId:staffId}]});
 const app=Fastify();registerTicketsRoutes(app,async()=>ctx);
 try{const response=await app.inject('/v1/desk/tickets');expect(response.statusCode).toBe(200);
 expect(response.json().tickets.find((t:{ticketId:string})=>t.ticketId===ticket.ticketId).availableDeposit).toMatchObject({holdId:h.holdId,availableCents:1000});}finally{await app.close();}
 const items=await withTenant(tenant,tx=>tx`select id from ticket_items where ticket_id=${ticket.ticketId} order by seq`);
 for(const item of items){await run('ticket.startItem',{ticketItemId:item.id,membershipId:staffId,override:{reason:'desk_coordination'}});await run('ticket.finishItem',{ticketItemId:item.id,membershipId:staffId});}
 await run('ticket.pay',{ticketId:ticket.ticketId,payments:[{method:'cash',amountCents:14000}],depositApplication:{holdId:h.holdId,amountCents:1000}});
 const h2=await hold(false,new Date(Date.now()+18*60000).toISOString()),original2=await start(h2);await payment(original2.orderId,2000);const pending=await add(h2);
 const ticket2=await run<{ticketId:string}>('ticket.open',{appointmentId:h2.appointmentId,customerId:null,items:[{serviceId,membershipId:staffId},{serviceId:extraId,membershipId:staffId}]});
 const items2=await withTenant(tenant,tx=>tx`select id from ticket_items where ticket_id=${ticket2.ticketId} order by seq`);
 for(const item of items2){await run('ticket.startItem',{ticketItemId:item.id,membershipId:staffId,override:{reason:'desk_coordination'}});await run('ticket.finishItem',{ticketItemId:item.id,membershipId:staffId});}
 await run('ticket.pay',{ticketId:ticket2.ticketId,payments:[{method:'cash',amountCents:13000}],depositApplication:{holdId:h2.holdId,amountCents:2000}});
 expect(await payment(pending.request.order_id,1000)).toMatchObject({status:'refund_pending'});
 const [late]=await withTenant(tenant,tx=>tx`select amount_cents from commerce_refunds where payment_id=${pending.request.payment_id}`);expect(late!.amount_cents).toBe(1000);
});

it('quotes only current services for the surviving guest after pending cancellation and replacement',async()=>{
 const h=await hold(true);await start(h);
 const cancel={appointmentId:h.appointmentId,guestIndices:[0],expectedRefundCents:0,reason:'One unpaid guest leaves'};
 const cancelled=await preview('appointment.cancelGuests',cancel);await run('appointment.cancelGuests',{...cancel,depositAdjustment:{accepted:true,quoteHash:cancelled.quoteHash}});
 const [item]=await withTenant(tenant,tx=>tx`select id from appointment_items where appointment_id=${h.appointmentId} and status='booked'`);
 const replace={appointmentId:h.appointmentId,itemId:item!.id,serviceId:smallId};const quote=await preview('appointment.replaceItem',replace);
 expect(quote).toMatchObject({serviceTotalCents:100,requiredCents:20,requestCents:20});await run('appointment.replaceItem',{...replace,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}});
 const expected=[{guestIndex:0,status:'cancelled',serviceTotalCents:0,refundableDepositCents:0},{guestIndex:1,status:'active',serviceTotalCents:100,refundableDepositCents:0}];
 const staff=await withTenant(ctx,tx=>loadAppointmentDetail(tx,ctx,h.appointmentId));expect(staff.guests).toMatchObject(expected);
 const shop=await resolveHostedShop('golden-foot');const guest=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop!,h.appointmentId,'en'));expect(guest!.guests).toMatchObject(expected);
 const [request]=await withTenant(tenant,tx=>tx`select order_id from commerce_deposit_requests where hold_id=${h.holdId} and state='open'`);await payment(request!.order_id,20);
 const paid=await withTenant(tenant,tx=>loadManagedBookingDetail(tx,shop!,h.appointmentId,'en'));expect(paid!.guests).toMatchObject([{guestIndex:0,serviceTotalCents:0,refundableDepositCents:0},{guestIndex:1,serviceTotalCents:100,refundableDepositCents:20}]);
});
