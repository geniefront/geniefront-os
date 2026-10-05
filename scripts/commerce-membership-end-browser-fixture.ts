// Original membership cancellation/resumption/end-of-period facts. Test-only; no fabricated payments or clock changes in the app.
import {readFile,writeFile,chmod} from 'node:fs/promises';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332'||process.env.DATABASE_TEST_TARGET!=='isolated')throw new Error('Preserved QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!(process.env.COMMERCE_STRIPE_SECRET_KEY||process.env.STRIPE_SECRET_KEY||'').startsWith('sk_test_'))throw new Error('Stripe test required');
const mode=process.argv[2],file='/tmp/commerce-membership-end-private.json',purchase=JSON.parse(await readFile('/tmp/commerce-membership-browser-private.json','utf8')),clockState=JSON.parse(await readFile('/tmp/commerce-membership-clock-private.json','utf8'));
let state:any;try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
async function save(){await writeFile(file,JSON.stringify(state),{mode:0o600});await chmod(file,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index'),{commerceStripeClient}=await import('../apps/api/src/commerce/client'),stripe=commerceStripeClient(),tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
async function facts(){return withTenant(tenant,async tx=>{const out:Record<string,unknown>={};for(const table of ['commerce_payments','commerce_refunds','customer_membership_invoices','customer_membership_cycles','customer_membership_ledger']){const [r]=await tx.unsafe(`select count(*)::int as count,md5(string_agg(to_jsonb(x)::text,'|' order by id)) as hash from ${table} x`);out[table]=r;}return out;});}
try{
 const [m]=await withTenant(tenant,tx=>tx`select m.*,a.stripe_account_id from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${purchase.membershipId}`);
 if(!m||m.livemode||m.original_order_id!==purchase.orderId||m.stripe_subscription_id!==clockState.subscriptionId||m.stripe_customer_id!==clockState.customerId||m.stripe_account_id!==clockState.accountId)throw new Error('Original membership binding required');
 const options={stripeAccount:m.stripe_account_id},sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id,{},options),clock=await stripe.testHelpers.testClocks.retrieve(clockState.clockId,{},options),item=sub.items.data[0]!;
 if(sub.livemode||sub.metadata.gf_membership_id!==m.id||item.price.unit_amount!==99900||item.price.recurring?.interval!=='year'||sub.schedule)throw new Error('Original unlinked annual plan required');
 const effectiveCancel=sub.cancel_at_period_end||sub.cancel_at===item.current_period_end;
 if(mode==='prepare'){
  if(sub.status!=='active'||effectiveCancel||clock.status!=='ready')throw new Error('Active renewable starting subscription required');
  if(!state.before){state.before=await facts();state.periodEnd=item.current_period_end;state.priceId=item.price.id;state.subscriptionId=sub.id;state.clockStart=clock.frozen_time;const [events]=await withTenant(tenant,tx=>tx`select count(*)::int as count from commerce_events where object_id=${sub.id} and event_id like 'evt_%'`);state.eventsBefore=events!.count;await save();}
  console.log(JSON.stringify({prepared:true,currentAmount:99900,periodEnd:state.periodEnd,clockTime:clock.frozen_time}));
 }else if(mode==='status'){console.log(JSON.stringify({stripeStatus:sub.status,cancelAtPeriodEnd:effectiveCancel,providerCancelAtPeriodEnd:sub.cancel_at_period_end,cancelAt:sub.cancel_at,periodEnd:item.current_period_end,clockStatus:clock.status,clockTime:clock.frozen_time,dbStatus:m.provider_status,dbCancel:m.cancel_at_period_end}));
 }else if(mode==='reconcile'){
  if(!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local auth only');
  const r=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});if(!r.ok)throw new Error('Local login failed');const login=await r.json() as any;const [employee]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
  const result=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${purchase.orderId}/reconcile`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee!.id}});if(!result.ok)throw new Error(`Reconcile ${result.status}`);state.reconciliationRuns=(state.reconciliationRuns??0)+1;await save();console.log(JSON.stringify({reconciled:true}));
 }else if(mode==='advance-end'){
  if(!state.before||!state.scheduledEndVerified||!effectiveCancel||sub.status!=='active'||clock.status!=='ready'||item.current_period_end!==state.periodEnd)throw new Error('Verified scheduled cancellation required');
  if(clock.frozen_time<state.periodEnd+60)await stripe.testHelpers.testClocks.advance(clock.id,{frozen_time:state.periodEnd+60},{...options,idempotencyKey:`member-end:${state.key}`});
  console.log(JSON.stringify({advancing:true,target:state.periodEnd+60,applicationClockUnchanged:true}));
 }else if(['canceled','resumed','scheduled-end','ended'].includes(mode??'')){
  if(!state.before||sub.id!==state.subscriptionId||item.price.id!==state.priceId||item.current_period_end!==state.periodEnd)throw new Error('Original contract changed');
  const after=await facts();if(JSON.stringify(after)!==JSON.stringify(state.before))throw new Error('Original paid facts changed');
  if(['canceled','scheduled-end'].includes(mode!)&&(!effectiveCancel||sub.status!=='active')||mode==='resumed'&&(effectiveCancel||sub.status!=='active')||mode==='ended'&&(sub.status!=='canceled'||clock.status!=='ready'||clock.frozen_time<state.periodEnd))throw new Error('Provider lifecycle stage mismatch');
  if(m.provider_status!==sub.status||m.cancel_at_period_end!==effectiveCancel)throw new Error('Wait for actual webhook or reconcile');
  const [db]=await withTenant(tenant,tx=>tx`select (select count(*)::int from customer_membership_invoices where membership_id=${m.id}) as invoices,(select count(*)::int from customer_membership_cycles where membership_id=${m.id}) as cycles,
   (select coalesce(sum(upper(r)-lower(r)),0)::int from customer_membership_cycles c cross join lateral unnest(c.available_units)r where c.membership_id=${m.id} and c.status='issued' and c.starts_at<=now() and c.ends_at>now()) as current_units,
   (select count(*)::int from commerce_events where object_id=${sub.id} and event_id like 'evt_%' and event_type='customer.subscription.deleted') as signed_deleted_events,
   (select count(*)::int from commerce_events where object_id=${sub.id} and event_id like 'evt_%' and event_type='customer.subscription.updated') as signed_updated_events`);
  if(db!.invoices!==5||db!.cycles!==16||db!.current_units!==1)throw new Error('Original paid coverage changed');
  if(mode==='canceled'){state.cancelVerified=true;state.cancelEventCount=db!.signed_updated_events;await save();}
  if(mode==='resumed'&&(!state.cancelVerified||db!.signed_updated_events<=state.cancelEventCount))throw new Error('Actual resumed subscription event required');
  if(mode==='resumed'){state.resumedEventCount=db!.signed_updated_events;await save();}
  if(mode==='scheduled-end'){if(db!.signed_updated_events<=state.resumedEventCount)throw new Error('Actual second cancellation event required');state.scheduledEndVerified=true;await save();}
  if(mode==='ended'&&db!.signed_deleted_events<1)throw new Error('Actual signed subscription end event required');
  const report={at:new Date().toISOString(),stage:mode,providerObservation:mode==='canceled'?'sdk_reconciliation_after_stopped_listener':'signed_subscription_event_and_sdk',membershipId:m.id,originalSubscriptionReused:true,stripe:{status:sub.status,cancelAtPeriodEnd:effectiveCancel,providerCancelAtPeriodEnd:sub.cancel_at_period_end,cancelAt:sub.cancel_at,currentAmount:item.price.unit_amount,cadence:item.price.recurring!.interval,periodEnd:item.current_period_end,canceledAt:sub.canceled_at,endedAt:sub.ended_at},clock:{status:clock.status,frozenTime:clock.frozen_time},db,originalFinancialFactsPreserved:true,financialFacts:after,applicationClockAdvanced:false,newPaymentOrRefund:false,productionPublished:false};
  await writeFile(`artifacts/customer-commerce/p4-period-end-${mode}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }else throw new Error('Unknown mode');
}finally{await closeDb();}
