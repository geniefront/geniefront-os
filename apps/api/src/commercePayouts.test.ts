import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import type Stripe from 'stripe';
import {withTenant,closeDb} from '@gf/db';
import {withPayoutMappingFixture} from '../../../packages/db/src/qa/payoutMappingFixture';
import {buildContext} from './actor';
import {dispatch} from './bus';
import {dispatchSystem} from './test/systemDispatch';
import {commerceStripeClient} from './commerce/client';
import {reconcilePayout} from './commerce/payouts';
import {runCommerceTask,workerContext} from './commerce/worker';
import Fastify from 'fastify';
import {registerCommerceRoutes} from './commerce/routes';
import './handlers/commerce';
import './handlers/billing';
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null},account='acct_PayoutFixture';
let ctx:Awaited<ReturnType<typeof buildContext>>;
const iterable=<T>(data:T[])=>Object.assign(Promise.resolve({data,has_more:false}),{async *[Symbol.asyncIterator](){yield*data;}});
function fixture(automatic=true){
 const suffix=randomUUID().replaceAll('-',''),created=Math.floor(Date.now()/1000),p={id:`po_${suffix}`,object:'payout',livemode:false,amount:4750,currency:'usd',automatic,type:'bank_account',status:'paid',
  created,arrival_date:created+86400,reconciliation_status:automatic?'completed':'not_applicable',failure_code:null,balance_transaction:`txn_debit${suffix}`,failure_balance_transaction:null};
 const debit={id:p.balance_transaction,currency:'usd',amount:-4750,fee:0,net:-4750,type:'payout',created,available_on:created,source:p.id},source={...debit,id:`txn_source${suffix}`,amount:5000,fee:250,net:4750,type:'charge',source:`ch_${suffix}`};
 const stripe=commerceStripeClient();vi.spyOn(stripe.payouts,'retrieve').mockResolvedValue(p as unknown as Stripe.Response<Stripe.Payout>);
 vi.spyOn(stripe.balanceTransactions,'retrieve').mockResolvedValue(debit as unknown as Stripe.Response<Stripe.BalanceTransaction>);
 const list=vi.spyOn(stripe.balanceTransactions,'list').mockReturnValue(iterable([source]) as unknown as Stripe.ApiListPromise<Stripe.BalanceTransaction>);
 return {p,debit,source,list};
}
beforeAll(async()=>{
 process.env.COMMERCE_STRIPE_MODE='test';process.env.COMMERCE_STRIPE_SECRET_KEY='';process.env.STRIPE_SECRET_KEY='sk_test_payout_fixture';
 const [m]=await withTenant(tenant,tx=>tx<{user_id:string;id:string}[]>`select m.* from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
 ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
 await dispatchSystem('commerce.saveAccount',{stripeAccountId:account,livemode:false,chargesEnabled:true,payoutsEnabled:true,detailsSubmitted:true},ctx,{idempotencyKey:randomUUID()});
});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{await closeDb();});
it('records a retrieved automatic bank payout and its complete source batch without recording another customer payment',async()=>{
 const f=fixture(),before=await withTenant(ctx,tx=>tx`select count(*)::int as n from commerce_payments`);
 const result=await reconcilePayout(account,false,f.p.id);await reconcilePayout(account,false,f.p.id,{id:`evt_${randomUUID()}`,type:'payout.paid'});
 expect(result).toMatchObject({status:'paid',automatic:true,reconciliationStatus:'completed'});expect(f.list).toHaveBeenCalledWith({payout:f.p.id,limit:100},{stripeAccount:account});
 const rows=await withTenant(ctx,tx=>tx`select role,gross_cents,fee_cents,net_cents from commerce_payout_transactions where payout_id=${typeof result==='string'?'':result.payoutId} order by role`);
 expect(rows).toEqual([{role:'debit',gross_cents:-4750,fee_cents:0,net_cents:-4750},{role:'source',gross_cents:5000,fee_cents:250,net_cents:4750}]);
 const complete=await withTenant(ctx,tx=>tx`select source_count,source_net_cents from commerce_payout_observations where payout_id=${typeof result==='string'?'':result.payoutId} and source_count is not null`);
 expect(complete).toEqual([{source_count:1,source_net_cents:4750}]);expect(await withTenant(ctx,tx=>tx`select count(*)::int as n from commerce_payments`)).toEqual(before);
});
it('does not invent source allocations for a manual payout and retains the original debit facts',async()=>{
 const f=fixture(false),r=await reconcilePayout(account,false,f.p.id);expect(f.list).not.toHaveBeenCalled();
 const rows=await withTenant(ctx,tx=>tx`select role from commerce_payout_transactions where payout_id=${typeof r==='string'?'':r.payoutId}`);expect(rows).toEqual([{role:'debit'}]);
 const obs=await withTenant(ctx,tx=>tx`select source_count from commerce_payout_observations where payout_id=${typeof r==='string'?'':r.payoutId}`);expect(obs).toEqual([{source_count:null}]);
});
it('rejects wrong mode, context and changed amounts, and keeps payout decisions private and append-only',async()=>{
 const f=fixture();await expect(reconcilePayout(account,true,f.p.id)).rejects.toBeDefined();
 const r=await reconcilePayout(account,false,f.p.id),id=typeof r==='string'?'':r.payoutId;
 vi.mocked(commerceStripeClient().payouts.retrieve).mockResolvedValue({...f.p,amount:4751} as unknown as Stripe.Response<Stripe.Payout>);
 await expect(reconcilePayout(account,false,f.p.id)).rejects.toMatchObject({details:{reason:'payout_identity_changed'}});
 await expect(withTenant(ctx,tx=>tx`update commerce_payouts set amount_cents=4751 where id=${id}`)).rejects.toBeDefined();
 await expect(withTenant(ctx,tx=>tx`delete from commerce_payout_transactions where payout_id=${id}`)).rejects.toBeDefined();
 expect(await withTenant({orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null},tx=>tx`select id from commerce_payouts where id=${id}`)).toHaveLength(0);
 await expect(dispatch('commerce.recordPayoutTransaction',{payoutId:id},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
});
it('never marks a partial or inconsistent automatic source batch reconciled',async()=>{
 const f=fixture();f.list.mockReturnValue(iterable([{...f.source,net:4700,fee:300}]) as unknown as Stripe.ApiListPromise<Stripe.BalanceTransaction>);
 await expect(reconcilePayout(account,false,f.p.id)).rejects.toMatchObject({details:{reason:'payout_source_batch_mismatch'}});
 const rows=await withTenant(ctx,tx=>tx`select o.source_count from commerce_payout_observations o join commerce_payouts p on p.id=o.payout_id where p.stripe_payout_id=${f.p.id}`);
 expect(rows).toEqual([{source_count:null}]);
});
it('retains the debit and bank-return credit when a payout initially paid later fails',async()=>{
 const f=fixture(false),event={id:`evt_${randomUUID()}`,type:'payout.paid'},first=await reconcilePayout(account,false,f.p.id,event),id=typeof first==='string'?'':first.payoutId;
 const failureId=`txn_return${randomUUID().replaceAll('-','')}`;
 vi.mocked(commerceStripeClient().payouts.retrieve).mockResolvedValue({...f.p,status:'failed',failure_code:'account_closed',failure_balance_transaction:failureId} as unknown as Stripe.Response<Stripe.Payout>);
 vi.mocked(commerceStripeClient().balanceTransactions.retrieve).mockImplementation(async(id)=>({...(id===failureId?{...f.debit,id:failureId,amount:4750,net:4750,type:'payout_failure'}:f.debit)}) as unknown as Stripe.Response<Stripe.BalanceTransaction>);
 await reconcilePayout(account,false,f.p.id,event);await reconcilePayout(account,false,f.p.id,event);
 const rows=await withTenant(ctx,tx=>tx`select role,net_cents from commerce_payout_transactions where payout_id=${id} order by role`);
 expect(rows).toEqual([{role:'debit',net_cents:-4750},{role:'reversal',net_cents:4750}]);
 const statuses=await withTenant(ctx,tx=>tx`select status from commerce_payout_observations where payout_id=${id} order by observed_at,created_at`);expect(statuses).toEqual([{status:'paid'},{status:'failed'}]);
});
it('rejects a different payout debit currency before accepting its balance fact',async()=>{
 const f=fixture(false);vi.mocked(commerceStripeClient().balanceTransactions.retrieve).mockResolvedValue({...f.debit,id:`txn_wrong${randomUUID()}`} as unknown as Stripe.Response<Stripe.BalanceTransaction>);
 await expect(reconcilePayout(account,false,f.p.id)).rejects.toMatchObject({details:{reason:'payout_balance_context_mismatch'}});
 vi.mocked(commerceStripeClient().balanceTransactions.retrieve).mockResolvedValue({...f.debit,currency:'eur'} as unknown as Stripe.Response<Stripe.BalanceTransaction>);
 await expect(reconcilePayout(account,false,f.p.id)).rejects.toMatchObject({details:{reason:'payout_balance_context_mismatch'}});
 const rows=await withTenant(ctx,tx=>tx`select t.id from commerce_payout_transactions t join commerce_payouts p on p.id=t.payout_id where p.stripe_payout_id=${f.p.id}`);expect(rows).toHaveLength(0);
});
it('shares one account payout across explicit same-organization mappings and preserves its original owner after a new mapping',async()=>{
 const f=fixture(false),first=await reconcilePayout(account,false,f.p.id),id=typeof first==='string'?'':first.payoutId;
 await withPayoutMappingFixture(async({sharedLocationId:sharedId,injectOtherOrgMapping})=>{
  await dispatchSystem('commerce.saveAccount',{stripeAccountId:account,livemode:false,chargesEnabled:true,payoutsEnabled:true,detailsSubmitted:true},{...ctx,locationId:sharedId},{idempotencyKey:randomUUID()});
  expect(await withTenant({...ctx,locationId:sharedId},tx=>tx`select id,location_id from commerce_payouts where id=${id}`)).toEqual([{id,location_id:ctx.locationId}]);
  await reconcilePayout(account,false,f.p.id);expect(await withTenant(ctx,tx=>tx`select id from commerce_payouts where stripe_payout_id=${f.p.id}`)).toEqual([{id}]);
  await injectOtherOrgMapping();
  await expect(reconcilePayout(account,false,f.p.id)).rejects.toMatchObject({details:{reason:'payout_account_cross_org_mapping'}});
 });
});
it('does not wait forever for an inapplicable source batch after an automatic payout has failed and its return is confirmed',async()=>{
 const f=fixture(),failureId=`txn_return${randomUUID().replaceAll('-','')}`;
 vi.mocked(commerceStripeClient().payouts.retrieve).mockResolvedValue({...f.p,status:'failed',reconciliation_status:'not_applicable',failure_code:'account_closed',failure_balance_transaction:failureId} as unknown as Stripe.Response<Stripe.Payout>);
 vi.mocked(commerceStripeClient().balanceTransactions.retrieve).mockImplementation(async(id)=>({...(id===failureId?{...f.debit,id:failureId,amount:4750,net:4750,type:'payout_failure'}:f.debit)}) as unknown as Stripe.Response<Stripe.BalanceTransaction>);
 const result=await reconcilePayout(account,false,f.p.id);expect(result).toMatchObject({status:'failed',reconciliationStatus:'not_applicable',nextRunAfterSec:undefined});expect(f.list).not.toHaveBeenCalled();
});
it('persists discovery pagination and resumes the same task without duplicating payout facts',async()=>{
 const f=fixture(false),list=vi.spyOn(commerceStripeClient().payouts,'list').mockResolvedValueOnce({data:[f.p],has_more:true} as unknown as Stripe.Response<Stripe.ApiList<Stripe.Payout>>).mockResolvedValueOnce({data:[],has_more:false} as unknown as Stripe.Response<Stripe.ApiList<Stripe.Payout>>);
 await dispatch('commerce.refreshPayouts',{},ctx,{idempotencyKey:randomUUID()});const [a]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_accounts where stripe_account_id=${account}`);
 const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='payout_scan' and subject_id=${a!.id}`);
 await runCommerceTask(workerContext(ctx.orgId,ctx.locationId!),task!.id);
 let [cursor]=await withTenant(ctx,tx=>tx<{payout_scan_cursor:string|null}[]>`select payout_scan_cursor from commerce_accounts where id=${a!.id}`);expect(cursor!.payout_scan_cursor).toBe(f.p.id);
 await withTenant(ctx,tx=>tx`update commerce_tasks set retry_at=now() where id=${task!.id}`);await runCommerceTask(workerContext(ctx.orgId,ctx.locationId!),task!.id);
 [cursor]=await withTenant(ctx,tx=>tx<{payout_scan_cursor:string|null}[]>`select payout_scan_cursor from commerce_accounts where id=${a!.id}`);expect(cursor!.payout_scan_cursor).toBeNull();
 expect(list.mock.calls[1]![0]).toEqual({limit:20,starting_after:f.p.id});expect(await withTenant(ctx,tx=>tx`select id from commerce_payouts where stripe_payout_id=${f.p.id}`)).toHaveLength(1);
});
it('claims a payout scan once across concurrent workers and only renews the owning lease',async()=>{
 vi.spyOn(commerceStripeClient().payouts,'list').mockResolvedValue({data:[],has_more:false} as unknown as Stripe.Response<Stripe.ApiList<Stripe.Payout>>);
 await dispatch('commerce.refreshPayouts',{},ctx,{idempotencyKey:randomUUID()});const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='payout_scan'`);
 const result=await Promise.all([runCommerceTask(workerContext(ctx.orgId,ctx.locationId!),task!.id),runCommerceTask(workerContext(ctx.orgId,ctx.locationId!),task!.id)]);expect(result.filter(Boolean)).toHaveLength(1);
 const renewed=await dispatchSystem<{renewed:boolean}>('commerce.renewTaskLease',{taskId:task!.id,leaseId:randomUUID()},ctx,{idempotencyKey:randomUUID()});expect(renewed.result.renewed).toBe(false);
});
it('serves account payout history only with both financial read permissions and omits provider identifiers',async()=>{
 const f=fixture(false);await reconcilePayout(account,false,f.p.id);const app=Fastify();let caller=ctx;
 registerCommerceRoutes(app,async()=>caller);app.setErrorHandler((error,_req,reply)=>reply.status((error as {code?:string}).code==='PERMISSION_DENIED'?403:500).send({code:(error as {code?:string}).code}));await app.ready();
 try{const good=await app.inject({method:'GET',url:'/v1/desk/commerce/payouts'});expect(good.statusCode).toBe(200);expect(good.headers['cache-control']).toContain('no-store');expect(JSON.stringify(good.json())).not.toContain(f.p.id);
  caller={...ctx,permissions:new Set([...ctx.permissions].filter(p=>p!=='report.view'))};expect((await app.inject({method:'GET',url:'/v1/desk/commerce/payouts'})).statusCode).toBe(403);
 }finally{await app.close();}
});
