// Preserved real Stripe sandbox purchases. No reset, fake financial facts, clock advancement or production writes.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const u=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='58332')throw new Error('Dedicated preserved QA database required');
 u.pathname='/gf_commerce_ci';process.env[target]=u.href;
}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!key.startsWith('sk_test_')||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local authentication and explicit sandbox required');
const mode=process.argv[2],family=process.argv[3];if(!['prepare','verify','reconcile','replay','open-member'].includes(mode??'')||!['year','discount'].includes(family??''))throw new Error('Expected mode and year|discount');
const annual=family==='year',amount=annual?50000:4900,expectedGross=annual?199800:4900;
const purchase=JSON.parse(await readFile(annual?'/tmp/commerce-membership-year-browser-private.json':'/tmp/commerce-membership-discount-browser-private.json','utf8')) as {membershipId:string;orderId:string};
const privatePath=`/tmp/commerce-membership-termination-${family}-private.json`,tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
const {commerceFingerprint}=await import('../packages/payroll/src/commerce');
const stripe=commerceStripeClient(),idOf=(v:unknown):string|null=>typeof v==='string'?v:v&&typeof v==='object'&&'id' in v?String(v.id):null;
type State={membershipId:string;orderId:string;reason:string;originalInvoiceId?:string;reviewHash?:string;replayRuns?:number;reconcileRuns?:number};
let state:State;try{state=JSON.parse(await readFile(privatePath,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={...purchase,reason:annual?'Sandbox annual mid-term termination and original invoice refund':'Sandbox discount membership termination after original service return'};}
async function save(){await writeFile(privatePath,JSON.stringify(state),{mode:0o600});await chmod(privatePath,0o600);}
try{
 if(state.membershipId!==purchase.membershipId||state.orderId!==purchase.orderId)throw new Error('Preserved purchase binding changed');
 const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
  body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
 if(!auth.ok)throw new Error('Existing local owner login failed');const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
 const [employee]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
 if(!employee)throw new Error('Existing local owner membership required');
 const headers={authorization:`Bearer ${login.access_token}`,'x-membership-id':employee.id,'content-type':'application/json'};
 const [m]=await withTenant(tenant,tx=>tx<{id:string;stripe_subscription_id:string;stripe_customer_id:string;stripe_account_id:string;livemode:boolean}[]>`select m.*,a.stripe_account_id
  from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${purchase.membershipId} and m.original_order_id=${purchase.orderId}`);
 if(!m||m.livemode)throw new Error('Preserved sandbox member missing');const options={stripeAccount:m.stripe_account_id};
 const sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id,{},options);
 if(sub.livemode||sub.metadata.gf_membership_id!==m.id||idOf(sub.customer)!==m.stripe_customer_id)throw new Error('Actual subscription context mismatch');
 if(mode==='prepare'){
  if(sub.status!=='active')throw new Error('Prepare only before the real browser termination');
  const [original]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from customer_membership_invoices where membership_id=${m.id} and order_id=${purchase.orderId}`);
  if(!original)throw new Error('Original actual invoice required');state.originalInvoiceId=original.id;
  const response=await fetch(`http://127.0.0.1:3087/v1/desk/commerce/memberships/${m.id}/termination-review`,{headers});
  if(!response.ok)throw new Error('Authenticated review unavailable');const review=await response.json() as {reviewHash:string;termination:unknown;invoices:Array<{id:string;refundable:number}>};
  if(review.termination||!review.invoices.some(i=>i.id===original.id&&i.refundable>=amount))throw new Error('Actual original invoice cap mismatch');state.reviewHash=review.reviewHash;await save();
  const path='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(path,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
  const origin=browser.origins.find(o=>o.origin==='http://localhost:5297'),entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));if(!entry||!origin)throw new Error('Owned browser auth state missing');
  entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});await writeFile(path,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(path,0o600);
  console.log(JSON.stringify({prepared:true,membershipId:m.id,refundCents:amount,originalPurchaseReused:true,reason:state.reason,productionChanged:false}));
 }
 if(mode==='reconcile'){
  const r=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${purchase.orderId}/reconcile`,{method:'POST',headers,body:JSON.stringify({idempotencyKey:crypto.randomUUID()})});
  if(!r.ok)throw new Error('Authenticated SDK reconciliation failed');state.reconcileRuns=(state.reconcileRuns??0)+1;await save();console.log(JSON.stringify({reconciled:true,syntheticSignedEvents:false}));
 }
 if(mode==='replay'){
  const [t]=await withTenant(tenant,tx=>tx<{id:string;review_snapshot:unknown;unused_benefits:string;reason:string}[]>`select * from customer_membership_terminations where membership_id=${m.id}`);if(!t)throw new Error('Actual browser termination required');
  const [idem]=await withTenant(tenant,tx=>tx<{key:string}[]>`select key from command_idempotency where command='commerce.terminateMembership' and result_json->>'terminationId'=${t.id}`);
  if(!idem)throw new Error('Actual browser command receipt required');
  const input={membershipId:m.id,expectedReviewHash:createHash('sha256').update(commerceFingerprint(t.review_snapshot)).digest('hex'),unusedBenefits:t.unused_benefits,
   refunds:[{invoiceId:state.originalInvoiceId,amountCents:amount}],reason:t.reason,confirmed:true};
  const r=await fetch('http://127.0.0.1:3087/v1/commands/commerce.terminateMembership',{method:'POST',headers,body:JSON.stringify({input,idempotencyKey:idem.key})});
  if(!r.ok)throw new Error('Original browser command replay failed');state.replayRuns=(state.replayRuns??0)+1;await save();console.log(JSON.stringify({replayed:true,originalBrowserCommandReused:true}));
 }
 if(mode==='open-member'){
  process.env.BOOKING_BASE_URL='http://localhost:5296';const {membershipManageUrl}=await import('../apps/api/src/commerce/customerMembership');const {workerContext}=await import('../apps/api/src/commerce/worker');
  const url=await membershipManageUrl(workerContext(tenant.orgId,tenant.locationId),m.id),cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
  const opened=spawnSync(process.execPath,[cli,'--session',`commerce-member-termination-${family}`,'open',url],{encoding:'utf8'});if(opened.status!==0)throw new Error('Owned browser open failed');console.log(JSON.stringify({opened:true,privateTokenPrinted:false}));
 }
 if(mode==='verify'){
  const [facts]=await withTenant(tenant,tx=>tx`select m.provider_status,m.terminated_at,m.commerce_frozen,t.id as termination_id,t.status as termination_status,t.unused_benefits,t.provider_canceled_at,
   (select count(*)::int from customer_membership_invoices where membership_id=m.id) as paid_invoices,
   (select sum(p.amount_cents)::int from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=m.id) as original_paid_cents,
   (select count(*)::int from customer_membership_cycles where membership_id=m.id and status='stopped') as stopped_cycles,
   (select count(*)::int from customer_membership_cycles where membership_id=m.id and status in('issued','planned')) as remaining_active_cycles,
   (select coalesce(sum(upper(r)-lower(r)),0)::int from customer_membership_cycles c cross join lateral unnest(c.available_units)r where c.membership_id=m.id) as available_quantity,
   (select count(*)::int from commerce_events where event_id like 'evt_%' and event_type='customer.subscription.deleted' and object_id=m.stripe_subscription_id) as signed_cancellation_events
   from customer_paid_memberships m join customer_membership_terminations t on t.membership_id=m.id where m.id=${m.id}`);
  const refunds=await withTenant(tenant,tx=>tx<{id:string;stripe_refund_id:string;amount_cents:number;status:string;balance_transaction_id:string;payment_intent_id:string;order_id:string;settlement_gross_cents:number;fee_cents:number;net_cents:number}[]>`select r.*,p.payment_intent_id,p.order_id from commerce_refunds r
   join customer_membership_refund_requests q on q.id=r.membership_refund_request_id join commerce_payments p on p.id=r.payment_id where q.membership_id=${m.id}`);
  if(sub.status!=='canceled'||!sub.canceled_at||facts?.provider_status!=='canceled'||!facts.terminated_at||facts.commerce_frozen||facts.termination_status!=='complete'||facts.unused_benefits!=='revoke_all'
   ||facts.original_paid_cents!==expectedGross||facts.stopped_cycles!==(annual?24:1)||facts.remaining_active_cycles!==0||facts.available_quantity!==0||facts.signed_cancellation_events<1||refunds.length!==1)throw new Error('Wait for genuine cancellation/refund facts or investigate');
  const r=refunds[0]!,actual=await stripe.refunds.retrieve(r.stripe_refund_id,{},options);
  if(r.status!=='succeeded'||r.amount_cents!==amount||r.order_id!==purchase.orderId||actual.status!=='succeeded'||actual.amount!==amount||actual.currency!=='usd'||idOf(actual.payment_intent)!==r.payment_intent_id||actual.metadata?.gf_refund_id!==r.id)throw new Error('Original actual refund mismatch');
  const balance=actual.balance_transaction?typeof actual.balance_transaction==='string'?await stripe.balanceTransactions.retrieve(actual.balance_transaction,{},options):actual.balance_transaction:null;
  if(!balance||r.balance_transaction_id!==balance.id||balance.amount!==-amount||balance.amount!==r.settlement_gross_cents||balance.fee!==r.fee_cents||balance.net!==r.net_cents)throw new Error('Wait for actual refund balance settlement');
  const [signed]=await withTenant(tenant,tx=>tx<{n:number}[]>`select count(*)::int as n from commerce_events where event_id like 'evt_%' and event_type in('refund.created','refund.updated') and object_id=${actual.id}`);
  if(!signed?.n)throw new Error('Genuine signed refund callback required');
  const ledger=await withTenant(tenant,tx=>tx`select l.entry,count(*)::int as rows,sum(l.quantity)::int as quantity,sum(l.value_cents)::int as value_cents
   from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${m.id} group by l.entry order by l.entry`);
  const notices=await withTenant(tenant,tx=>tx`select entity_type,count(*)::int as n,min(status) as status from email_outbox where commerce_order_id=${purchase.orderId}
   and (entity_type='customer_membership_termination' or entity_type='commerce_refund_buyer') group by entity_type order by entity_type`);
  const security=await withTenant(tenant,tx=>tx`select relname,relrowsecurity,relforcerowsecurity,has_table_privilege('app_user',oid,'UPDATE') as app_update,
   has_table_privilege('app_user',oid,'DELETE,TRUNCATE') as app_delete,has_table_privilege('anon',oid,'SELECT') as anon_select
   from pg_class where relname in('customer_membership_terminations','customer_membership_termination_cycles','customer_membership_refund_requests') order by relname`);
  const foreign=await withTenant({orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'},tx=>tx`select id from customer_membership_terminations where membership_id=${m.id}`);
  if(security.length!==3||security.some(r=>!r.relrowsecurity||!r.relforcerowsecurity||r.app_delete||r.anon_select||r.relname!=='customer_membership_terminations'&&r.app_update)||foreign.length)throw new Error('Actual membership decision security mismatch');
  let originalService:unknown=null;
  if(!annual){const service=JSON.parse(await readFile('/tmp/commerce-membership-discount-units-private.json','utf8')) as {ticketId:string};
   const prices=await withTenant(tenant,tx=>tx`select kind,original_cents,discount_cents,cycle_id,plan_version_id,rule_snapshot from ticket_price_adjustments where ticket_id=${service.ticketId} order by kind`);
   const [financial]=await withTenant(tenant,tx=>tx`select t.subtotal_cents,t.discount_cents,t.total_cents,t.tip_cents,t.refund_cents,
    (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as remaining_commission_base,
    (select sum(amount_cents)::int from earnings where ticket_id=t.id and kind in('tip_cash','tip_card')) as remaining_tip_earnings,
    (select coalesce(sum(membership_cents),0)::int from ticket_refunds where ticket_id=t.id) as returned_membership,
    (select coalesce(sum(cash_cents),0)::int from ticket_refunds where ticket_id=t.id) as returned_cash from tickets t where t.id=${service.ticketId}`);
   const before=JSON.parse(await readFile('artifacts/customer-commerce/p4-discount-price-facts.json','utf8')) as {prices:unknown;financial:unknown};
   if(commerceFingerprint({prices,financial})!==commerceFingerprint({prices:before.prices,financial:before.financial}))throw new Error('Original service/price history changed');
   originalService={ticketId:service.ticketId,prices,financial,unchangedFromBeforeTermination:true,offlineCashOnlyQaRecording:true};
  }
  const report={at:new Date().toISOString(),family,actualStripeSandbox:true,originalPurchaseReused:true,productionChanged:false,db:facts,provider:{status:sub.status,canceledAt:new Date(sub.canceled_at*1000).toISOString()},
   refund:{id:actual.id,status:actual.status,amountCents:actual.amount,balanceGrossCents:balance.amount,balanceFeeCents:balance.fee,balanceNetCents:balance.net,signedEvents:signed.n},
   ledger,notices,security,foreignDecisionRows:foreign.length,originalService,replayRuns:state.replayRuns??0,reconcileRuns:state.reconcileRuns??0,clockTimeNotCopiedToDatabase:true};
  await writeFile(`artifacts/customer-commerce/p4-termination-${family}-sandbox.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}catch(e){console.error(JSON.stringify({failed:true,mode,code:(e as {code?:string}).code??'fixture_validation_failed',reason:e instanceof Error?e.message:'unknown'}));process.exitCode=1;}finally{await closeDb();}
