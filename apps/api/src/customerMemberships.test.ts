import {loadCustomerDetail} from './queries/customer';
import {registerTicketsRoutes} from './routes/tickets';
import {loadDayClose} from './queries/money';
import {canonicalCustomer} from './customerIdentity';
import './handlers/customer';
import {loadDayMoney,resolveDate} from './handlers/dayclose';
import {createHmac,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import type Stripe from 'stripe';
import {withTenant,closeDb,jsonb} from '@gf/db';
import {AppError,httpStatusFor,membershipText,type CustomerMembershipTerms,type Permission} from '@gf/contracts';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {registerRawBodyParser} from './rawBody';
import {registerCommerceRoutes} from './commerce/routes';
import {commerceStripeClient} from './commerce/client';
import {processCommerceEvent} from './commerce/webhook';
import {membershipCancellationFact} from './commerce/customerMembership';
import {loadMembershipDiscountOffers} from './handlers/membershipDiscounts';
import {membershipTerminationReview} from './handlers/membershipTermination';
import * as membershipHandlers from './handlers/customerMembership';
import {runCommerceTask,workerContext} from './commerce/worker';
import {hashManageToken,unwrapManageToken} from './public/bookingToken';
import {reconcileMembershipPaymentRefunds} from './commerce/reconciliation';
import './handlers/commerce';
import './handlers/billing';
import './handlers/customerMembership';
import './handlers/ticket';
import './handlers/marketing';
import './handlers/appointmentDeposits';
import './handlers/setup';
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>,serviceId:string,slug:string;
const app=Fastify();const account='acct_MembershipFixture';
async function run<T>(name:string,input:unknown,key=randomUUID()){return (await dispatch<T>(name,input,ctx,{idempotencyKey:key})).result;}
async function plan(cadence:'month'|'year'='month',over:Partial<CustomerMembershipTerms>={}){
 const terms:CustomerMembershipTerms={name:{en:'Paid membership QA'},amountCents:cadence==='month'?9900:99900,cadence,benefitFrequency:'month',quantity:1,
  serviceIds:[serviceId],discountBps:0,discountServiceIds:[],commissionBasis:'sale_price',...over};
 return {...await run<{planId:string;versionId:string;version:number}>('commerce.saveMembershipPlan',{terms,active:true,onlineSale:true}),terms};
}
async function enroll(p:Awaited<ReturnType<typeof plan>>,key=randomUUID()){
 const input={versionId:p.versionId,businessKey:key,customer:{name:'Membership QA',email:'membership@example.test'},
  consent:{accepted:true,versionId:p.versionId,amountCents:p.terms.amountCents,cadence:p.terms.cadence}};
 const created=await dispatchSystem<{membershipId:string;orderId:string}>('commerce.enrollMembership',input,ctx,{idempotencyKey:`qa:${key}`});
 const id=created.result.membershipId,customer=`cus_${id.replaceAll('-','')}`;
 await dispatchSystem('commerce.bindMembershipCustomer',{membershipId:id,stripeAccountId:account,livemode:false,stripeCustomerId:customer},ctx,{idempotencyKey:randomUUID()});
 const metadata={gf_domain:'customer_commerce',gf_org_id:ctx.orgId,gf_location_id:ctx.locationId,gf_order_id:created.result.orderId,gf_membership_id:id};
 const stripe=commerceStripeClient(),start=Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),1),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+(p.terms.cadence==='year'?12:1));
 const sub={id:`sub_${id.replaceAll('-','')}`,metadata,livemode:false,customer,status:'active',cancel_at_period_end:false,cancel_at:null as number|null,trial_end:null,discounts:[],latest_invoice:`in_${id.replaceAll('-','')}`,
  items:{has_more:false,data:[{id:'si_fixture',quantity:1,current_period_start:start/1000,current_period_end:end.getTime()/1000,discounts:[],
   price:{id:`price_${id.replaceAll('-','')}`,unit_amount:p.terms.amountCents,currency:'usd',recurring:{interval:p.terms.cadence,interval_count:1}}}]}};
 const invoice={id:sub.latest_invoice,status:'paid',livemode:false,customer,currency:'usd',amount_paid:p.terms.amountCents,total:p.terms.amountCents,amount_remaining:0,
  billing_reason:'subscription_create',parent:{subscription_details:{subscription:sub.id}},status_transitions:{paid_at:Math.floor(Date.now()/1000)},
  lines:{has_more:false,data:[{period:{start:start/1000,end:end.getTime()/1000},quantity:1,pricing:{price_details:{price:sub.items.data[0]!.price.id}},parent:{subscription_item_details:{proration:false}}}]}};
 const intent={id:`pi_${id.replaceAll('-','')}`,livemode:false,customer,status:'succeeded',amount_received:p.terms.amountCents,currency:'usd'};
 vi.spyOn(stripe.subscriptions,'retrieve').mockResolvedValue(sub as unknown as Stripe.Response<Stripe.Subscription>);
 vi.spyOn(stripe.invoices,'retrieve').mockResolvedValue(invoice as unknown as Stripe.Response<Stripe.Invoice>);
 vi.spyOn(stripe.invoicePayments,'list').mockResolvedValue({has_more:false,data:[{invoice:invoice.id,livemode:false,status:'paid',amount_paid:p.terms.amountCents,payment:{payment_intent:intent.id}}]} as unknown as Stripe.Response<Stripe.ApiList<Stripe.InvoicePayment>>);
 vi.spyOn(stripe.paymentIntents,'retrieve').mockResolvedValue(intent as unknown as Stripe.Response<Stripe.PaymentIntent>);
 const event=(type='invoice.paid',object:unknown=invoice,id=`evt_${randomUUID()}`)=>({id,type,account,livemode:false,data:{object}} as Stripe.Event);
 return {id,orderId:created.result.orderId,sub,invoice,intent,event,input};
}
function iterable<T>(data:T[]){return Object.assign(Promise.resolve({data,has_more:false}),{async *[Symbol.asyncIterator](){yield*data;}});}
async function portalFixture(){
 const a=await enroll(await plan());await processCommerceEvent(a.event());
 const [m]=await withTenant(ctx,tx=>tx<{manage_token_hash:string;manage_token_wrapped:Buffer}[]>`select manage_token_hash,manage_token_wrapped from customer_paid_memberships where id=${a.id}`);
 const token=unwrapManageToken(m!.manage_token_wrapped,m!.manage_token_hash)!,stripe=commerceStripeClient();
 const config={id:'bpc_membership_fixture',active:true,livemode:false,is_default:true,metadata:{gf_domain:'customer_membership_portal',gf_revision:'customer-membership-portal-v1',gf_stripe_account_id:account},login_page:{enabled:false},
  features:{customer_update:{enabled:false},subscription_update:{enabled:false},invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end',proration_behavior:'none'}}};
 vi.spyOn(stripe.customers,'retrieve').mockResolvedValue({id:a.sub.customer,deleted:false,metadata:a.sub.metadata} as unknown as Stripe.Response<Stripe.Customer>);
 vi.spyOn(stripe.subscriptions,'list').mockReturnValue(iterable([a.sub]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>);
 vi.spyOn(stripe.invoices,'list').mockReturnValue(iterable([a.invoice]) as unknown as Stripe.ApiListPromise<Stripe.Invoice>);
 vi.spyOn(stripe.billingPortal.configurations,'list').mockReturnValue(iterable([config]) as unknown as Stripe.ApiListPromise<Stripe.BillingPortal.Configuration>);
 const create=vi.spyOn(stripe.billingPortal.sessions,'create').mockResolvedValue({id:'bps_fixture',customer:a.sub.customer,configuration:config.id,livemode:false,url:'https://billing.stripe.com/p/session/test_fixture'} as Stripe.Response<Stripe.BillingPortal.Session>);
 let address=1;
 const post=(over:Record<string,unknown>={},businessKey=randomUUID(),resource=a.id,access=token)=>app.inject({method:'POST',url:`/v1/public/shops/${slug}/commerce/memberships/${resource}/portal`,
  remoteAddress:`127.0.1.${address++}`,headers:{'content-type':'application/json','x-gf-commerce-token':access},payload:{businessKey,locale:'zh-Hans',...over}});
 return {...a,token,config,create,post};
}
beforeAll(async()=>{
 process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.COMMERCE_STRIPE_SECRET_KEY='';process.env.STRIPE_SECRET_KEY='sk_test_membership_fixture';
 process.env.COMMERCE_STRIPE_MODE='test';process.env.STRIPE_COMMERCE_WEBHOOK_SECRET='whsec_membership_fixture';process.env.MANAGE_TOKEN_WRAP_KEY='membership-wrap-isolated-fixture-32-characters';
 process.env.BOOKING_BASE_URL='http://localhost:5296';
 const [m]=await withTenant(tenant,tx=>tx<{user_id:string;id:string}[]>`select m.* from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id
  where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});
 await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
 await run('commerce.saveSettings',{salesEnabled:true,depositsEnabled:true,membershipsEnabled:true});
 await dispatchSystem('commerce.saveAccount',{stripeAccountId:account,livemode:false,chargesEnabled:true,payoutsEnabled:true,detailsSubmitted:true,capabilities:{card_payments:'active'}},ctx,{idempotencyKey:randomUUID()});
 const [s]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from services where location_id=${ctx.locationId} and active limit 1`);serviceId=s!.id;
 const [l]=await withTenant(ctx,tx=>tx<{slug:string}[]>`select slug from locations where id=${ctx.locationId}`);slug=l!.slug;
 registerRawBodyParser(app);registerCommerceRoutes(app,async()=>ctx);registerTicketsRoutes(app,async()=>ctx);
 app.setErrorHandler((error,_,reply)=>reply.status(error instanceof AppError?httpStatusFor[error.code]:400).send({code:error instanceof AppError?error.code:'VALIDATION_FAILED'}));await app.ready();
});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{await app.close();await closeDb();});
async function benefitTicket(memberId:string,prices=[10000]){
 const [m]=await withTenant(ctx,tx=>tx<{customer_id:string}[]>`select customer_id from customer_paid_memberships where id=${memberId}`);
 const [staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const created=await run<{ticketId:string}>('ticket.open',{customerId:m!.customer_id,items:prices.map(price=>({serviceId,membershipId:staff!.membership_id,priceCentsOverride:price}))});
 const items=await withTenant(ctx,tx=>tx<{id:string}[]>`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${created.ticketId} returning id`);
 const [cycle]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from customer_membership_cycles where membership_id=${memberId} and status='issued' and starts_at<=now() and ends_at>now()`);
 return {...created,itemIds:items.map(i=>i.id),cycleId:cycle!.id};
}
async function terminationReview(id:string){return withTenant(ctx,tx=>membershipTerminationReview(tx,ctx,id));}
async function terminationWorker(id:string){const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${id} and kind='subscription_update'`);
 expect(task).toBeDefined();return runCommerceTask(workerContext(ctx.orgId,ctx.locationId),task!.id);}
function cancelSdk(a:Awaited<ReturnType<typeof enroll>>){return vi.spyOn(commerceStripeClient().subscriptions,'cancel').mockImplementation(async()=>{
 Object.assign(a.sub,{status:'canceled',canceled_at:Math.floor(Date.now()/1000)});return a.sub as unknown as Stripe.Response<Stripe.Subscription>;});}
it('freezes an annual membership, verifies immediate cancellation, stops eleven future grants and refunds the selected original invoice once',async()=>{
 const a=await enroll(await plan('year'));await processCommerceEvent(a.event());const review=await terminationReview(a.id),cancel=cancelSdk(a);
 const input={membershipId:a.id,expectedReviewHash:review.reviewHash,unusedBenefits:'revoke_all',refunds:[{invoiceId:review.invoices[0]!.id,amountCents:50000}],reason:'Customer requested annual termination',confirmed:true},key=randomUUID();
 const t=await run<{terminationId:string}>('commerce.terminateMembership',input,key);await run('commerce.terminateMembership',input,key);
 const [pending]=await withTenant(ctx,tx=>tx`select commerce_frozen,terminated_at from customer_paid_memberships where id=${a.id}`);
 expect(pending).toMatchObject({commerce_frozen:true,terminated_at:null});
 const before=await withTenant(ctx,tx=>tx`select id from commerce_tasks where kind='refund'`);expect(before).toHaveLength(0);
 const ticket=await benefitTicket(a.id);await expect(run('ticket.pay',{ticketId:ticket.ticketId,payments:[],membershipRedemptions:[{cycleId:ticket.cycleId,ticketItemIds:ticket.itemIds}]})).rejects.toBeDefined();
 await terminationWorker(t.terminationId);expect(cancel).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalledWith(a.sub.id,{invoice_now:false,prorate:false},expect.objectContaining({stripeAccount:account}));
 const finished=await terminationReview(a.id);expect(finished.m).toMatchObject({provider_status:'canceled',commerce_frozen:false});expect(finished.m.terminated_at).not.toBeNull();
 expect(finished.cycles.filter(c=>c.status==='stopped')).toHaveLength(12);expect(finished.cycles.reduce((s,c)=>s+c.available,0)).toBe(0);
 const ledger=await withTenant(ctx,tx=>tx`select entry,count(*)::int as n from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${a.id} group by entry`);
 expect(ledger).toEqual(expect.arrayContaining([{entry:'issue',n:1},{entry:'revoke',n:1},{entry:'stop',n:11}]));
 const refund=finished.requests[0]! as {id:string};
 vi.spyOn(commerceStripeClient().refunds,'create').mockResolvedValue({id:`re_annualTermination_${a.id}`,status:'succeeded',amount:50000,currency:'usd',payment_intent:a.intent.id,metadata:{gf_refund_id:refund.id}} as unknown as Stripe.Response<Stripe.Refund>);
 const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${refund.id} and kind='refund'`);await runCommerceTask(workerContext(ctx.orgId,ctx.locationId),task!.id);
 const after=await terminationReview(a.id);expect(after.termination!.status).toBe('complete');expect(after.summary.refundedCents).toBe(50000);
 expect(await terminationWorker(t.terminationId)).toBe(false);expect(cancel).toHaveBeenCalledTimes(1);
 await expect(run('commerce.refundMembership',{membershipId:a.id,terminationId:t.terminationId,expectedReviewHash:after.reviewHash,refunds:[{invoiceId:after.invoices[0]!.id,amountCents:49901}],reason:'Exceeds remaining original invoice',confirmed:true})).rejects.toBeDefined();
});
it('preserves only the reviewed current paid period and protects its value from purchase refunds',async()=>{
 const a=await enroll(await plan('year'));await processCommerceEvent(a.event());const before=await terminationReview(a.id),cancel=cancelSdk(a);
 const base={membershipId:a.id,expectedReviewHash:before.reviewHash,unusedBenefits:'keep_current_paid',reason:'Keep current paid benefit and stop future periods',confirmed:true};
 await expect(run('commerce.terminateMembership',{...base,refunds:[{invoiceId:before.invoices[0]!.id,amountCents:91576}]})).rejects.toBeDefined();
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{...base,refunds:[{invoiceId:before.invoices[0]!.id,amountCents:91575}]});await terminationWorker(t.terminationId);
 const after=await terminationReview(a.id);expect(after.m.terminated_at).toBeNull();expect(after.cycles.filter(c=>c.status==='issued')).toHaveLength(1);expect(after.cycles.filter(c=>c.status==='stopped')).toHaveLength(11);
 expect(after.summary.currentAvailable).toBe(1);expect(after.invoices[0]!.held).toBe(8325);expect(after.invoices[0]!.refundable).toBe(0);
 await expect(run('commerce.refundMembership',{membershipId:a.id,terminationId:t.terminationId,expectedReviewHash:after.reviewHash,refunds:[{invoiceId:after.invoices[0]!.id,amountCents:1}],reason:'Protected current period',confirmed:true})).rejects.toBeDefined();
 const ticket=await benefitTicket(a.id);await run('ticket.pay',{ticketId:ticket.ticketId,payments:[],membershipRedemptions:[{cycleId:ticket.cycleId,ticketItemIds:ticket.itemIds}]});
 expect(cancel).toHaveBeenCalledTimes(1);
});
it('recovers an external cancellation after a transactional write failure without canceling again or refunding early',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const before=await terminationReview(a.id),cancel=cancelSdk(a);
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{membershipId:a.id,expectedReviewHash:before.reviewHash,unusedBenefits:'revoke_all',refunds:[],reason:'Termination failure recovery',confirmed:true});
 const failure=vi.spyOn(membershipHandlers,'saveMembershipState').mockRejectedValueOnce(new Error('injected_transaction_failure'));
 await terminationWorker(t.terminationId);const failed=await terminationReview(a.id);expect(failed.termination!.status).toBe('pending');expect(failed.m.commerce_frozen).toBe(true);expect(cancel).toHaveBeenCalledTimes(1);
 failure.mockRestore();await withTenant(ctx,tx=>tx`update commerce_tasks set retry_at=now() where subject_id=${t.terminationId} and kind='subscription_update'`);
 await terminationWorker(t.terminationId);const recovered=await terminationReview(a.id);expect(recovered.termination!.status).toBe('complete');expect(recovered.m.provider_status).toBe('canceled');expect(cancel).toHaveBeenCalledTimes(1);
});
it('requires an unchanged manager review and keeps member termination decisions private and immutable',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const before=await terminationReview(a.id);
 const input={membershipId:a.id,expectedReviewHash:before.reviewHash,unusedBenefits:'revoke_all',refunds:[],reason:'Reviewed termination',confirmed:true};
 await expect(dispatch('commerce.terminateMembership',input,{...ctx,permissions:new Set([...ctx.permissions].filter(p=>p!=='commerce.refund'))},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 const ticket=await benefitTicket(a.id);await run('ticket.pay',{ticketId:ticket.ticketId,payments:[],membershipRedemptions:[{cycleId:ticket.cycleId,ticketItemIds:ticket.itemIds}]});
 await expect(run('commerce.terminateMembership',input)).rejects.toMatchObject({details:{reason:'membership_termination_review_changed'}});
 const current=await terminationReview(a.id);const t=await run<{terminationId:string}>('commerce.terminateMembership',{...input,expectedReviewHash:current.reviewHash});
 await expect(withTenant(ctx,tx=>tx`update customer_membership_terminations set reason='change history' where id=${t.terminationId}`)).rejects.toBeDefined();
 await expect(withTenant(ctx,tx=>tx`delete from customer_membership_termination_cycles where termination_id=${t.terminationId}`)).rejects.toBeDefined();
 expect(await withTenant({...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'},tx=>tx`select id from customer_membership_terminations where id=${t.terminationId}`)).toHaveLength(0);
});
it('keeps cancellation and stopped benefits after a provider refund failure, reserving a fresh original-invoice attempt within its cap',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const r=await terminationReview(a.id);cancelSdk(a);
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{membershipId:a.id,expectedReviewHash:r.reviewHash,unusedBenefits:'revoke_all',refunds:[{invoiceId:r.invoices[0]!.id,amountCents:9900}],reason:'Refund failure recovery',confirmed:true});
 await terminationWorker(t.terminationId);const failedRefund=(await terminationReview(a.id)).requests[0]! as {id:string};
 vi.spyOn(commerceStripeClient().refunds,'list').mockReturnValue(iterable([]) as unknown as Stripe.ApiListPromise<Stripe.Refund>);
 expect(await reconcileMembershipPaymentRefunds(ctx,r.invoices[0]!.payment_id)).toBe(true);
 const create=vi.spyOn(commerceStripeClient().refunds,'create').mockResolvedValue({id:`re_failedMembership_${a.id}`,status:'failed',amount:9900,currency:'usd',payment_intent:a.intent.id,metadata:{gf_refund_id:failedRefund.id}} as unknown as Stripe.Response<Stripe.Refund>);
 const [first]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='refund' and subject_id=${failedRefund.id}`);await runCommerceTask(workerContext(ctx.orgId,ctx.locationId),first!.id);
 const failed=await terminationReview(a.id);expect(failed.termination!.status).toBe('review');expect(failed.invoices[0]!.refundable).toBe(9900);expect(failed.m.provider_status).toBe('canceled');expect(failed.summary.currentAvailable).toBe(0);
 const next=await run<{refundIds:string[]}>('commerce.refundMembership',{membershipId:a.id,terminationId:t.terminationId,expectedReviewHash:failed.reviewHash,refunds:[{invoiceId:r.invoices[0]!.id,amountCents:9900}],reason:'Reviewed fresh attempt after provider failure',confirmed:true});
 const [reconcile]=await withTenant(ctx,tx=>tx<{status:string}[]>`select status from commerce_tasks where kind='reconcile' and subject_id=${a.orderId}`);expect(reconcile!.status).toBe('pending');
 const reserved=await terminationReview(a.id);expect(reserved.invoices[0]!.refundable).toBe(0);
 create.mockResolvedValue({id:`re_recoveredMembership_${a.id}`,status:'succeeded',amount:9900,currency:'usd',payment_intent:a.intent.id,metadata:{gf_refund_id:next.refundIds[0]!}} as unknown as Stripe.Response<Stripe.Refund>);
 const [second]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='refund' and subject_id=${next.refundIds[0]!}`);await runCommerceTask(workerContext(ctx.orgId,ctx.locationId),second!.id);
 const finished=await terminationReview(a.id);expect(finished.summary.refundedCents).toBe(9900);expect(finished.m.terminated_at).not.toBeNull();expect(finished.summary.currentAvailable).toBe(0);expect(create).toHaveBeenCalledTimes(2);
});
it('does not reactivate a stopped membership when an originally covered service is returned after termination',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const ticket=await benefitTicket(a.id);
 await run('ticket.pay',{ticketId:ticket.ticketId,payments:[],membershipRedemptions:[{cycleId:ticket.cycleId,ticketItemIds:ticket.itemIds}]});
 const r=await terminationReview(a.id);cancelSdk(a);
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{membershipId:a.id,expectedReviewHash:r.reviewHash,unusedBenefits:'revoke_all',refunds:[],reason:'End after consumed service',confirmed:true});await terminationWorker(t.terminationId);
 const input={ticketId:ticket.ticketId,refundAmountCents:10000,refundMethod:'original_payment',reason:'customer_dissatisfied'},key=randomUUID();
 await run('ticket.refund',input,key);await run('ticket.refund',input,key);
 const after=await terminationReview(a.id);expect(after.summary.currentAvailable).toBe(0);expect(after.cycles[0]!.status).toBe('stopped');expect(after.cycles[0]!.available).toBe(0);
 const ledger=await withTenant(ctx,tx=>tx`select entry,sum(quantity)::int as quantity from customer_membership_ledger where cycle_id=${ticket.cycleId} group by entry`);
 expect(ledger).toEqual(expect.arrayContaining([{entry:'revoke',quantity:0},{entry:'restore',quantity:1},{entry:'expire',quantity:-1}]));
});
it('stops late-discovered paid invoice periods after a confirmed termination while keeping cash history and one termination notice',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const r=await terminationReview(a.id);cancelSdk(a);
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{membershipId:a.id,expectedReviewHash:r.reviewHash,unusedBenefits:'revoke_all',refunds:[],reason:'Stop all future benefits',confirmed:true});await terminationWorker(t.terminationId);
 const line=a.invoice.lines.data[0]!,starts=line.period.end,ends=new Date(starts*1000);ends.setUTCMonth(ends.getUTCMonth()+1);
 const late={...a.invoice,id:`in_late_${randomUUID()}`,billing_reason:'subscription_cycle',lines:{...a.invoice.lines,data:[{...line,period:{start:starts,end:ends.getTime()/1000}}]}};
 const stripe=commerceStripeClient();vi.mocked(stripe.invoices.retrieve).mockResolvedValue(late as unknown as Stripe.Response<Stripe.Invoice>);
 vi.mocked(stripe.invoicePayments.list).mockResolvedValue({has_more:false,data:[{invoice:late.id,livemode:false,status:'paid',amount_paid:9900,payment:{payment_intent:`pi_late_${a.id}`}}]} as unknown as Stripe.Response<Stripe.ApiList<Stripe.InvoicePayment>>);
 vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValue({...a.intent,id:`pi_late_${a.id}`} as unknown as Stripe.Response<Stripe.PaymentIntent>);
 await processCommerceEvent(a.event('invoice.paid',late));await processCommerceEvent(a.event('invoice.paid',late));
 const after=await terminationReview(a.id);expect(after.invoices).toHaveLength(2);expect(after.summary.paidCents).toBe(19800);expect(after.cycles.every(c=>c.status==='stopped')).toBe(true);expect(after.summary.currentAvailable).toBe(0);expect(after.m.provider_status).toBe('canceled');
 const notices=await withTenant(ctx,tx=>tx`select body_text from email_outbox where entity_type='customer_membership_termination' and entity_id=${t.terminationId}`);
 const [customer]=await withTenant(ctx,tx=>tx<{locale:string}[]>`select c.locale from customers c join customer_paid_memberships m on m.customer_id=c.id where m.id=${a.id}`);
 expect(notices).toHaveLength(1);expect(notices[0]!.body_text).toContain(membershipText(customer!.locale,'terminationRevoked'));expect(notices[0]!.body_text).not.toContain(membershipText(customer!.locale,'nextCharge'));
});
it('blocks invoice refunds during risk review and never unfreezes a pending termination when a dispute is won',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const r=await terminationReview(a.id);
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{membershipId:a.id,expectedReviewHash:r.reviewHash,unusedBenefits:'revoke_all',refunds:[],reason:'Termination under review',confirmed:true});
 const risk={paymentIntentId:a.intent.id,stripeAccountId:account,livemode:false,kind:'dispute',externalId:`dp_${a.id}`,amountCents:9900,currency:'usd',eventType:'charge.dispute.updated',eventCreated:Math.floor(Date.now()/1000)};
 await dispatchSystem('commerce.recordRisk',{...risk,providerStatus:'needs_response',eventId:`evt_open_${a.id}`},ctx,{idempotencyKey:randomUUID()});
 let after=await terminationReview(a.id);expect(after.invoices[0]!.refundable).toBe(0);expect(after.m.commerce_frozen).toBe(true);
 await dispatchSystem('commerce.recordRisk',{...risk,providerStatus:'won',eventId:`evt_won_${a.id}`,eventCreated:risk.eventCreated+1},ctx,{idempotencyKey:randomUUID()});
 after=await terminationReview(a.id);expect(after.m.commerce_frozen).toBe(true);expect(after.termination!.id).toBe(t.terminationId);expect(after.invoices[0]!.refundable).toBe(9900);
});
it('keeps protected invoice access after termination and recovers a missed refund webhook through SDK reconciliation',async()=>{
 const a=await portalFixture(),before=await terminationReview(a.id);cancelSdk(a);
 const t=await run<{terminationId:string}>('commerce.terminateMembership',{membershipId:a.id,expectedReviewHash:before.reviewHash,unusedBenefits:'revoke_all',refunds:[{invoiceId:before.invoices[0]!.id,amountCents:5000}],reason:'Ended invoice access and missed refund callback',confirmed:true});await terminationWorker(t.terminationId);
 expect((await a.post()).statusCode).toBe(200);
 const current=await terminationReview(a.id),r=current.requests[0]! as {id:string};
 const refund={object:'refund',id:`re_${a.id}`,status:'succeeded',amount:5000,currency:'usd',payment_intent:a.intent.id,metadata:{gf_refund_id:r.id},balance_transaction:null};
 vi.spyOn(commerceStripeClient().refunds,'list').mockReturnValue(iterable([refund]) as unknown as Stripe.ApiListPromise<Stripe.Refund>);
 expect(await reconcileMembershipPaymentRefunds(ctx,before.invoices[0]!.payment_id)).toBe(true);
 expect(await reconcileMembershipPaymentRefunds(ctx,before.invoices[0]!.payment_id)).toBe(true);
 const after=await terminationReview(a.id);expect(after.summary.refundedCents).toBe(5000);expect(after.requests).toHaveLength(1);
 const get=await app.inject({method:'GET',url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':a.token}});
 expect(get.statusCode).toBe(200);expect(get.json()).toMatchObject({portalAvailable:true,benefitsActive:false,termination:{status:'complete'},invoices:[{refunded_cents:5000,pending_refund_cents:0}]});
});
async function discountOffer(t:Awaited<ReturnType<typeof benefitTicket>>,memberId:string){
 const [m]=await withTenant(ctx,tx=>tx<{customer_id:string}[]>`select customer_id from customer_paid_memberships where id=${memberId}`);
 const offers=await withTenant(ctx,tx=>loadMembershipDiscountOffers(tx,ctx,[{ticketId:t.ticketId,customerId:m!.customer_id}]));
 const offer=offers.get(t.ticketId)![0]!;expect(offer).toBeDefined();return offer;
}
it('prices a paid zero-quota discount membership from its immutable version without allocating the membership fee to service commission',async()=>{
 const p=await plan('month',{quantity:0,serviceIds:[],discountBps:1000,discountServiceIds:[serviceId]}),a=await enroll(p);await processCommerceEvent(a.event());
 const t=await benefitTicket(a.id,[999]),offer=await discountOffer(t,a.id);expect(offer.items[0]).toMatchObject({expectedTotalCents:999,expectedDiscountCents:100});
 await run('commerce.saveMembershipPlan',{planId:p.planId,expectedVersion:1,terms:{...p.terms,discountBps:5000},active:true,onlineSale:true});
 await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
 try{
  const limited={...ctx,permissions:new Set([...ctx.permissions].filter(p=>p!=='ticket.discount'))},key=randomUUID();
  const input={ticketId:t.ticketId,payments:[{method:'cash',amountCents:1022,tipCents:123,changeCents:0,keepChange:false}],membershipDiscount:{membershipId:a.id,cycleId:t.cycleId,planVersionId:p.versionId,items:offer.items}};
  await dispatch('ticket.pay',input,limited,{idempotencyKey:key});await dispatch('ticket.pay',input,limited,{idempotencyKey:key});
  const facts=await withTenant(ctx,tx=>tx`select t.discount_cents,t.total_cents,t.tip_cents,
   (select count(*)::int from ticket_price_adjustments where ticket_id=t.id) as price_facts,
   (select count(*)::int from customer_membership_ledger where ticket_id=t.id and entry='redeem') as redeemed_units,
   (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as commission_base,
   (select min(basis->>'base') from earnings where ticket_id=t.id and kind='commission') as staff_policy from tickets t where id=${t.ticketId}`);
  expect(facts[0]).toMatchObject({discount_cents:100,total_cents:1022,tip_cents:123,price_facts:1,redeemed_units:0});
  expect(facts[0]!.commission_base).toBe(facts[0]!.staff_policy==='gross'?999:899);
  const [cycle]=await withTenant(ctx,tx=>tx`select available_units from customer_membership_cycles where id=${t.cycleId}`);expect(cycle!.available_units).toBe('{}');
 }finally{await run('commerce.saveSettings',{salesEnabled:true,depositsEnabled:true,membershipsEnabled:true});}
});
it('combines one covered unit, a different member-priced line and a manual discount on the other line, then returns only the original paid allocations',async()=>{
 const p=await plan('month',{discountBps:1000,discountServiceIds:[serviceId]}),a=await enroll(p);await processCommerceEvent(a.event());
 const t=await benefitTicket(a.id,[10000,5000,4000]),offer=await discountOffer(t,a.id),choice=offer.items.find(i=>i.expectedTotalCents===5000)!;
 const covered=t.itemIds.find(id=>offer.items.find(i=>i.ticketItemId===id)?.expectedTotalCents===10000)!;
 await run('ticket.pay',{ticketId:t.ticketId,discountCents:1000,payments:[{method:'cash',amountCents:8500,tipCents:1000,changeCents:0,keepChange:false}],
  membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:[covered]}],membershipDiscount:{membershipId:a.id,cycleId:t.cycleId,planVersionId:p.versionId,items:[choice]}});
 const adjustments=await withTenant(ctx,tx=>tx`select kind,discount_cents,original_cents from ticket_price_adjustments where ticket_id=${t.ticketId} order by kind`);
 expect(adjustments).toEqual([{kind:'manual',discount_cents:1000,original_cents:4000},{kind:'membership',discount_cents:500,original_cents:5000}]);
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:8750,refundMethod:'original_payment',reason:'customer_dissatisfied'});
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:9750,refundTipCents:1000,refundMethod:'original_payment',reason:'customer_dissatisfied'});
 const [fact]=await withTenant(ctx,tx=>tx`select
  (select sum(cash_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as money_return,
  (select sum(membership_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as member_return,
  (select count(*)::int from ticket_price_adjustments where ticket_id=${t.ticketId}) as original_prices,
  (select available_units from customer_membership_cycles where id=${t.cycleId}) as original_units`);
 expect(fact).toMatchObject({money_return:8500,member_return:10000,original_prices:2,original_units:'{[0,1)}'});
 await expect(run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:1,refundMethod:'original_payment',reason:'customer_dissatisfied'})).rejects.toBeDefined();
});
it('rejects stale or fabricated member prices, double coverage and an unauthorized benefit without leaving price facts or consuming rights',async()=>{
 const p=await plan('month',{discountBps:1000,discountServiceIds:[serviceId]}),a=await enroll(p);await processCommerceEvent(a.event());
 const t=await benefitTicket(a.id),offer=await discountOffer(t,a.id),selected={membershipId:a.id,cycleId:t.cycleId,planVersionId:p.versionId,items:offer.items};
 const base={ticketId:t.ticketId,payments:[{method:'card',amountCents:9000,tipCents:0,changeCents:0,keepChange:false}],membershipDiscount:selected};
 for(const membershipDiscount of [{...selected,planVersionId:randomUUID()},{...selected,membershipId:randomUUID()},
  {...selected,items:[{...offer.items[0]!,expectedTotalCents:9999}]},{...selected,items:[{...offer.items[0]!,expectedDiscountCents:999}]},
  {...selected,items:[offer.items[0]!,offer.items[0]!]}])await expect(run('ticket.pay',{...base,membershipDiscount})).rejects.toBeDefined();
 await expect(run('ticket.pay',{...base,discountCents:1})).rejects.toMatchObject({details:{reason:'price_discount_exceeds_uncovered_services'}});
 await expect(run('ticket.pay',{...base,membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]})).rejects.toMatchObject({details:{reason:'membership_discount_service_unavailable'}});
 await expect(dispatch('ticket.pay',base,{...ctx,permissions:new Set([...ctx.permissions].filter(p=>p!=='commerce.sell'))},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 await withTenant(ctx,tx=>tx`update customer_paid_memberships set commerce_frozen=true where id=${a.id}`);
 await expect(run('ticket.pay',base)).rejects.toMatchObject({details:{reason:'membership_discount_unavailable'}});
 const [facts]=await withTenant(ctx,tx=>tx`select
  (select count(*)::int from ticket_price_adjustments where ticket_id=${t.ticketId}) as adjustments,
  (select count(*)::int from payments where ticket_id=${t.ticketId}) as payments,
  (select available_units from customer_membership_cycles where id=${t.cycleId}) as units`);
 expect(facts).toMatchObject({adjustments:0,payments:0,units:'{[0,1)}'});
});
it('calculates both configured tax modes after the purchased member price and refunds stored amounts after the tax policy changes',async()=>{
 const [original]=await withTenant(ctx,tx=>tx<{sales_tax_rate_percent:string;tax_calculation_mode:string}[]>`select sales_tax_rate_percent,tax_calculation_mode from location_checkout_settings where location_id=${ctx.locationId}`);
 expect(original).toBeDefined();
 try{
  for(const mode of ['exclusive','inclusive'] as const){
   await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=7.5,tax_calculation_mode=${mode} where location_id=${ctx.locationId}`);
   const p=await plan('month',{quantity:0,serviceIds:[],discountBps:1000,discountServiceIds:[serviceId]}),a=await enroll(p);await processCommerceEvent(a.event());
   const t=await benefitTicket(a.id),offer=await discountOffer(t,a.id),total=mode==='exclusive'?10107:9432;
   await run('ticket.pay',{ticketId:t.ticketId,payments:[{method:'card',amountCents:total,tipCents:432,changeCents:0,keepChange:false}],
    membershipDiscount:{membershipId:a.id,cycleId:t.cycleId,planVersionId:p.versionId,items:offer.items}});
   const [paid]=await withTenant(ctx,tx=>tx`select discount_cents,tax_cents,total_cents from tickets where id=${t.ticketId}`);
   expect(paid).toMatchObject({discount_cents:1000,tax_cents:mode==='exclusive'?675:628,total_cents:total});
   await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=0,tax_calculation_mode='exclusive' where location_id=${ctx.locationId}`);
   await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:total,refundTipCents:432,refundMethod:'original_payment',reason:'customer_dissatisfied'});
   const [refund]=await withTenant(ctx,tx=>tx`select amount_cents,tax_cents,tip_cents,card_cents,membership_cents from ticket_refunds where ticket_id=${t.ticketId}`);
   expect(refund).toMatchObject({amount_cents:total,tax_cents:mode==='exclusive'?675:628,tip_cents:432,card_cents:total,membership_cents:0});
  }
 }finally{await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=${original!.sales_tax_rate_percent}::numeric,tax_calculation_mode=${original!.tax_calculation_mode} where location_id=${ctx.locationId}`);}
});
it('protects line price facts with source guards, immutable grants and tenant isolation',async()=>{
 const p=await plan('month',{discountBps:1000,discountServiceIds:[serviceId]}),a=await enroll(p);await processCommerceEvent(a.event());
 const t=await benefitTicket(a.id),offer=await discountOffer(t,a.id);
 await expect(withTenant(ctx,tx=>tx`insert into ticket_price_adjustments(org_id,location_id,ticket_id,ticket_item_id,kind,original_cents,discount_cents,customer_membership_id,cycle_id,plan_version_id,business_date,rule_snapshot)
  select ${ctx.orgId},${ctx.locationId},id,${t.itemIds[0]!},'membership',10000,999,${a.id},${t.cycleId},${p.versionId},business_date,'{"discountBps":1000}'::jsonb from tickets where id=${t.ticketId}`)).rejects.toBeDefined();
 await run('ticket.pay',{ticketId:t.ticketId,payments:[{method:'card',amountCents:9000,tipCents:0,changeCents:0,keepChange:false}],
  membershipDiscount:{membershipId:a.id,cycleId:t.cycleId,planVersionId:p.versionId,items:offer.items}});
 await expect(withTenant(ctx,tx=>tx`update ticket_price_adjustments set discount_cents=1 where ticket_id=${t.ticketId}`)).rejects.toBeDefined();
 await expect(withTenant(ctx,tx=>tx`delete from ticket_price_adjustments where ticket_id=${t.ticketId}`)).rejects.toBeDefined();
 expect(await withTenant({...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'},tx=>tx`select id from ticket_price_adjustments where ticket_id=${t.ticketId}`)).toHaveLength(0);
 const [grants]=await withTenant(ctx,tx=>tx`select relrowsecurity and relforcerowsecurity as force_rls,
  has_table_privilege('app_user','ticket_price_adjustments','UPDATE,DELETE,TRUNCATE') as mutable,
  has_table_privilege('anon','ticket_price_adjustments','SELECT') as public_read from pg_class where oid='ticket_price_adjustments'::regclass`);
 expect(grants).toEqual({force_rls:true,mutable:false,public_read:false});
});
it('redeems a specific paid membership unit once and refunds its service back to the original unit, never cash',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const t=await benefitTicket(a.id);
 const payload={ticketId:t.ticketId,payments:[],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]},key=randomUUID();
 await run('ticket.pay',payload,key);await run('ticket.pay',payload,key);
 const [used]=await withTenant(ctx,tx=>tx`select c.available_units,(select count(*)::int from customer_membership_ledger l where l.cycle_id=c.id and entry='redeem') as redeems,
  (select total_cents from tickets where id=${t.ticketId}) as service_total,(select coalesce(sum(amount_cents),0)::int from payments where ticket_id=${t.ticketId}) as new_cash
  from customer_membership_cycles c where id=${t.cycleId}`);expect(used).toMatchObject({available_units:'{}',redeems:1,service_total:10000,new_cash:0});
 await expect(run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:10000,refundMethod:'cash',reason:'customer_dissatisfied'})).rejects.toMatchObject({details:{reason:'membership_refund_requires_original_method'}});
 const refund={ticketId:t.ticketId,refundAmountCents:10000,refundMethod:'original_payment',reason:'customer_dissatisfied'},refundKey=randomUUID();
 await run('ticket.refund',refund,refundKey);await run('ticket.refund',refund,refundKey);
 const [restored]=await withTenant(ctx,tx=>tx`select c.available_units,(select count(*)::int from customer_membership_ledger where cycle_id=c.id and entry='restore') as restored,
  (select sum(membership_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as member_return,
  (select sum(cash_cents+card_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as cash_return
  from customer_membership_cycles c where id=${t.cycleId}`);expect(restored).toMatchObject({available_units:'{[0,1)}',restored:1,member_return:10000,cash_return:0});
});
it('serializes two cashiers competing for the last paid membership unit',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const one=await benefitTicket(a.id),two=await benefitTicket(a.id);
 const pay=(t:typeof one)=>run('ticket.pay',{ticketId:t.ticketId,payments:[],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]});
 const outcomes=await Promise.allSettled([pay(one),pay(two)]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const rows=await withTenant(ctx,tx=>tx`select id from customer_membership_ledger where cycle_id=${one.cycleId} and entry='redeem'`);expect(rows).toHaveLength(1);
});
it('keeps per-unit paid values and commission snapshots after catalog changes and restores the exact units',async()=>{
 const p=await plan('month',{amountCents:10000,quantity:3}),a=await enroll(p);await processCommerceEvent(a.event());
 await run('commerce.saveMembershipPlan',{planId:p.planId,expectedVersion:p.version,terms:{...p.terms,amountCents:50000,quantity:1},active:true,onlineSale:true});
 const t=await benefitTicket(a.id,[10000,20000]);await run('ticket.pay',{ticketId:t.ticketId,payments:[],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]});
 const used=await withTenant(ctx,tx=>tx`select value_cents,unit_ranges from customer_membership_ledger where cycle_id=${t.cycleId} and entry='redeem' order by unit_ranges`);
 expect(used).toEqual([{value_cents:-3333,unit_ranges:'{[0,1)}'},{value_cents:-3333,unit_ranges:'{[1,2)}'}]);
 const [earnings]=await withTenant(ctx,tx=>tx`select sum(base_cents)::int as base from earnings where ticket_id=${t.ticketId} and kind='commission'`);expect(earnings!.base).toBe(6666);
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:30000,refundMethod:'original_payment',reason:'customer_dissatisfied'});
 const [restored]=await withTenant(ctx,tx=>tx`select available_units from customer_membership_cycles where id=${t.cycleId}`);expect(restored!.available_units).toBe('{[0,3)}');
});
it('accumulates partial service returns without restoring fractional or duplicate membership sessions',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const t=await benefitTicket(a.id);
 await run('ticket.pay',{ticketId:t.ticketId,payments:[{method:'cash',amountCents:1000,tipCents:1000}],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]});
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:5000,refundTipCents:0,refundMethod:'original_payment',reason:'customer_dissatisfied'});
 expect((await withTenant(ctx,tx=>tx`select available_units from customer_membership_cycles where id=${t.cycleId}`))[0]!.available_units).toBe('{}');
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:6000,refundTipCents:1000,refundMethod:'original_payment',reason:'customer_dissatisfied'});
 const [r]=await withTenant(ctx,tx=>tx`select (select count(*)::int from customer_membership_ledger where cycle_id=${t.cycleId} and entry='restore') as restored,
  (select sum(membership_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as member_return,(select sum(cash_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as tips`);
 expect(r).toEqual({restored:1,member_return:10000,tips:1000});
});
it('rolls back selected membership coverage when amounts, source, role or item identity are invalid',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());const t=await benefitTicket(a.id),b=await enroll(await plan());
 const payload={ticketId:t.ticketId,payments:[{method:'cash',amountCents:10000}],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]};
 await expect(run('ticket.pay',payload)).rejects.toMatchObject({code:'PAYMENT_MISMATCH'});
 await expect(run('ticket.pay',{...payload,payments:[],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:[...t.itemIds,...t.itemIds]}]})).rejects.toMatchObject({details:{reason:'duplicate_membership_redemption'}});
 const noFinance={...ctx,permissions:new Set([...ctx.permissions].filter(p=>p!=='commerce.sell'))};
 await expect(dispatch('ticket.pay',{...payload,payments:[]},noFinance,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 const other=await withTenant(ctx,tx=>tx<{customer_id:string}[]>`select customer_id from customer_paid_memberships where id=${b.id}`);
 await withTenant(ctx,tx=>tx`update tickets set customer_id=${other[0]!.customer_id} where id=${t.ticketId}`);
 await expect(run('ticket.pay',{...payload,payments:[]})).rejects.toMatchObject({details:{reason:'membership_unavailable'}});
 const [unchanged]=await withTenant(ctx,tx=>tx`select available_units from customer_membership_cycles where id=${t.cycleId}`);expect(unchanged!.available_units).toBe('{[0,1)}');
});
it('enforces plan permission, finite quotas and immutable versioned prices',async()=>{
 const p=await plan();const denied={...ctx,permissions:new Set<Permission>()};
 await expect(dispatch('commerce.saveMembershipPlan',{terms:p.terms,active:true,onlineSale:true},denied,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 await expect(run('commerce.saveMembershipPlan',{terms:{...p.terms,quantity:0},active:true,onlineSale:true})).rejects.toBeDefined();
 await expect(withTenant(ctx,tx=>tx`update customer_membership_plan_versions set terms='{}'::jsonb where id=${p.versionId}`)).rejects.toBeDefined();
 const next=await run<{versionId:string;version:number}>('commerce.saveMembershipPlan',{planId:p.planId,expectedVersion:p.version,terms:{...p.terms,amountCents:11900},active:true,onlineSale:true});
 expect(next.version).toBe(2);expect(next.versionId).not.toBe(p.versionId);
 await expect(enroll(p)).rejects.toMatchObject({details:{reason:'membership_plan_changed'}});
});
it('expires missed annual periods, issues only the current paid batch, and schedules its expiry without duplicate workers',async()=>{
 const a=await enroll(await plan('year')),start=new Date();start.setUTCDate(1);start.setUTCHours(12,0,0,0);start.setUTCMonth(start.getUTCMonth()-2);
 const end=new Date(start);end.setUTCFullYear(end.getUTCFullYear()+1);a.invoice.lines.data[0]!.period={start:start.getTime()/1000,end:end.getTime()/1000};
 await processCommerceEvent(a.event());
 const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`update commerce_tasks set retry_at=now() where kind='membership_grant' and subject_id=${a.id} returning id`);
 await Promise.all([runCommerceTask(workerContext(ctx.orgId,ctx.locationId),task!.id),runCommerceTask(workerContext(ctx.orgId,ctx.locationId),task!.id)]);
 const rows=await withTenant(ctx,tx=>tx`select status,count(*)::int as n from customer_membership_cycles where membership_id=${a.id} group by status`);
 expect(rows).toEqual(expect.arrayContaining([{status:'expired',n:2},{status:'issued',n:1},{status:'planned',n:9}]));
 const expiry=await withTenant(ctx,tx=>tx`select l.id,l.quantity from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${a.id} and l.entry='expire'`);
 expect(expiry).toHaveLength(2);expect(expiry.every(l=>l.quantity===0)).toBe(true);
 const [pending]=await withTenant(ctx,tx=>tx`select status,retry_at>now() as future from commerce_tasks where id=${task!.id}`);expect(pending).toMatchObject({status:'pending',future:true});
});
it('keeps the original expiry when a fully returned service restores a membership unit after its period has ended',async()=>{
 const a=await enroll(await plan()),end=new Date(Math.ceil(Date.now()/1000)*1000+2500),start=new Date(end);start.setUTCMonth(start.getUTCMonth()-1);
 a.invoice.lines.data[0]!.period={start:Math.floor(start.getTime()/1000),end:Math.floor(end.getTime()/1000)};await processCommerceEvent(a.event());
 const t=await benefitTicket(a.id);await run('ticket.pay',{ticketId:t.ticketId,payments:[],membershipRedemptions:[{cycleId:t.cycleId,ticketItemIds:t.itemIds}]});
 await new Promise(resolve=>setTimeout(resolve,Math.max(1,a.invoice.lines.data[0]!.period.end*1000-Date.now()+30)));
 await dispatchSystem('commerce.grantMembershipCycles',{membershipId:a.id},ctx,{idempotencyKey:randomUUID()});
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:10000,refundMethod:'original_payment',reason:'customer_dissatisfied'});
 const [cycle]=await withTenant(ctx,tx=>tx`select available_units,status from customer_membership_cycles where id=${t.cycleId}`);expect(cycle).toMatchObject({available_units:'{}',status:'expired'});
 const [ledger]=await withTenant(ctx,tx=>tx`select sum(quantity)::int as balance,count(*) filter(where entry='restore')::int as restores from customer_membership_ledger where cycle_id=${t.cycleId}`);
 expect(ledger).toMatchObject({balance:0,restores:1});
},8000);
it('keeps shared contact information separate, requires explicit consent, and deduplicates an unknown enrollment result',async()=>{
 const p=await plan(),a=await enroll(p),again=await dispatchSystem<{membershipId:string}>('commerce.enrollMembership',a.input,ctx,{idempotencyKey:randomUUID()});
 expect(again.result.membershipId).toBe(a.id);
 await expect(dispatchSystem('commerce.enrollMembership',{...a.input,businessKey:randomUUID(),consent:{...a.input.consent,accepted:false}},ctx,{idempotencyKey:randomUUID()})).rejects.toBeDefined();
 const b=await enroll(p);const rows=await withTenant(ctx,tx=>tx<{customer_id:string}[]>`select customer_id from customer_paid_memberships where id=any(${[a.id,b.id]}::uuid[])`);
 expect(new Set(rows.map(r=>r.customer_id)).size).toBe(2);
 await expect(dispatchSystem('commerce.enrollMembership',{...a.input,customer:{...a.input.customer,name:'Changed'}},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({details:{reason:'purchase_key_reused'}});
});
it('does not grant for active subscriptions, unpaid invoices, out-of-band settlement, wrong account or mode',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event('customer.subscription.updated',a.sub));
 a.invoice.status='open';expect(await processCommerceEvent(a.event())).toBe('membership_awaiting_payment');
 const before=await withTenant(ctx,tx=>tx`select id from customer_membership_cycles where membership_id=${a.id}`);expect(before).toHaveLength(0);
 a.invoice.status='paid';a.intent.status='requires_action';await expect(processCommerceEvent(a.event())).rejects.toMatchObject({details:{reason:'membership_invoice_cash_unverified'}});
 a.intent.status='succeeded';await expect(processCommerceEvent({...a.event(),account:'acct_wrong'})).resolves.toBe('ignored_unmapped_account');
 await expect(processCommerceEvent({...a.event(),livemode:true})).rejects.toMatchObject({details:{reason:'commerce_event_wrong_mode'}});
 const after=await withTenant(ctx,tx=>tx`select id from customer_membership_cycles where membership_id=${a.id}`);expect(after).toHaveLength(0);
});
it('records one $99 invoice and one benefit despite duplicate events, concurrent webhook processing and changed catalog',async()=>{
 const p=await plan(),a=await enroll(p),event=a.event();
 await run('commerce.saveMembershipPlan',{planId:p.planId,expectedVersion:p.version,terms:{...p.terms,amountCents:14900,quantity:3},active:true,onlineSale:true});
 await Promise.all([processCommerceEvent(event),processCommerceEvent(a.event())]);await processCommerceEvent(event);
 const [row]=await withTenant(ctx,tx=>tx<{bills:number;cycles:number;issues:number;value:number;cash:number;quantity:number}[]>`select
  (select count(*)::int from customer_membership_invoices where membership_id=${a.id}) as bills,
  (select count(*)::int from customer_membership_cycles where membership_id=${a.id}) as cycles,
  (select count(*)::int from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${a.id}) as issues,
  (select sum(value_cents)::int from customer_membership_cycles where membership_id=${a.id}) as value,
  (select sum(quantity)::int from customer_membership_cycles where membership_id=${a.id}) as quantity,
  (select amount_cents from commerce_payments where order_id=${a.orderId}) as cash`);
 expect(row).toMatchObject({bills:1,cycles:1,issues:1,value:9900,cash:9900,quantity:1});
});
it('plans all 12 annual calendar batches, grants only due benefits, and two workers cannot issue twice',async()=>{
 const a=await enroll(await plan('year'));await processCommerceEvent(a.event());
 const before=await withTenant(ctx,tx=>tx<{status:string;value_cents:number}[]>`select status,value_cents from customer_membership_cycles where membership_id=${a.id}`);
 expect(before).toHaveLength(12);expect(before.reduce((sum,b)=>sum+b.value_cents,0)).toBe(99900);expect(before.filter(b=>b.status==='issued')).toHaveLength(1);
 const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`update commerce_tasks set retry_at=now() where kind='membership_grant' and subject_id=${a.id} returning id`);
 const worker=workerContext(ctx.orgId,ctx.locationId);await Promise.all([runCommerceTask(worker,task!.id),runCommerceTask(worker,task!.id)]);
 const issues=await withTenant(ctx,tx=>tx`select l.id from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${a.id}`);expect(issues).toHaveLength(1);
});
it('accepts a recovered paid renewal once; cancel-at-end and old active events cannot resurrect terminal subscriptions',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());
 a.sub.cancel_at_period_end=true;await processCommerceEvent(a.event('customer.subscription.updated',a.sub));
 a.sub.status='canceled';await processCommerceEvent(a.event('customer.subscription.deleted',a.sub));
 a.sub.status='active';await processCommerceEvent(a.event('customer.subscription.updated',a.sub));
 const [m]=await withTenant(ctx,tx=>tx<{provider_status:string}[]>`select provider_status from customer_paid_memberships where id=${a.id}`);expect(m!.provider_status).toBe('canceled');
 a.sub.status='canceled';const start=a.invoice.lines.data[0]!.period.end,end=new Date(start*1000);end.setUTCMonth(end.getUTCMonth()+1);
 a.invoice.id=`in_renewal_${randomUUID()}`;a.invoice.lines.data[0]!.period={start,end:end.getTime()/1000};a.intent.id=`pi_renewal_${randomUUID()}`;
 vi.mocked(commerceStripeClient().invoicePayments.list).mockResolvedValue({has_more:false,data:[{invoice:a.invoice.id,livemode:false,status:'paid',amount_paid:9900,payment:{payment_intent:a.intent.id}}]} as unknown as Stripe.Response<Stripe.ApiList<Stripe.InvoicePayment>>);
 await processCommerceEvent(a.event());await processCommerceEvent(a.event());
 const bills=await withTenant(ctx,tx=>tx`select id from customer_membership_invoices where membership_id=${a.id}`);expect(bills).toHaveLength(2);
});
it('requires a resource-specific expiring bearer, with no access from another token, store or employee role',async()=>{
 const a=await enroll(await plan()),b=await enroll(await plan());await processCommerceEvent(b.event());
 const [m]=await withTenant(ctx,tx=>tx<{manage_token_wrapped:Buffer;manage_token_hash:string}[]>`select manage_token_wrapped,manage_token_hash from customer_paid_memberships where id=${b.id}`);
 const token=unwrapManageToken(m!.manage_token_wrapped,m!.manage_token_hash)!;
 const response=await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${b.id}`,headers:{'x-gf-commerce-token':token}});
 expect(response.statusCode).toBe(200);expect(response.json().cycles[0].available_quantity).toBe(1);expect(response.json().membership.customer_id).toBeUndefined();
 expect((await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':token}})).statusCode).toBe(404);
 await withTenant(ctx,tx=>tx`update customer_paid_memberships set manage_token_expires_at=now()-interval '1 second' where id=${b.id}`);
 expect((await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${b.id}`,headers:{'x-gf-commerce-token':token}})).statusCode).toBe(404);
 expect(hashManageToken(token)).toBe(m!.manage_token_hash);
 const other={...tenant,locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'};
 expect(await withTenant(other,tx=>tx`select id from customer_paid_memberships where id=${b.id}`)).toHaveLength(0);
 await expect(withTenant(ctx,tx=>tx`update customer_membership_invoices set period_end=period_end+interval '1 day' where membership_id=${b.id}`)).rejects.toBeDefined();
});
it('verifies signatures and keeps the platform SaaS domain out of customer benefits',async()=>{
 const a=await enroll(await plan()),event=a.event(),payload=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000);
 const signature=createHmac('sha256','whsec_membership_fixture').update(`${timestamp}.${payload}`).digest('hex');
 expect((await app.inject({method:'POST',url:'/v1/stripe/commerce-webhook',headers:{'content-type':'application/json','stripe-signature':`t=${timestamp},v1=wrong`},payload})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/stripe/commerce-webhook',headers:{'content-type':'application/json','stripe-signature':`t=${timestamp},v1=${signature}`},payload})).statusCode).toBe(200);
 a.sub.metadata.gf_domain='platform_billing';expect(await processCommerceEvent(a.event('customer.subscription.updated',a.sub))).toBe('ignored_other_domain');
});
it('controls new memberships independently from gift sales while preserving paid benefits after sales close',async()=>{
 const p=await plan();await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:true});
 try{
  const a=await enroll(p);await processCommerceEvent(a.event());
  await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
  await expect(enroll(p)).rejects.toMatchObject({details:{reason:'new_memberships_disabled'}});
  const replay=await dispatchSystem<{membershipId:string}>('commerce.enrollMembership',a.input,ctx,{idempotencyKey:randomUUID()});expect(replay.result.membershipId).toBe(a.id);
  const result=await dispatchSystem<{issued:number}>('commerce.grantMembershipCycles',{membershipId:a.id},ctx,{idempotencyKey:randomUUID()});expect(result.result.issued).toBe(0);
  const [row]=await withTenant(ctx,tx=>tx<{n:number}[]>`select count(*)::int as n from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${a.id}`);
  expect(row!.n).toBe(1);
 }finally{await run('commerce.saveSettings',{salesEnabled:true,depositsEnabled:true,membershipsEnabled:true});}
});
it('authorizes a connected-account portal for this membership without changing the default/SaaS configuration',async()=>{
 const a=await portalFixture();await run('commerce.saveSettings',{salesEnabled:false,depositsEnabled:true,membershipsEnabled:false});
 try{
  await dispatchSystem('billing.syncSubscription',{plan:'voice_booking',subscriptionStatus:'past_due'},ctx);
  const response=await a.post();expect(response.statusCode).toBe(200);expect(response.json().url).toBe('https://billing.stripe.com/p/session/test_fixture');
  expect(a.create).toHaveBeenCalledWith(expect.objectContaining({customer:a.sub.customer,configuration:a.config.id,locale:'zh',return_url:expect.stringContaining(`#m/${a.token}`)}),
   expect.objectContaining({stripeAccount:account,idempotencyKey:expect.stringContaining(a.id)}));
  expect(commerceStripeClient().billingPortal.configurations.list).toHaveBeenCalledWith({active:true,limit:100},{stripeAccount:account});
  const json=(await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':a.token}})).json();
  expect(json.portalAvailable).toBe(true);expect(json.membership.stripe_customer_id).toBeUndefined();expect(json.membership.account_id).toBeUndefined();
 }finally{await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await run('commerce.saveSettings',{salesEnabled:true,depositsEnabled:true,membershipsEnabled:true});}
});
it('denies portal tampering and revalidates an expired/revoked token even on idempotent authorization replay',async()=>{
 const a=await portalFixture(),key=randomUUID();expect((await a.post({},key)).statusCode).toBe(200);
 expect((await a.post({customerId:'cus_other',stripeAccount:'acct_other'})).statusCode).toBe(400);
 expect((await a.post({},randomUUID(),randomUUID())).statusCode).toBe(404);
 await withTenant(ctx,tx=>tx`update customer_paid_memberships set manage_token_revoked_at=now(),manage_access_version=manage_access_version+1 where id=${a.id}`);
 expect((await a.post({},key)).statusCode).toBe(404);expect(a.create).toHaveBeenCalledTimes(1);
});
it('rejects a portal with other provider subscriptions or broadened configuration features',async()=>{
 const a=await portalFixture();vi.mocked(commerceStripeClient().subscriptions.list).mockReturnValue(iterable([a.sub,{...a.sub,id:'sub_other'}]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>);
 expect((await a.post()).statusCode).toBe(400);expect(a.create).not.toHaveBeenCalled();
 vi.mocked(commerceStripeClient().subscriptions.list).mockReturnValue(iterable([a.sub]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>);
 a.config.features.subscription_update.enabled=true;expect((await a.post()).statusCode).toBe(400);expect(a.create).not.toHaveBeenCalled();
 a.config.features.subscription_update.enabled=false;
 vi.mocked(commerceStripeClient().invoices.list).mockReturnValue(iterable([a.invoice,{...a.invoice,id:'in_other',parent:null}]) as unknown as Stripe.ApiListPromise<Stripe.Invoice>);
 expect((await a.post()).statusCode).toBe(400);expect(a.create).not.toHaveBeenCalled();
});
it('records cancel/resume/failed-payment notices once and leaves the paid benefit untouched',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());a.sub.cancel_at_period_end=true;
 await Promise.all([processCommerceEvent(a.event('customer.subscription.updated',a.sub)),processCommerceEvent(a.event('customer.subscription.updated',a.sub))]);
 a.sub.cancel_at_period_end=false;await processCommerceEvent(a.event('customer.subscription.updated',a.sub));a.sub.status='past_due';
 a.invoice.status='open';await processCommerceEvent(a.event('invoice.payment_failed',a.invoice));await processCommerceEvent(a.event('invoice.payment_failed',a.invoice));
 const rows=await withTenant(ctx,tx=>tx<{entity_type:string;n:number}[]>`select entity_type,count(*)::int as n from email_outbox
  where commerce_order_id=${a.orderId} and entity_type like 'customer_membership_%' group by entity_type order by entity_type`);
 expect(rows).toEqual(expect.arrayContaining([{entity_type:'customer_membership_cancellationNotice',n:1},{entity_type:'customer_membership_renewalRestored',n:1},{entity_type:'customer_membership_paymentFailedNotice',n:1}]));
 const [balance]=await withTenant(ctx,tx=>tx<{n:number}[]>`select count(*)::int as n from customer_membership_cycles where membership_id=${a.id} and status='issued'`);expect(balance!.n).toBe(1);
});
it('recognizes the flexible portal cancel_at fact even when the provider period-end boolean remains false',async()=>{
 const a=await enroll(await plan());await processCommerceEvent(a.event());a.sub.cancel_at=a.sub.items.data[0]!.current_period_end;
 const update=a.event('customer.subscription.updated',a.sub);await processCommerceEvent(update);await processCommerceEvent(update);
 const [m]=await withTenant(ctx,tx=>tx<{cancel_at_period_end:boolean;provider_cancel_at_period_end:boolean;scheduled_cancel_at:string}[]>`
  select cancel_at_period_end,provider_cancel_at_period_end,scheduled_cancel_at from customer_paid_memberships where id=${a.id}`);
 expect(m).toMatchObject({cancel_at_period_end:true,provider_cancel_at_period_end:false});expect(new Date(m!.scheduled_cancel_at).getTime()/1000).toBe(a.sub.cancel_at);
 const notices=await withTenant(ctx,tx=>tx`select id from email_outbox where commerce_order_id=${a.orderId} and entity_type='customer_membership_cancellationNotice'`);expect(notices).toHaveLength(1);
 expect(membershipCancellationFact({cancel_at:a.sub.cancel_at+86400,cancel_at_period_end:false},a.sub.cancel_at).cancelAtPeriodEnd).toBe(false);
 a.sub.cancel_at=null;await processCommerceEvent(a.event('customer.subscription.updated',a.sub));
 const [resumed]=await withTenant(ctx,tx=>tx<{cancel_at_period_end:boolean;scheduled_cancel_at:string|null}[]>`select cancel_at_period_end,scheduled_cancel_at from customer_paid_memberships where id=${a.id}`);
 expect(resumed).toMatchObject({cancel_at_period_end:false,scheduled_cancel_at:null});
});

it('conserves membership, package, discount, deposit, gift, credit, cash, tax, fee and tips through three original-source returns',async()=>{
 const qaService=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Mixed original sources QA'},durationMin:30,basePriceCents:10000})).serviceId;
 const p=await plan('month',{serviceIds:[qaService],discountBps:1000,discountServiceIds:[qaService]}),a=await enroll(p);await processCommerceEvent(a.event());
 const [m]=await withTenant(ctx,tx=>tx<{customer_id:string}[]>`select customer_id from customer_paid_memberships where id=${a.id}`),customerId=m!.customer_id;
 const [staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const [settings]=await withTenant(ctx,tx=>tx`select settings from locations where id=${ctx.locationId}`);
 const [checkout]=await withTenant(ctx,tx=>tx`select sales_tax_rate_percent,tax_calculation_mode from location_checkout_settings where location_id=${ctx.locationId}`);
 try{
  await withTenant(ctx,async tx=>{await tx`update locations set settings=jsonb_set(jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb),'{online_booking}',${jsonb({enabled:true,deposit_required:true,deposit_amount_cents:2000,min_minutes_ahead:0,cancel_cutoff_hours:4})}::jsonb) where id=${ctx.locationId}`;
   await tx`update location_checkout_settings set sales_tax_rate_percent=0,tax_calculation_mode='exclusive' where location_id=${ctx.locationId}`;});
  const credit=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId:qaService,membershipId:staff!.membership_id,priceCentsOverride:1000}]});
  await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${credit.ticketId}`);
  await run('ticket.pay',{ticketId:credit.ticketId,payments:[{method:'cash',amountCents:1000}]});await run('ticket.refund',{ticketId:credit.ticketId,refundAmountCents:1000,refundMethod:'store_credit',reason:'other'});
  const template=await run<{templateId:string}>('package.saveTemplate',{name:{en:'Mixed quota QA'},priceCents:5000,sessions:1,serviceIds:[qaService],coverageMode:'any_included',commissionBasis:'sale_price',active:true});
  const pkg=await run<{assetId:string}>('commerce.createOrder',{kind:'package',channel:'offline',templateId:template.templateId,customerId,businessKey:randomUUID(),offlinePayment:{method:'cash',amountCents:5000,reference:'Mixed quota receipt'}});
  const gift=await run<{assetId:string}>('commerce.createOrder',{kind:'gift_card',channel:'offline',customerId,businessKey:randomUUID(),faceValueCents:10000,salePriceCents:8000,offlinePayment:{method:'cash',amountCents:8000,reference:'Mixed gift receipt'}});
  const h=await run<{holdId:string;appointmentId:string}>('commerce.holdAppointment',{businessKey:randomUUID(),appointment:{customerId,source:'desk',override:{reason:'desk_coordination'},items:Array.from({length:3},(_,i)=>({serviceId:qaService,startsAt:new Date(Date.now()+(i+1)*60000).toISOString()}))}});
  await run('commerce.recordOfflineDeposit',{holdId:h.holdId,amountCents:2000,method:'cash',reference:'Mixed deposit receipt'});
  const ticket=await run<{ticketId:string}>('ticket.open',{appointmentId:h.appointmentId,customerId,items:Array.from({length:3},()=>({serviceId:qaService,membershipId:staff!.membership_id}))});
  const items=await withTenant(ctx,tx=>tx<{id:string}[]>`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId} returning id`);
  const [cycle]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from customer_membership_cycles where membership_id=${a.id} and status='issued' and starts_at<=now() and ends_at>now()`);
  const ordered=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from ticket_items where ticket_id=${ticket.ticketId} order by seq,id`);
  const offers=await withTenant(ctx,tx=>loadMembershipDiscountOffers(tx,ctx,[{ticketId:ticket.ticketId,customerId}])),offer=offers.get(ticket.ticketId)![0]!;
  await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=6.5 where location_id=${ctx.locationId}`);
  const checkoutInput={ticketId:ticket.ticketId,surchargeCents:200,taxCents:585,
   membershipRedemptions:[{cycleId:cycle!.id,ticketItemIds:[ordered[0]!.id]}],packageRedemptions:[{customerPackageId:pkg.assetId,units:1}],
   membershipDiscount:{membershipId:a.id,cycleId:cycle!.id,planVersionId:p.versionId,items:[offer.items.find(i=>i.ticketItemId===ordered[2]!.id)!]},depositApplication:{holdId:h.holdId,amountCents:2000},
   payments:[{method:'gift_card',giftCardId:gift.assetId,amountCents:3000},{method:'customer_credit',amountCents:1000},{method:'cash',amountCents:4785,tipCents:1000}]};
  const unchanged=()=>withTenant(ctx,tx=>tx`select (select available_units from customer_membership_cycles where id=${cycle!.id}) as member_units,(select remaining_sessions from customer_packages where id=${pkg.assetId}) as package_units,(select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${h.holdId}) as deposit,(select count(*)::int from ticket_price_adjustments where ticket_id=${ticket.ticketId}) as prices,(select count(*)::int from payments where ticket_id=${ticket.ticketId}) as payments`);
  const beforeQuote=await unchanged();
  const quote=await run<{quoteHash:string;amountDueCents:number;discountCents:number;taxCents:number;depositCents:number}>('ticket.quoteCheckout',{...checkoutInput,tipCents:1000,storedValuePayments:checkoutInput.payments.filter(p=>['gift_card','customer_credit'].includes(p.method))});
  expect(quote).toMatchObject({amountDueCents:8785,discountCents:1000,taxCents:585,depositCents:2000});expect(await unchanged()).toEqual(beforeQuote);
  await run('ticket.pay',{...checkoutInput,expectedQuoteHash:quote.quoteHash});
  const sources=await withTenant(ctx,tx=>tx`select kind,amount_cents,tip_cents,tax_cents,fee_cents from ticket_settlement_sources where ticket_id=${ticket.ticketId} order by kind`);
  expect(sources.map(s=>s.kind)).toEqual(['cash','deposit','gift_card','membership','package','store_credit']);expect(sources.reduce((n,s)=>n+s.amount_cents,0)).toBe(30785);
  expect(sources.reduce((n,s)=>n+s.tax_cents,0)).toBe(585);expect(sources.reduce((n,s)=>n+s.fee_cents,0)).toBe(200);expect(sources.find(s=>s.kind==='cash')!.tip_cents).toBe(1000);
  const request={ticketId:ticket.ticketId,refundAmountCents:14500,refundMethod:'original_payment',reason:'other'},key=randomUUID();
  const review=await run<{reviewHash:string;destinations:Array<{kind:string;amountCents:number}>}>('ticket.reviewRefund',request);expect(review.destinations.reduce((n,d)=>n+d.amountCents,0)).toBe(14500);
  await run('ticket.refund',{...request,reviewHash:review.reviewHash},key);await run('ticket.refund',{...request,reviewHash:review.reviewHash},key);
  await expect(run('ticket.refund',{...request,reviewHash:review.reviewHash})).rejects.toMatchObject({details:{reason:'refund_review_changed'}});
  const [partial]=await withTenant(ctx,tx=>tx`select remaining_sessions from customer_packages where id=${pkg.assetId}`);expect(partial!.remaining_sessions).toBe(0);
  await expect(run('ticket.void',{ticketId:ticket.ticketId,reason:'other'})).rejects.toBeDefined();
  await run('ticket.refund',request);await run('ticket.refund',{...request,refundAmountCents:1785,refundTipCents:1000});
  const [final]=await withTenant(ctx,tx=>tx`select t.status,t.refund_cents,(select remaining_sessions from customer_packages where id=${pkg.assetId}) as package_units,
   (select count(*)::int from customer_membership_ledger where cycle_id=${cycle!.id} and entry='restore') as member_restores,
   (select balance_cents from gift_cards where id=${gift.assetId}) as gift_balance,
   (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${h.holdId}) as deposit_balance,
   (select sum(amount_cents)::int from customer_credit_ledger where customer_id=${customerId} and kind='store_credit') as credit_balance,
   (select sum(cash_cents)::int from ticket_refunds where ticket_id=t.id) as cash_return,
   (select sum(r.amount_cents)::int from ticket_source_refunds r join ticket_settlement_sources s on s.id=r.source_id where s.ticket_id=t.id) as source_return,
   (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as net_commission,
   (select sum(amount_cents)::int from tip_allocations where ticket_id=t.id) as net_tip from tickets t where id=${ticket.ticketId}`);
  expect(final).toMatchObject({status:'refunded',refund_cents:30785,package_units:1,member_restores:1,gift_balance:10000,deposit_balance:2000,credit_balance:1000,cash_return:4785,source_return:30785,net_commission:0,net_tip:0});
  expect(items).toHaveLength(3);
 }finally{await withTenant(ctx,async tx=>{await tx`update locations set settings=${jsonb(settings!.settings)}::jsonb where id=${ctx.locationId}`;await tx`update location_checkout_settings set sales_tax_rate_percent=${checkout!.sales_tax_rate_percent},tax_calculation_mode=${checkout!.tax_calculation_mode} where location_id=${ctx.locationId}`;});}
});

it('conserves all six payment sources across a quoted three-ticket group and each original service return',async()=>{
 const day=await withTenant(ctx,tx=>resolveDate(tx,ctx.locationId)),beforeDay=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day));
 const serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Group six-source QA'},durationMin:30,basePriceCents:10000})).serviceId;
 const p=await plan('month',{serviceIds:[serviceId],discountBps:1000,discountServiceIds:[serviceId]}),member=await enroll(p);await processCommerceEvent(member.event());
 const [customer]=await withTenant(ctx,tx=>tx<{customer_id:string}[]>`select customer_id from customer_paid_memberships where id=${member.id}`),customerId=customer!.customer_id;
 const [staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`),[settings]=await withTenant(ctx,tx=>tx`select settings from locations where id=${ctx.locationId}`),[checkout]=await withTenant(ctx,tx=>tx`select sales_tax_rate_percent,tax_calculation_mode from location_checkout_settings where location_id=${ctx.locationId}`);
 try{
  await withTenant(ctx,async tx=>{await tx`update locations set settings=jsonb_set(jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb),'{online_booking}',${jsonb({enabled:true,deposit_required:true,deposit_amount_cents:2000,min_minutes_ahead:0,cancel_cutoff_hours:4})}::jsonb) where id=${ctx.locationId}`;await tx`update location_checkout_settings set sales_tax_rate_percent=0,tax_calculation_mode='exclusive' where location_id=${ctx.locationId}`;});
  const credit=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:1000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${credit.ticketId}`);
  await run('ticket.pay',{ticketId:credit.ticketId,payments:[{method:'cash',amountCents:1000}]});await run('ticket.refund',{ticketId:credit.ticketId,refundAmountCents:1000,refundMethod:'store_credit',reason:'other'});
  const template=await run<{templateId:string}>('package.saveTemplate',{name:'Group package',priceCents:5000,sessions:1,serviceIds:[serviceId],coverageMode:'any_included',commissionBasis:'sale_price'}),pkg=await run<{assetId:string}>('commerce.createOrder',{kind:'package',channel:'offline',templateId:template.templateId,customerId,businessKey:randomUUID(),offlinePayment:{method:'cash',amountCents:5000,reference:'Group package fixture'}});
  const gift=await run<{assetId:string}>('commerce.createOrder',{kind:'gift_card',channel:'offline',customerId,businessKey:randomUUID(),faceValueCents:10000,salePriceCents:8000,offlinePayment:{method:'cash',amountCents:8000,reference:'Group gift fixture'}});
  const hold=await run<{holdId:string;appointmentId:string}>('commerce.holdAppointment',{businessKey:randomUUID(),appointment:{customerId,source:'desk',override:{reason:'desk_coordination'},items:[{serviceId,startsAt:new Date(Date.now()+60000).toISOString()}]}});
  await run('commerce.recordOfflineDeposit',{holdId:hold.holdId,amountCents:2000,method:'cash',reference:'Group deposit fixture'});
  const ids:string[]=[],itemIds:string[]=[];
  for(let i=0;i<3;i++){const ticket=await run<{ticketId:string}>('ticket.open',{customerId,...(i===2?{appointmentId:hold.appointmentId}:{}),items:[{serviceId,membershipId:staff!.membership_id}]});ids.push(ticket.ticketId);const [item]=await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId} returning id`);itemIds.push(item!.id);}
  const group=await run<{groupId:string}>('ticket.group',{ticketIds:ids}),[cycle]=await withTenant(ctx,tx=>tx`select id from customer_membership_cycles where membership_id=${member.id} and status='issued' and starts_at<=now() and ends_at>now()`);
  const offers=await withTenant(ctx,tx=>loadMembershipDiscountOffers(tx,ctx,[{ticketId:ids[2]!,customerId}])),offer=offers.get(ids[2]!)![0]!;
  await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=6.5 where location_id=${ctx.locationId}`);
  const input={groupId:group.groupId,ticketIds:ids,surchargeCents:200,ticketSelections:[
   {ticketId:ids[0],membershipRedemptions:[{cycleId:cycle!.id,ticketItemIds:[itemIds[0]]}]},
   {ticketId:ids[1],packageRedemptions:[{customerPackageId:pkg.assetId,units:1}]},
   {ticketId:ids[2],membershipDiscount:{membershipId:member.id,cycleId:cycle!.id,planVersionId:p.versionId,items:offer.items},depositApplication:{holdId:hold.holdId,amountCents:2000},storedValuePayments:[{method:'gift_card',giftCardId:gift.assetId,amountCents:3000},{method:'customer_credit',amountCents:1000}]},
  ],payments:[{method:'cash',amountCents:4785,tipCents:1000}]};
  const quote=await run<{quoteHash:string;readyToPay:boolean;amountDueCents:number;taxCents:number;storedValueCents:number;depositCents:number;tickets:Array<{ticketId:string;totalCents:number;tipCents:number}>}>('ticket.quoteGroup',input);
  expect(quote).toMatchObject({readyToPay:true,amountDueCents:4785,taxCents:585,storedValueCents:4000,depositCents:2000});
  const [untouched]=await withTenant(ctx,tx=>tx`select (select remaining_sessions from customer_packages where id=${pkg.assetId}) as units,(select balance_cents from gift_cards where id=${gift.assetId}) as gift,(select count(*)::int from payments where ticket_id=any(${ids}::uuid[])) as payments`);expect(untouched).toMatchObject({units:1,gift:10000,payments:0});
  const key=randomUUID();await run('ticket.closeGroup',{...input,expectedQuoteHash:quote.quoteHash},key);await run('ticket.closeGroup',{...input,expectedQuoteHash:quote.quoteHash},key);
  const sources=await withTenant(ctx,tx=>tx`select kind,sum(amount_cents)::int as amount from ticket_settlement_sources where ticket_id=any(${ids}::uuid[]) group by kind order by kind`);expect(sources.map(s=>s.kind)).toEqual(['cash','deposit','gift_card','membership','package','store_credit']);expect(sources.reduce((n,s)=>n+s.amount,0)).toBe(30785);
  for(const q of quote.tickets)await run('ticket.refund',{ticketId:q.ticketId,refundAmountCents:q.totalCents,refundTipCents:q.tipCents,reason:'other'});
  const [final]=await withTenant(ctx,tx=>tx`select (select remaining_sessions from customer_packages where id=${pkg.assetId}) as units,(select balance_cents from gift_cards where id=${gift.assetId}) as gift,(select count(*)::int from customer_membership_ledger where cycle_id=${cycle!.id} and entry='restore') as restored_member,(select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${hold.holdId}) as deposit,(select sum(amount_cents)::int from customer_credit_ledger where customer_id=${customerId} and kind='store_credit') as credit,(select sum(base_cents)::int from earnings where ticket_id=any(${ids}::uuid[]) and kind='commission') as commission,(select sum(amount_cents)::int from tip_allocations where ticket_id=any(${ids}::uuid[])) as tips,(select sum(cash_cents)::int from ticket_refunds where ticket_id=any(${ids}::uuid[])) as cash`);
  expect(final).toMatchObject({units:1,gift:10000,restored_member:1,deposit:2000,credit:1000,commission:0,tips:0,cash:4785});
  const afterDay=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day)),before=beforeDay.commerce.currencies.find(c=>c.currency==='usd')!,after=afterDay.commerce.currencies.find(c=>c.currency==='usd')!;
  expect(afterDay.cashTakeCents-beforeDay.cashTakeCents).toBe(20785);expect(afterDay.movementsCents-beforeDay.movementsCents).toBe(-4785);expect(afterDay.tipCashCents-beforeDay.tipCashCents).toBe(0);
  expect(after.serviceRefundCreditIssuedCents-before.serviceRefundCreditIssuedCents).toBe(1000);expect(after.offlineCashReceivedCents-before.offlineCashReceivedCents).toBe(15000);expect(after.stripeReceivedCents-before.stripeReceivedCents).toBe(9900);
  expect(after.depositRemainingCents-before.depositRemainingCents).toBe(2000);expect(after.giftFaceRemainingCents-before.giftFaceRemainingCents).toBe(10000);expect(after.packageUnitsRemaining-before.packageUnitsRemaining).toBe(1);expect(after.membershipUnitsRemaining-before.membershipUnitsRemaining).toBe(1);
  for(const kind of ['membership','package','deposit','gift_card','store_credit']){const old=before.redemptions.find(r=>r.kind===kind),now=after.redemptions.find(r=>r.kind===kind)!;expect(now.appliedCents-(old?.appliedCents??0)).toBe(now.returnedCents-(old?.returnedCents??0));}
 }finally{await withTenant(ctx,async tx=>{await tx`update locations set settings=${jsonb(settings!.settings)}::jsonb where id=${ctx.locationId}`;await tx`update location_checkout_settings set sales_tax_rate_percent=${checkout!.sales_tax_rate_percent},tax_calculation_mode=${checkout!.tax_calculation_mode} where location_id=${ctx.locationId}`;});}
});

it('merges an explicitly selected identity without rewriting paid records, duplicating subscriptions or granting a shared-phone stranger its assets',async()=>{
 const serviceId=(await run<{serviceId:string}>('catalog.saveService',{name:{en:'Merge source service'},durationMin:30,basePriceCents:10000})).serviceId;
 const p=await plan('month',{serviceIds:[serviceId],discountBps:1000,discountServiceIds:[serviceId]}),member=await enroll(p);await processCommerceEvent(member.event());
 const [membership]=await withTenant(ctx,tx=>tx<{customer_id:string;manage_token_wrapped:Buffer;manage_token_hash:string}[]>`select customer_id,manage_token_wrapped,manage_token_hash from customer_paid_memberships where id=${member.id}`),source=membership!.customer_id;
 const contact='+12125550193';await run('customer.saveProfile',{customerId:source,name:'Original contract buyer',phoneE164:contact});
 const target=(await run<{customerId:string}>('customer.saveProfile',{name:'Approved identity target',phoneE164:contact,email:'membership@example.test'})).customerId;
 const stranger=(await run<{customerId:string}>('customer.saveProfile',{name:'Shared-phone separate person',phoneE164:contact,email:'membership@example.test'})).customerId;
 expect(new Set([source,target,stranger]).size).toBe(3);
 const [staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`),[settings]=await withTenant(ctx,tx=>tx`select settings from locations where id=${ctx.locationId}`),[checkout]=await withTenant(ctx,tx=>tx`select sales_tax_rate_percent,tax_calculation_mode from location_checkout_settings where location_id=${ctx.locationId}`);
 const day=await withTenant(ctx,tx=>resolveDate(tx,ctx.locationId));let closed=false;
 try{
  await withTenant(ctx,async tx=>{await tx`update locations set settings=jsonb_set(jsonb_set(settings,'{capacity,use_recurring_staff}','false'::jsonb),'{online_booking}',${jsonb({enabled:true,deposit_required:true,deposit_amount_cents:2000,min_minutes_ahead:0,cancel_cutoff_hours:4})}::jsonb) where id=${ctx.locationId}`;await tx`update location_checkout_settings set sales_tax_rate_percent=0,tax_calculation_mode='exclusive' where location_id=${ctx.locationId}`;});
  const template=await run<{templateId:string}>('package.saveTemplate',{name:'Original merged package',priceCents:5000,sessions:1,serviceIds:[serviceId],coverageMode:'any_included',commissionBasis:'sale_price'}),pkg=await run<{assetId:string}>('commerce.createOrder',{kind:'package',channel:'offline',templateId:template.templateId,customerId:source,businessKey:randomUUID(),offlinePayment:{method:'cash',amountCents:5000,reference:'Merge package receipt'}});
  const gift=await run<{assetId:string}>('commerce.createOrder',{kind:'gift_card',channel:'offline',customerId:source,businessKey:randomUUID(),faceValueCents:10000,salePriceCents:8000,offlinePayment:{method:'cash',amountCents:8000,reference:'Merge gift receipt'}});
  const hold=await run<{holdId:string;appointmentId:string}>('commerce.holdAppointment',{businessKey:randomUUID(),appointment:{customerId:source,source:'desk',override:{reason:'desk_coordination'},items:[{serviceId,startsAt:new Date(Date.now()+60000).toISOString()}]}});
  await run('commerce.recordOfflineDeposit',{holdId:hold.holdId,amountCents:2000,method:'cash',reference:'Merge deposit receipt'});
  const old=await run<{ticketId:string}>('ticket.open',{customerId:source,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:1000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${old.ticketId}`);
  await run('ticket.pay',{ticketId:old.ticketId,payments:[{method:'cash',amountCents:1000}]});await run('ticket.refund',{ticketId:old.ticketId,refundAmountCents:1000,refundMethod:'store_credit',reason:'other'});
  const fingerprint=()=>withTenant(ctx,tx=>tx`select
   (select md5(row_to_json(m)::text) from customer_paid_memberships m where id=${member.id}) as member,
   (select md5(string_agg(row_to_json(o)::text,'|' order by id)) from commerce_orders o where customer_id=${source}) as orders,
   (select md5(row_to_json(g)::text) from gift_cards g where id=${gift.assetId}) as gift,
   (select md5(row_to_json(p)::text) from customer_packages p where id=${pkg.assetId}) as package,
   (select md5(row_to_json(a)::text) from appointments a where id=${hold.appointmentId}) as appointment,
   (select md5(row_to_json(t)::text) from tickets t where id=${old.ticketId}) as ticket,
   (select md5(string_agg(row_to_json(l)::text,'|' order by id)) from customer_credit_ledger l where customer_id=${source}) as credit_ledger`);
  const before=await fingerprint(),money=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day));
  await run('dayclose.saveCount',{businessDate:day,countedCashCents:money.cashTakeCents+money.movementsCents-money.tipPaidOutCents,openingFloatCents:0,closingFloatCents:0});await run('dayclose.finalize',{businessDate:day,force:true});closed=true;
  const savedClose=await withTenant(ctx,tx=>loadDayClose(tx,ctx,day)),mergeInput={sourceCustomerId:source,targetCustomerId:target},key=randomUUID();
  const merged=await dispatch('customer.merge',mergeInput,ctx,{idempotencyKey:key}),replay=await dispatch('customer.merge',mergeInput,ctx,{idempotencyKey:key});expect(replay.replayed).toBe(true);expect(replay.result).toEqual(merged.result);
  await expect(dispatch('customer.merge',{...mergeInput,targetCustomerId:stranger},ctx,{idempotencyKey:key})).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
  expect(await fingerprint()).toEqual(before);expect((await withTenant(ctx,tx=>loadDayClose(tx,ctx,day))).money).toEqual(savedClose.money);
  const detail=await withTenant(ctx,tx=>loadCustomerDetail(tx,ctx,target));expect(detail?.storeCreditBalanceCents).toBe(1000);expect(detail?.giftCards.map(g=>g.id)).toContain(gift.assetId);expect(detail?.recentTickets.map(t=>t.id)).toContain(old.ticketId);
  expect(await withTenant(ctx,tx=>canonicalCustomer(tx,stranger))).toBe(stranger);
  const token=unwrapManageToken(membership!.manage_token_wrapped,membership!.manage_token_hash)!;
  const protectedResult=await app.inject({method:'GET',url:`/v1/public/shops/${slug}/commerce/memberships/${member.id}`,headers:{'x-gf-commerce-token':token}});expect(protectedResult.statusCode).toBe(200);
  const wrongResult=await app.inject({method:'GET',url:`/v1/public/shops/${slug}/commerce/memberships/${member.id}`,headers:{'x-gf-commerce-token':`cm_${'A'.repeat(43)}`}});expect(wrongResult.statusCode).toBe(404);
  const enrollmentReplay=await dispatchSystem<{membershipId:string}>('commerce.enrollMembership',member.input,ctx,{idempotencyKey:randomUUID()});expect(enrollmentReplay.result.membershipId).toBe(member.id);
  await run('dayclose.reopen',{businessDate:day,reason:'approved merged customer checkout'});closed=false;
  const ids:string[]=[],items:string[]=[];for(let i=0;i<3;i++){const t=await run<{ticketId:string}>('ticket.open',{customerId:target,...(i===2?{appointmentId:hold.appointmentId}:{}),items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:10000}]});ids.push(t.ticketId);const [item]=await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId} returning id`);items.push(item!.id);}
  const [cycle]=await withTenant(ctx,tx=>tx`select id from customer_membership_cycles where membership_id=${member.id} and status='issued' and starts_at<=now() and ends_at>now()`);
  const offered=await app.inject({method:'GET',url:'/v1/desk/tickets'});expect(offered.statusCode).toBe(200);const first=offered.json().tickets.find((t:{ticketId:string})=>t.ticketId===ids[0]);expect(first.availableMemberships.map((m:{cycleId:string})=>m.cycleId)).toContain(cycle!.id);expect(first.availablePackages.map((p:{customerPackageId:string})=>p.customerPackageId)).toContain(pkg.assetId);
  const outsider=await run<{ticketId:string}>('ticket.open',{customerId:stranger,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:10000}]});const [outsideItem]=await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${outsider.ticketId} returning id`);
  await expect(run('ticket.quoteCheckout',{ticketId:outsider.ticketId,membershipRedemptions:[{cycleId:cycle!.id,ticketItemIds:[outsideItem!.id]}]})).rejects.toMatchObject({details:{reason:'membership_unavailable'}});
  await expect(run('ticket.quoteCheckout',{ticketId:outsider.ticketId,packageRedemptions:[{customerPackageId:pkg.assetId,units:1}]})).rejects.toMatchObject({details:{reason:'package_ticket_customer_mismatch'}});
  const offers=await withTenant(ctx,tx=>loadMembershipDiscountOffers(tx,ctx,[{ticketId:ids[2]!,customerId:target}])),offer=offers.get(ids[2]!)![0]!,group=await run<{groupId:string}>('ticket.group',{ticketIds:ids});
  const input={groupId:group.groupId,ticketIds:ids,ticketSelections:[{ticketId:ids[0],membershipRedemptions:[{cycleId:cycle!.id,ticketItemIds:[items[0]]}]},{ticketId:ids[1],packageRedemptions:[{customerPackageId:pkg.assetId,units:1}]},{ticketId:ids[2],membershipDiscount:{membershipId:member.id,cycleId:cycle!.id,planVersionId:p.versionId,items:offer.items},depositApplication:{holdId:hold.holdId,amountCents:2000},storedValuePayments:[{method:'gift_card',giftCardId:gift.assetId,amountCents:3000},{method:'customer_credit',amountCents:1000}]}],payments:[{method:'cash',amountCents:3000}]};
  const quote=await run<{quoteHash:string;tickets:Array<{ticketId:string;totalCents:number}>}>('ticket.quoteGroup',input);await run('ticket.closeGroup',{...input,expectedQuoteHash:quote.quoteHash});
  for(const t of quote.tickets)await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:t.totalCents,reason:'other'});
  const [final]=await withTenant(ctx,tx=>tx`select (select customer_id from customer_paid_memberships where id=${member.id}) as original_member_owner,(select count(*)::int from customer_membership_invoices where membership_id=${member.id}) as invoices,(select remaining_sessions from customer_packages where id=${pkg.assetId}) as units,(select customer_id from customer_packages where id=${pkg.assetId}) as original_package_owner,(select balance_cents from gift_cards where id=${gift.assetId}) as gift,(select holder_customer_id from gift_cards where id=${gift.assetId}) as original_gift_owner,(select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${hold.holdId}) as deposit`);
  expect(final).toMatchObject({original_member_owner:source,original_package_owner:source,original_gift_owner:source,invoices:1,units:1,gift:10000,deposit:2000});expect((await withTenant(ctx,tx=>loadCustomerDetail(tx,ctx,target)))?.storeCreditBalanceCents).toBe(1000);
 }finally{if(closed)await run('dayclose.reopen',{businessDate:day,reason:'isolated merge test cleanup'});await withTenant(ctx,async tx=>{await tx`update locations set settings=${jsonb(settings!.settings)}::jsonb where id=${ctx.locationId}`;await tx`update location_checkout_settings set sales_tax_rate_percent=${checkout!.sales_tax_rate_percent},tax_calculation_mode=${checkout!.tax_calculation_mode} where location_id=${ctx.locationId}`;});}
});

it('pins each paid invoice contract and rejects unapproved replacement terms',async()=>{
 const p=await plan('month',{discountBps:1000,discountServiceIds:[serviceId]}),a=await enroll(p);await processCommerceEvent(a.event());
 const later=await run<{versionId:string}>('commerce.saveMembershipPlan',{planId:p.planId,expectedVersion:1,terms:{...p.terms,name:{en:'Next catalog terms'},amountCents:14900,quantity:2},active:true,onlineSale:true});
 const [invoice]=await withTenant(tenant,tx=>tx`select i.*,m.manage_token_wrapped,m.manage_token_hash from customer_membership_invoices i join customer_paid_memberships m on m.id=i.membership_id where i.membership_id=${a.id}`);
 expect(invoice!.plan_version_id).toBe(p.versionId);expect(invoice!.snapshot.terms).toEqual(p.terms);expect(invoice!.stripe_price_id).toBe(a.sub.items.data[0]!.price.id);
 const token=unwrapManageToken(invoice!.manage_token_wrapped,invoice!.manage_token_hash)!;
 const response=await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':token}});expect(response.statusCode).toBe(200);
 const data=response.json();expect(data.invoices[0].snapshot.terms).toEqual(p.terms);expect(data.cycles[0].snapshot.terms).toEqual(p.terms);expect(data.cycles[0].plan_version_id).toBe(p.versionId);expect(data.cycles[0].quantity).toBe(1);
 await expect(withTenant(tenant,tx=>tx`update customer_membership_invoices set snapshot=jsonb_set(snapshot,'{terms,amountCents}','14900'::jsonb) where id=${invoice!.id}`)).rejects.toMatchObject({code:'42501'});
 for(const replacement of [{version:later.versionId,price:invoice!.stripe_price_id},{version:p.versionId,price:'price_unapproved'}]){
  await expect(withTenant(tenant,tx=>tx`insert into customer_membership_invoices(org_id,location_id,membership_id,account_id,livemode,stripe_invoice_id,order_id,payment_id,period_start,period_end,paid_at,plan_version_id,snapshot,stripe_price_id)
   select org_id,location_id,membership_id,account_id,livemode,${`in_forged_${randomUUID()}`},order_id,payment_id,period_start,period_end,paid_at,${replacement.version},snapshot,${replacement.price} from customer_membership_invoices where id=${invoice!.id}`)).rejects.toMatchObject({code:'23001'});
 }
});

async function scheduledChangeFixture(cadence:'month'|'year'='month',loseScheduleResponse=false){
 const old=await plan(),a=await enroll(old);await processCommerceEvent(a.event());const target=await plan(cadence,{amountCents:cadence==='month'?14900:149900,quantity:2,name:{en:'Approved next plan'}});
 const [access]=await withTenant(tenant,tx=>tx`select manage_token_hash from customer_paid_memberships where id=${a.id}`);
 const effective=new Date(a.sub.items.data[0]!.current_period_end*1000).toISOString(),input={membershipId:a.id,tokenHash:access!.manage_token_hash,versionId:target.versionId,businessKey:randomUUID(),expectedPeriodEnd:effective,consent:{accepted:true,versionId:target.versionId,amountCents:target.terms.amountCents,cadence,effectiveAt:effective}};
 const key=randomUUID(),change=await dispatchSystem<{changeId:string}>('commerce.requestMembershipChange',input,ctx,{idempotencyKey:key});
 const stripe=commerceStripeClient();let price:Stripe.Price|undefined,schedule:Stripe.SubscriptionSchedule|undefined;let lost=false;
 const prices=vi.spyOn(stripe.prices,'list').mockImplementation(()=>iterable(price?[price]:[]) as unknown as ReturnType<typeof stripe.prices.list>);
 const createPrice=vi.spyOn(stripe.prices,'create').mockImplementation(async(params)=>{price={...params,id:`price_change_${change.result.changeId.replaceAll('-','')}`,livemode:false} as unknown as Stripe.Price;return price as Stripe.Response<Stripe.Price>;});
 const createSchedule=vi.spyOn(stripe.subscriptionSchedules,'create').mockImplementation(async()=>{schedule={id:`sub_sched_${change.result.changeId.replaceAll('-','')}`,livemode:false,customer:a.sub.customer,subscription:a.sub.id,status:'active',metadata:{},phases:[],end_behavior:'release'} as unknown as Stripe.SubscriptionSchedule;
  Object.assign(a.sub,{schedule:schedule.id});if(loseScheduleResponse&&!lost){lost=true;throw new Error('Provider response lost after schedule creation');}return schedule as Stripe.Response<Stripe.SubscriptionSchedule>;});
 vi.spyOn(stripe.subscriptionSchedules,'retrieve').mockImplementation(async()=>schedule as Stripe.Response<Stripe.SubscriptionSchedule>);
 const updateSchedule=vi.spyOn(stripe.subscriptionSchedules,'update').mockImplementation(async(_id,params)=>{schedule={...schedule!,...params,phases:params!.phases!.map(phase=>({...phase,items:phase.items.map(item=>({...item,discounts:[]})),add_invoice_items:[],discounts:[],default_tax_rates:[]}))} as unknown as Stripe.SubscriptionSchedule;return schedule as Stripe.Response<Stripe.SubscriptionSchedule>;});
 vi.spyOn(stripe.events,'list').mockImplementation(()=>iterable([{id:'evt_owned_schedule',type:'subscription_schedule.created',request:{idempotency_key:`gf-member-change:${change.result.changeId}:schedule`},data:{object:{id:schedule!.id}}}]) as unknown as ReturnType<typeof stripe.events.list>);
 vi.spyOn(stripe.invoices,'list').mockReturnValue(iterable([a.invoice]) as unknown as ReturnType<typeof stripe.invoices.list>);
 vi.spyOn(stripe.refunds,'list').mockReturnValue(iterable([]) as unknown as ReturnType<typeof stripe.refunds.list>);
 return {a,old,target,input,key,id:change.result.changeId,stripe,prices,createPrice,createSchedule,updateSchedule,getPrice:()=>price!,getSchedule:()=>schedule!};
}

it('schedules an explicitly accepted next-period plan on the original subscription and preserves historical invoices after its first paid renewal',async()=>{
 const f=await scheduledChangeFixture();const {scheduleMembershipChange}=await import('./commerce/membershipChanges');
 await scheduleMembershipChange(ctx,f.id);await scheduleMembershipChange(ctx,f.id);
 expect(f.createPrice).toHaveBeenCalledTimes(1);expect(f.createSchedule).toHaveBeenCalledTimes(1);expect(f.updateSchedule).toHaveBeenCalledTimes(1);
 expect(f.updateSchedule.mock.calls[0]![1]).toMatchObject({proration_behavior:'none',end_behavior:'release',phases:[{items:[{price:f.a.sub.items.data[0]!.price.id,quantity:1}]},{items:[{price:f.getPrice().id,quantity:1}],proration_behavior:'none'}]});
 const before=await withTenant(tenant,tx=>tx`select id,snapshot,plan_version_id,stripe_price_id from customer_membership_invoices where membership_id=${f.a.id}`);
 expect(before).toHaveLength(1);expect(before[0]!.snapshot.terms.amountCents).toBe(9900);
 await expect(dispatchSystem('commerce.requestMembershipChange',{...f.input,businessKey:randomUUID()},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({details:{reason:'membership_change_already_pending'}});
 expect((await dispatchSystem('commerce.requestMembershipChange',f.input,ctx,{idempotencyKey:f.key})).result).toMatchObject({changeId:f.id});
 const oldInvoice=structuredClone(f.a.invoice),oldIntent=structuredClone(f.a.intent),item=f.a.sub.items.data[0]!;
 item.current_period_start=item.current_period_end;const end=new Date(item.current_period_start*1000);end.setUTCMonth(end.getUTCMonth()+1);item.current_period_end=end.getTime()/1000;
 item.price={...item.price,id:f.getPrice().id,unit_amount:14900};f.a.invoice.id=`in_changed_${randomUUID()}`;f.a.sub.latest_invoice=f.a.invoice.id;
 f.a.invoice.amount_paid=14900;f.a.invoice.total=14900;f.a.invoice.lines.data[0]!.period={start:item.current_period_start,end:item.current_period_end};f.a.invoice.lines.data[0]!.pricing.price_details.price=f.getPrice().id;
 f.a.intent.id=`pi_changed_${randomUUID()}`;f.a.intent.amount_received=14900;
 vi.mocked(f.stripe.invoices.retrieve).mockImplementation(async id=>(id===oldInvoice.id?oldInvoice:f.a.invoice) as unknown as Stripe.Response<Stripe.Invoice>);
 vi.mocked(f.stripe.paymentIntents.retrieve).mockImplementation(async id=>(id===oldIntent.id?oldIntent:f.a.intent) as unknown as Stripe.Response<Stripe.PaymentIntent>);
 vi.mocked(f.stripe.invoicePayments.list).mockImplementation(params=>{const older=params!.invoice===oldInvoice.id;return iterable([{invoice:older?oldInvoice.id:f.a.invoice.id,livemode:false,status:'paid',amount_paid:older?9900:14900,payment:{payment_intent:older?oldIntent.id:f.a.intent.id}}]) as unknown as ReturnType<typeof f.stripe.invoicePayments.list>;});
 await processCommerceEvent(f.a.event());await processCommerceEvent(f.a.event('invoice.paid',oldInvoice));
 const rows=await withTenant(tenant,tx=>tx`select i.id,i.snapshot,i.plan_version_id,i.stripe_price_id from customer_membership_invoices i where membership_id=${f.a.id} order by period_start`);
 expect(rows).toHaveLength(2);expect(rows[0]).toEqual(before[0]);expect(rows[1]!.snapshot.terms).toEqual(f.target.terms);expect(rows[1]!.stripe_price_id).toBe(f.getPrice().id);
 const cycles=await withTenant(tenant,tx=>tx`select quantity,status from customer_membership_cycles where membership_id=${f.a.id} order by starts_at`);expect(cycles).toEqual([{quantity:1,status:'issued'},{quantity:2,status:'planned'}]);
 const [change]=await withTenant(tenant,tx=>tx`select status from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('applied');
});

it('recovers a lost from-subscription response using its original provider request receipt without creating another subscription schedule',async()=>{
 const f=await scheduledChangeFixture('year',true),{scheduleMembershipChange}=await import('./commerce/membershipChanges');
 await expect(scheduleMembershipChange(ctx,f.id)).rejects.toThrow('Provider response lost');await scheduleMembershipChange(ctx,f.id);
 expect(f.createSchedule).toHaveBeenCalledTimes(1);expect(f.createPrice).toHaveBeenCalledTimes(1);expect(f.updateSchedule.mock.calls[0]![1]!.phases![1]).toMatchObject({duration:{interval:'year',interval_count:1},billing_cycle_anchor:'phase_start',proration_behavior:'none'});
 const [change]=await withTenant(tenant,tx=>tx`select status,snapshot from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('scheduled');expect(change!.snapshot.terms.cadence).toBe('year');
 await expect(withTenant(tenant,tx=>tx`update customer_membership_plan_changes set snapshot=jsonb_set(snapshot,'{terms,amountCents}','1'::jsonb) where id=${f.id}`)).rejects.toMatchObject({code:'23001'});
});

it('requires this resource token, exact renewal consent and the current provider boundary before requesting a plan change',async()=>{
 const p=await plan(),a=await enroll(p);await processCommerceEvent(a.event());const target=await plan('month',{amountCents:14900});
 const [access]=await withTenant(tenant,tx=>tx`select manage_token_hash,manage_token_wrapped from customer_paid_memberships where id=${a.id}`);
 const effectiveAt=new Date(a.sub.items.data[0]!.current_period_end*1000).toISOString(),input={membershipId:a.id,tokenHash:access!.manage_token_hash,versionId:target.versionId,businessKey:randomUUID(),expectedPeriodEnd:effectiveAt,consent:{accepted:true,versionId:target.versionId,amountCents:14900,cadence:'month',effectiveAt}};
 await expect(dispatchSystem('commerce.requestMembershipChange',{...input,consent:{...input.consent,amountCents:9900}},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({details:{reason:'membership_change_quote_changed'}});
 await expect(dispatchSystem('commerce.requestMembershipChange',{...input,expectedPeriodEnd:new Date(Date.parse(effectiveAt)+1000).toISOString()},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({details:{reason:'membership_change_quote_changed'}});
 const {membershipId:_,tokenHash:__,...body}=input;
 const denied=await app.inject({method:'POST',url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}/plan-change`,headers:{'x-gf-commerce-token':`cm_${'x'.repeat(43)}`},payload:body});expect(denied.statusCode).toBe(404);
 const [counts]=await withTenant(tenant,tx=>tx`select count(*)::int as n from customer_membership_plan_changes where membership_id=${a.id}`);expect(counts!.n).toBe(0);
});

it('finishes an already authorized provider change after platform billing is frozen while refusing new customer changes',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges');
 await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'past_due'},ctx);
 try{
  await scheduleMembershipChange(ctx,f.id);
  const [change]=await withTenant(tenant,tx=>tx`select status from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('scheduled');
  await expect(dispatchSystem('commerce.requestMembershipChange',{...f.input,businessKey:randomUUID()},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'SUBSCRIPTION_PAST_DUE'});
 }finally{await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);}
});

it('refuses an unowned schedule after the provider creation response is lost',async()=>{
 const f=await scheduledChangeFixture('month',true),{scheduleMembershipChange}=await import('./commerce/membershipChanges');
 await expect(scheduleMembershipChange(ctx,f.id)).rejects.toThrow('Provider response lost');
 vi.mocked(f.stripe.events.list).mockImplementation(()=>iterable([]) as unknown as ReturnType<typeof f.stripe.events.list>);
 await expect(scheduleMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_change_schedule_not_owned'}});
 expect(f.updateSchedule).not.toHaveBeenCalled();
 const [change]=await withTenant(tenant,tx=>tx`select status,stripe_schedule_id from customer_membership_plan_changes where id=${f.id}`);
 expect(change).toMatchObject({status:'pending',stripe_schedule_id:null});
});

it('does not overwrite externally modified ownership or phases on a bound schedule',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges');await scheduleMembershipChange(ctx,f.id);
 const schedule=f.getSchedule(),metadata={...schedule.metadata};
 schedule.metadata={...metadata,gf_org_id:randomUUID()};
 await expect(scheduleMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_change_schedule_not_owned'}});
 schedule.metadata={...metadata,gf_change_id:randomUUID()};
 await expect(scheduleMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_change_schedule_not_owned'}});
 schedule.metadata=metadata;schedule.phases[1]!.items[0]!.quantity=2;
 await expect(scheduleMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_change_schedule_modified'}});
 expect(f.updateSchedule).toHaveBeenCalledTimes(1);
 const [change]=await withTenant(tenant,tx=>tx`select status,stripe_schedule_id from customer_membership_plan_changes where id=${f.id}`);
 expect(change).toMatchObject({status:'scheduled',stripe_schedule_id:schedule.id});
 expect((await withTenant(tenant,tx=>tx`select id from customer_membership_invoices where membership_id=${f.a.id}`))).toHaveLength(1);
});

async function requestChangeWithdrawal(f:Awaited<ReturnType<typeof scheduledChangeFixture>>){
 const input={membershipId:f.a.id,changeId:f.id,tokenHash:f.input.tokenHash,businessKey:randomUUID(),confirmed:true};
 return {input,key:randomUUID(),result:await dispatchSystem('commerce.withdrawMembershipChange',input,ctx,{idempotencyKey:randomUUID()})};
}
it('withdraws a request before scheduling without provider mutations and allows a new choice at the same boundary',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges'),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal');
 const release=vi.spyOn(f.stripe.subscriptionSchedules,'release');await requestChangeWithdrawal(f);await scheduleMembershipChange(ctx,f.id);await withdrawMembershipChange(ctx,f.id);await withdrawMembershipChange(ctx,f.id);
 expect(release).not.toHaveBeenCalled();expect(f.createSchedule).not.toHaveBeenCalled();expect(f.createPrice).not.toHaveBeenCalled();
 const [change]=await withTenant(tenant,tx=>tx`select status,withdrawn_at from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('withdrawn');expect(change!.withdrawn_at).toBeTruthy();
 await expect(withTenant(tenant,tx=>tx`update customer_membership_plan_changes set status='pending',withdrawn_at=null where id=${f.id}`)).rejects.toMatchObject({code:'23001'});
 const next=await dispatchSystem<{changeId:string}>('commerce.requestMembershipChange',{...f.input,businessKey:randomUUID()},ctx,{idempotencyKey:randomUUID()});expect(next.result.changeId).not.toBe(f.id);
});
it('recovers a released schedule after response loss, retaining renewal and all original paid facts',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges'),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal');await scheduleMembershipChange(ctx,f.id);
 const before=await withTenant(tenant,tx=>tx`select i.id,i.snapshot,i.payment_id from customer_membership_invoices i where membership_id=${f.a.id}`);
 const release=vi.spyOn(f.stripe.subscriptionSchedules,'release').mockImplementation(async()=>{Object.assign(f.getSchedule(),{status:'released',subscription:null,released_subscription:f.a.sub.id});Object.assign(f.a.sub,{schedule:null});throw new Error('Lost actual release response');});
 await requestChangeWithdrawal(f);await expect(withdrawMembershipChange(ctx,f.id)).rejects.toThrow('Lost actual release response');
 const [unknown]=await withTenant(tenant,tx=>tx`select status,withdrawn_at from customer_membership_plan_changes where id=${f.id}`);expect(unknown).toMatchObject({status:'scheduled',withdrawn_at:null});
 await withdrawMembershipChange(ctx,f.id);await scheduleMembershipChange(ctx,f.id);await withdrawMembershipChange(ctx,f.id);
 expect(release).toHaveBeenCalledTimes(1);expect(release.mock.calls[0]![1]).toEqual({preserve_cancel_date:true});expect(f.updateSchedule).toHaveBeenCalledTimes(1);
 expect(f.a.sub.status).toBe('active');expect(f.a.sub.cancel_at_period_end).toBe(false);expect(f.a.sub.items.data[0]!.price.unit_amount).toBe(9900);
 expect(await withTenant(tenant,tx=>tx`select i.id,i.snapshot,i.payment_id from customer_membership_invoices i where membership_id=${f.a.id}`)).toEqual(before);
 const [change]=await withTenant(tenant,tx=>tx`select status from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('withdrawn');
});
it('keeps a requested withdrawal pending when a bound schedule belongs to an external editor',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges'),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal');await scheduleMembershipChange(ctx,f.id);
 await requestChangeWithdrawal(f);f.getSchedule().metadata!.gf_org_id=randomUUID();const release=vi.spyOn(f.stripe.subscriptionSchedules,'release');
 await expect(withdrawMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_change_schedule_not_owned'}});expect(release).not.toHaveBeenCalled();
 const [change]=await withTenant(tenant,tx=>tx`select status,withdrawn_at from customer_membership_plan_changes where id=${f.id}`);expect(change).toMatchObject({status:'scheduled',withdrawn_at:null});
});
it('serializes provider mutations across workers without holding waiting pool connections',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges'),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal'),{withMembershipProviderLock}=await import('./commerce/membershipLocks');
 await requestChangeWithdrawal(f);
 await withMembershipProviderLock(ctx,f.a.id,async()=>{
  await expect(scheduleMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_provider_busy'}});
  await expect(withdrawMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_provider_busy'}});
 });
 await withdrawMembershipChange(ctx,f.id);expect(f.createSchedule).not.toHaveBeenCalled();
});
it('reports the approved plan as applied if its boundary wins the withdrawal race without reversing price or granting unpaid benefits',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges'),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal');await scheduleMembershipChange(ctx,f.id);await requestChangeWithdrawal(f);
 const item=f.a.sub.items.data[0]!;item.current_period_start=item.current_period_end;item.current_period_end+=30*86400;item.price={...item.price,id:f.getPrice().id,unit_amount:14900};
 const release=vi.spyOn(f.stripe.subscriptionSchedules,'release');await withdrawMembershipChange(ctx,f.id);
 const [change]=await withTenant(tenant,tx=>tx`select status,withdrawn_at from customer_membership_plan_changes where id=${f.id}`);expect(change).toMatchObject({status:'applied',withdrawn_at:null});expect(release).not.toHaveBeenCalled();
 expect((await withTenant(tenant,tx=>tx`select id from customer_membership_invoices where membership_id=${f.a.id}`))).toHaveLength(1);
 await expect(dispatchSystem('commerce.withdrawMembershipChange',{membershipId:f.a.id,changeId:f.id,tokenHash:f.input.tokenHash,businessKey:randomUUID(),confirmed:true},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({details:{reason:'membership_change_already_applied'}});
});
it('authorizes withdrawal with the original resource token, replays the exact request and refuses a changed target',async()=>{
 const f=await scheduledChangeFixture();const [m]=await withTenant(tenant,tx=>tx`select manage_token_hash,manage_token_wrapped from customer_paid_memberships where id=${f.a.id}`),token=unwrapManageToken(m!.manage_token_wrapped,m!.manage_token_hash)!;
 const url=`/v1/public/shops/${slug}/commerce/memberships/${f.a.id}/plan-change/${f.id}/withdraw`,payload={businessKey:randomUUID(),confirmed:true,locale:'en'};
 expect((await app.inject({method:'POST',url,headers:{'x-gf-commerce-token':`cm_${'z'.repeat(43)}`},payload})).statusCode).toBe(404);
 const first=await app.inject({method:'POST',url,headers:{'x-gf-commerce-token':token},payload});expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({changeId:f.id,status:'withdrawn',replayed:false});
 const replay=await app.inject({method:'POST',url,headers:{'x-gf-commerce-token':token},payload});expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({changeId:f.id,status:'withdrawn',replayed:true});
 const different=await app.inject({method:'POST',url:url.replace(f.id,randomUUID()),headers:{'x-gf-commerce-token':token},payload});expect(different.statusCode).toBe(409);
});
it('cancels unapplied plan changes only after provider termination and does not resurrect them on worker replay',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges');await scheduleMembershipChange(ctx,f.id);
 await expect(withTenant(tenant,tx=>tx`update customer_membership_plan_changes set status='canceled',canceled_at=now() where id=${f.id}`)).rejects.toMatchObject({code:'23001'});
 f.a.sub.status='canceled';await processCommerceEvent(f.a.event('customer.subscription.deleted',f.a.sub));await scheduleMembershipChange(ctx,f.id);
 const [change]=await withTenant(tenant,tx=>tx`select status,canceled_at from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('canceled');expect(change!.canceled_at).toBeTruthy();expect(f.updateSchedule).toHaveBeenCalledTimes(1);
 const invoices=await withTenant(tenant,tx=>tx`select id from customer_membership_invoices where membership_id=${f.a.id}`);expect(invoices).toHaveLength(1);
});
it('honors a withdrawal requested while the scheduling worker is in flight',async()=>{
 const f=await scheduledChangeFixture(),{scheduleMembershipChange}=await import('./commerce/membershipChanges'),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal');
 let entered!:()=>void,resume!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;}),update=f.updateSchedule.getMockImplementation()!;
 f.updateSchedule.mockImplementation(async(...args)=>{entered();await gate;return update(...args);});
 const scheduling=scheduleMembershipChange(ctx,f.id);await waiting;
 try{await requestChangeWithdrawal(f);await expect(withdrawMembershipChange(ctx,f.id)).rejects.toMatchObject({details:{reason:'membership_provider_busy'}});}finally{resume();}
 await scheduling;
 vi.spyOn(f.stripe.subscriptionSchedules,'release').mockImplementation(async()=>{Object.assign(f.getSchedule(),{status:'released',subscription:null,released_subscription:f.a.sub.id});Object.assign(f.a.sub,{schedule:null});return f.getSchedule() as Stripe.Response<Stripe.SubscriptionSchedule>;});
 await withdrawMembershipChange(ctx,f.id);await scheduleMembershipChange(ctx,f.id);
 const [change]=await withTenant(tenant,tx=>tx`select status from customer_membership_plan_changes where id=${f.id}`);expect(change!.status).toBe('withdrawn');expect(f.updateSchedule).toHaveBeenCalledTimes(1);
});
it('allows withdrawal when new sales and platform billing are disabled',async()=>{
 const f=await scheduledChangeFixture(),{withdrawMembershipChange}=await import('./commerce/membershipChangeWithdrawal');
 const [settings]=await withTenant(tenant,tx=>tx`select settings from locations where id=${ctx.locationId}`);
 await withTenant(tenant,tx=>tx`update locations set settings=jsonb_set(settings,'{commerce,membershipsEnabled}','false'::jsonb) where id=${ctx.locationId}`);
 await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'past_due'},ctx);
 try{await requestChangeWithdrawal(f);await withdrawMembershipChange(ctx,f.id);const [c]=await withTenant(tenant,tx=>tx`select status from customer_membership_plan_changes where id=${f.id}`);expect(c!.status).toBe('withdrawn');}
 finally{await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);await withTenant(tenant,tx=>tx`update locations set settings=${jsonb(settings!.settings)}::jsonb where id=${ctx.locationId}`);}
});
it('extends private access only from paid coverage while retaining the same credential through a full annual period',async()=>{
 const a=await enroll(await plan('year'));
 const [before]=await withTenant(tenant,tx=>tx`select manage_token_hash,manage_token_wrapped,manage_token_expires_at,manage_access_version from customer_paid_memberships where id=${a.id}`);
 await processCommerceEvent(a.event('customer.subscription.created',a.sub));
 const [active]=await withTenant(tenant,tx=>tx`select manage_token_expires_at from customer_paid_memberships where id=${a.id}`);expect(active!.manage_token_expires_at).toEqual(before!.manage_token_expires_at);
 await processCommerceEvent(a.event());await processCommerceEvent(a.event());
 const [paid]=await withTenant(tenant,tx=>tx`select manage_token_hash,manage_token_wrapped,manage_token_expires_at,manage_access_version from customer_paid_memberships where id=${a.id}`);
 expect(paid!.manage_token_hash).toBe(before!.manage_token_hash);expect(paid!.manage_token_wrapped).toEqual(before!.manage_token_wrapped);expect(paid!.manage_access_version).toBe(1);
 expect(new Date(paid!.manage_token_expires_at).getTime()).toBe((a.sub.items.data[0]!.current_period_end+30*86400)*1000);
 const token=unwrapManageToken(paid!.manage_token_wrapped,paid!.manage_token_hash)!;expect((await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':token}})).statusCode).toBe(200);
});
it('replaces a private link once, rejects the old token and stale review, and scopes access administration to configured operators',async()=>{
 const a=await portalFixture(),input={membershipId:a.id,action:'reissue',expectedVersion:1,expectedEmail:'membership@example.test',reason:'Verified customer requested access recovery',confirmed:true},key=randomUUID();
 await expect(dispatch('commerce.manageMembershipAccess',input,{...ctx,permissions:new Set<Permission>(['commerce.read'])},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 const first=await run<{accessVersion:number;noticeQueued:boolean}>('commerce.manageMembershipAccess',input,key);expect(first).toMatchObject({accessVersion:2,noticeQueued:true});expect(await run('commerce.manageMembershipAccess',input,key)).toEqual(first);
 const [m]=await withTenant(tenant,tx=>tx`select manage_token_hash,manage_token_wrapped,manage_access_version from customer_paid_memberships where id=${a.id}`),nextToken=unwrapManageToken(m!.manage_token_wrapped,m!.manage_token_hash)!;
 expect(nextToken).not.toBe(a.token);expect(m!.manage_access_version).toBe(2);
 expect((await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':a.token}})).statusCode).toBe(404);
 expect((await app.inject({url:`/v1/public/shops/${slug}/commerce/memberships/${a.id}`,headers:{'x-gf-commerce-token':nextToken}})).statusCode).toBe(200);
 await expect(run('commerce.manageMembershipAccess',input)).rejects.toMatchObject({details:{reason:'membership_access_changed'}});
 await expect(run('commerce.manageMembershipAccess',{...input,expectedVersion:2,expectedEmail:'another@example.test'})).rejects.toMatchObject({details:{reason:'membership_access_changed'}});
 const messages=await withTenant(tenant,tx=>tx`select body_text from email_outbox where entity_type='customer_membership_access' and commerce_order_id=${a.orderId}`);expect(messages).toHaveLength(1);expect(messages[0]!.body_text).toContain(nextToken);
 const auditRows=await withTenant(tenant,tx=>tx`select row_to_json(a) as data from audit_log a where command='commerce.manageMembershipAccess' and entity_id=${a.id}`);expect(JSON.stringify(auditRows)).not.toContain(nextToken);expect(JSON.stringify(first)).not.toContain(nextToken);
 const other={...ctx,locationId:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'};await expect(dispatch('commerce.manageMembershipAccess',{...input,expectedVersion:2},other,{idempotencyKey:randomUUID()})).rejects.toBeTruthy();
});
it('keeps revoked credentials invalid through paid renewal and requires explicit replacement to restore access',async()=>{
 const a=await portalFixture();await run('commerce.manageMembershipAccess',{membershipId:a.id,action:'revoke',expectedVersion:1,reason:'Reported private link leak',confirmed:true});
 const [before]=await withTenant(tenant,tx=>tx`select manage_token_expires_at,manage_token_revoked_at from customer_paid_memberships where id=${a.id}`);
 const item=a.sub.items.data[0]!;item.current_period_start=item.current_period_end;const end=new Date(item.current_period_start*1000);end.setUTCMonth(end.getUTCMonth()+1);item.current_period_end=end.getTime()/1000;
 a.invoice.id=`in_access_renewal_${randomUUID()}`;a.sub.latest_invoice=a.invoice.id;a.invoice.lines.data[0]!.period={start:item.current_period_start,end:item.current_period_end};a.intent.id=`pi_access_renewal_${randomUUID()}`;
 const stripe=commerceStripeClient();vi.mocked(stripe.invoicePayments.list).mockImplementation(()=>iterable([{invoice:a.invoice.id,livemode:false,status:'paid',amount_paid:9900,payment:{payment_intent:a.intent.id}}]) as unknown as ReturnType<typeof stripe.invoicePayments.list>);
 await processCommerceEvent(a.event());
 const [after]=await withTenant(tenant,tx=>tx`select manage_token_expires_at,manage_token_revoked_at,manage_access_version from customer_paid_memberships where id=${a.id}`);expect(after).toMatchObject({...before,manage_access_version:2});
 expect((await a.post({},randomUUID(),a.id,a.token)).statusCode).toBe(404);
 await expect(withTenant(tenant,tx=>tx`update customer_paid_memberships set manage_token_revoked_at=null,manage_access_version=manage_access_version+1 where id=${a.id}`)).rejects.toMatchObject({code:'23001'});
 await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'past_due'},ctx);
 try{const result=await run<{accessVersion:number}>('commerce.manageMembershipAccess',{membershipId:a.id,action:'reissue',expectedVersion:2,expectedEmail:'membership@example.test',reason:'Verified recipient restored secure delivery',confirmed:true});expect(result.accessVersion).toBe(3);}
 finally{await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);}
 const [restored]=await withTenant(tenant,tx=>tx`select manage_token_hash,manage_token_wrapped,manage_token_expires_at,manage_token_revoked_at from customer_paid_memberships where id=${a.id}`);expect(restored!.manage_token_revoked_at).toBeNull();expect(new Date(restored!.manage_token_expires_at).getTime()).toBe((item.current_period_end+30*86400)*1000);expect(unwrapManageToken(restored!.manage_token_wrapped,restored!.manage_token_hash)).not.toBe(a.token);
});
it('allows only one concurrent private-link replacement for the reviewed access version',async()=>{
 const a=await portalFixture(),input={membershipId:a.id,action:'reissue',expectedVersion:1,expectedEmail:'membership@example.test',reason:'Verified same recipient across two front desks',confirmed:true};
 const results=await Promise.allSettled([run('commerce.manageMembershipAccess',input),run('commerce.manageMembershipAccess',input)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 const [m]=await withTenant(tenant,tx=>tx`select manage_access_version from customer_paid_memberships where id=${a.id}`);expect(m!.manage_access_version).toBe(2);
 expect((await withTenant(tenant,tx=>tx`select id from email_outbox where entity_type='customer_membership_access' and commerce_order_id=${a.orderId}`))).toHaveLength(1);
});
