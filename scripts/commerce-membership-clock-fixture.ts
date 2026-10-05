// Actual sandbox lifecycle of the preserved browser purchase. No clock/financial facts fabricated in the DB.
// The application keeps real time: future paid cycles stay planned until their actual starts_at.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const url=new URL(process.env[source]??'');
 if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated preserved QA database required');
 url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
const testKey=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!testKey.startsWith('sk_test_'))throw new Error('Explicit commerce test key required');
const mode=process.argv[2]??'',stage=process.argv[3];
if(!['prepare','status','renew-boundary','renew-charge','fail-method','fail-boundary','fail-charge','recover','verify','reconcile'].includes(mode??''))throw new Error('Unknown clock fixture mode');
const annual=process.argv.includes('--year'),amount=annual?99900:9900,cyclesPerInvoice=annual?12:1;
const purchase=JSON.parse(await readFile(annual?'/tmp/commerce-membership-year-browser-private.json':'/tmp/commerce-membership-browser-private.json','utf8')) as {membershipId:string;orderId:string};
const path=annual?'/tmp/commerce-membership-year-clock-private.json':'/tmp/commerce-membership-clock-private.json';
type State={key:string;membershipId:string;customerId:string;subscriptionId:string;accountId:string;clockId?:string;initialTime?:number;goodPaymentMethod:string;badPaymentMethod?:string;targets:Record<string,number>;reconciliationRuns?:number;recoveredInvoiceId?:string};
let state:State|undefined;try{state=JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
const stripe=commerceStripeClient(),idOf=(value:unknown):string|null=>typeof value==='string'?value:value&&typeof value==='object'&&'id' in value?String(value.id):null;
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
try{
 const [m]=await withTenant(tenant,tx=>tx<{id:string;stripe_customer_id:string;stripe_subscription_id:string;stripe_account_id:string;snapshot:{terms:{amountCents:number;cadence:string}}}[]>`
  select m.*,a.stripe_account_id from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id
  where m.id=${purchase.membershipId} and m.original_order_id=${purchase.orderId} and not m.livemode and not a.livemode`);
 if(!m||m.snapshot.terms.amountCents!==amount||m.snapshot.terms.cadence!==(annual?'year':'month'))throw new Error('Preserved actual membership amount and cadence required');
 const options={stripeAccount:m.stripe_account_id},sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id,{},options),customer=await stripe.customers.retrieve(m.stripe_customer_id,{},options);
 if(sub.livemode||customer.deleted||idOf(sub.customer)!==m.stripe_customer_id||sub.metadata.gf_membership_id!==m.id
  ||customer.metadata.gf_membership_id!==m.id||sub.items.data.length!==1||sub.items.data[0]?.price.unit_amount!==amount)throw new Error('Clock provider ownership mismatch');
 if(!state){
  if(mode!=='prepare')throw new Error('Prepare clock once before advancing');
  const good=idOf(sub.default_payment_method)??idOf(customer.invoice_settings.default_payment_method);
  if(!good||sub.status!=='active'||sub.cancel_at)throw new Error('Active original subscription and payment method required');
  state={key:crypto.randomUUID(),membershipId:m.id,customerId:customer.id,subscriptionId:sub.id,accountId:m.stripe_account_id,goodPaymentMethod:good,targets:{}};await save();
 }
 if(state.membershipId!==m.id||state.customerId!==customer.id||state.subscriptionId!==sub.id||state.accountId!==m.stripe_account_id)throw new Error('Preserved clock binding changed');
 const owned=state;
 if(mode==='prepare'){
  if(!owned.clockId){
   if(customer.test_clock)throw new Error('Customer already belongs to another clock');
   owned.initialTime??=Math.ceil(Date.now()/1000)+30;await save();
   const clock=await stripe.testHelpers.testClocks.create({customer:customer.id,frozen_time:owned.initialTime,name:`GF preserved ${annual?'$999 annual':'$99 monthly'} renewal`},
    {...options,idempotencyKey:`gf-membership-clock:${owned.key}`});
   if(clock.livemode)throw new Error('Unexpected live clock');owned.clockId=clock.id;await save();
  }
  console.log(JSON.stringify({prepared:true,clockId:owned.clockId,originalPurchaseReused:true,productionChanged:false,providerAutoDeletesAfter30Days:true}));
 }
 if(!owned.clockId)throw new Error('Clock creation incomplete');
 if(mode.endsWith('-boundary')||mode.endsWith('-charge')){
  const name=mode;
  if(name==='fail-boundary'&&!owned.targets[name]&&(!owned.badPaymentMethod||idOf(sub.default_payment_method)!==owned.badPaymentMethod))throw new Error('Set owned decline method before failed renewal');
  if(!owned.targets[name]){
   if(name.endsWith('-charge')){
    const boundary=owned.targets[name.replace('-charge','-boundary')];if(!boundary)throw new Error('Advance boundary before invoice finalization');
    owned.targets[name]=boundary+3601;
   }else owned.targets[name]=sub.items.data[0]!.current_period_end+1;
   await save();
  }
  let clock=await stripe.testHelpers.testClocks.retrieve(owned.clockId,{},options);
  if(clock.status==='ready'&&clock.frozen_time<owned.targets[name]!)clock=await stripe.testHelpers.testClocks.advance(owned.clockId,{frozen_time:owned.targets[name]!},
   {...options,idempotencyKey:`gf-membership-clock:${owned.key}:${name}`});
  const deadline=Date.now()+45000;
  while(clock.status==='advancing'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1000));clock=await stripe.testHelpers.testClocks.retrieve(owned.clockId,{},options);}
  if(clock.status!=='ready'||clock.frozen_time<owned.targets[name]!)throw new Error('Clock still advancing; inspect status before repeating');
  console.log(JSON.stringify({advanced:true,stage:name,clockTime:clock.frozen_time,realTimeDatabaseUnchanged:true}));
 }
 if(mode==='fail-method'){
  if(owned.recoveredInvoiceId)throw new Error('Recovered fixture must not return to the decline phase');
  if(!owned.badPaymentMethod){const pm=await stripe.paymentMethods.attach('pm_card_chargeCustomerFail',{customer:customer.id},
   {...options,idempotencyKey:`gf-membership-clock:${owned.key}:decline-method`});owned.badPaymentMethod=pm.id;await save();}
  const updated=await stripe.subscriptions.update(sub.id,{default_payment_method:owned.badPaymentMethod},
   {...options,idempotencyKey:`gf-membership-clock:${owned.key}:set-decline`});
  if(idOf(updated.default_payment_method)!==owned.badPaymentMethod)throw new Error('Decline payment method not set');
  console.log(JSON.stringify({testDeclineMethodSet:true,originalGoodMethodPreserved:true,productionChanged:false}));
 }
 if(mode==='recover'){
  const invoiceId=idOf(sub.latest_invoice);if(!invoiceId)throw new Error('Original failed renewal invoice required');
  const invoice=await stripe.invoices.retrieve(invoiceId,{},options);
  if(!owned.badPaymentMethod||!owned.targets['fail-boundary']||invoice.lines.data[0]?.period.start!==owned.targets['fail-boundary']-1
   ||idOf(invoice.parent?.subscription_details?.subscription)!==sub.id)throw new Error('Recovery must use the owned failed-cycle invoice');
  await stripe.subscriptions.update(sub.id,{default_payment_method:owned.goodPaymentMethod},
   {...options,idempotencyKey:`gf-membership-clock:${owned.key}:restore-good`});
  if(invoice.status!=='paid'){
   if(invoice.status!=='open'||idOf(invoice.parent?.subscription_details?.subscription)!==sub.id)throw new Error('Expected open original renewal invoice');
   await stripe.invoices.pay(invoice.id,{payment_method:owned.goodPaymentMethod},
    {...options,idempotencyKey:`gf-membership-clock:${owned.key}:recover:${invoice.id}`});
  }
  const recovered=await stripe.invoices.retrieve(invoice.id,{},options);
  if(recovered.status!=='paid')throw new Error('Original renewal invoice still unpaid');
  owned.recoveredInvoiceId=invoice.id;await save();
  console.log(JSON.stringify({originalInvoicePaid:true,paymentRequested:invoice.status!=='paid',goodMethodRestored:true,productionChanged:false}));
 }
 if(mode==='reconcile'){
  if(!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Existing local QA authentication required');
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
   body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error('Existing local owner login failed');const login=await auth.json() as {access_token:string;user:{id:string}};
  const [employee]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
  if(!employee)throw new Error('Existing owner membership required');
  const result=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${purchase.orderId}/reconcile`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee.id}});
  if(!result.ok)throw new Error('Authenticated SDK reconciliation failed');
  owned.reconciliationRuns=(owned.reconciliationRuns??0)+1;await save();
  console.log(JSON.stringify({authenticatedReconciliation:true,fabricatedEvents:false}));
 }
 if(mode==='status'||mode==='verify'){
  const current=await stripe.subscriptions.retrieve(sub.id,{},options),clock=await stripe.testHelpers.testClocks.retrieve(owned.clockId,{},options);
  const invoices=[];for await(const i of stripe.invoices.list({subscription:sub.id,limit:100},options))invoices.push({id:i.id,status:i.status,paidCents:i.amount_paid,totalCents:i.total,attemptCount:i.attempt_count,periodStart:i.lines.data[0]?.period.start,periodEnd:i.lines.data[0]?.period.end});
  const [db]=await withTenant(tenant,tx=>tx`select m.provider_status,m.cancel_at_period_end,m.terminated_at,
   (select count(*)::int from customer_membership_invoices where membership_id=m.id) as invoices,
   (select coalesce(sum(p.amount_cents),0)::int from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=m.id) as cash_cents,
   (select count(*)::int from customer_membership_cycles where membership_id=m.id) as cycles,
   (select count(*)::int from customer_membership_cycles where membership_id=m.id and status='planned') as planned_cycles,
   (select count(*)::int from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=m.id) as ledger_rows,
   (select coalesce(sum(upper(r)-lower(r)),0)::int from customer_membership_cycles c cross join lateral unnest(c.available_units)r
    where c.membership_id=m.id and c.status='issued' and c.starts_at<=now() and c.ends_at>now() and not m.commerce_frozen and m.terminated_at is null) as available_current_quantity,
   (select count(*)::int from commerce_events e where e.event_id like 'evt_%' and e.event_type='invoice.paid' and e.object_id=any(select i.stripe_invoice_id from customer_membership_invoices i where i.membership_id=m.id)) as signed_paid_events,
   (select count(*)::int from commerce_events e where e.event_id like 'evt_%' and e.event_type='invoice.payment_failed'
    and (e.object_id=m.stripe_subscription_id or e.object_id=any(${invoices.map(i=>i.id)}::text[]))) as signed_failed_events
   from customer_paid_memberships m where m.id=${m.id}`);
  const notices=await withTenant(tenant,tx=>tx`select entity_type,count(*)::int as n,min(status) as status from email_outbox
   where commerce_order_id=${purchase.orderId} and entity_type like 'customer_membership_%' group by entity_type order by entity_type`);
  const payments=await withTenant(tenant,tx=>tx<{stripe_invoice_id:string;payment_intent_id:string;amount_cents:number;fee_cents:number;net_cents:number;balance_transaction_id:string}[]>`
   select i.stripe_invoice_id,p.payment_intent_id,p.amount_cents,p.fee_cents,p.net_cents,p.balance_transaction_id from customer_membership_invoices i
   join commerce_payments p on p.id=i.payment_id where i.membership_id=${m.id} order by i.period_start`);
  const cycleCoverage=await withTenant(tenant,tx=>tx<{stripe_invoice_id:string;batch_count:number;value_cents:number;quantity:number;starts_at:string;ends_at:string}[]>`
   select i.stripe_invoice_id,count(*)::int as batch_count,sum(c.value_cents)::int as value_cents,sum(c.quantity)::int as quantity,
    min(c.starts_at)::text as starts_at,max(c.ends_at)::text as ends_at from customer_membership_cycles c
   join customer_membership_invoices i on i.id=c.invoice_id where c.membership_id=${m.id} group by i.id order by i.period_start`);
  const settlements=[];
  if(mode==='verify')for(const p of payments){
   const invoicePayments=await stripe.invoicePayments.list({invoice:p.stripe_invoice_id,status:'paid',limit:100},options),paid=invoicePayments.data[0];
   if(invoicePayments.has_more||invoicePayments.data.length!==1||idOf(paid?.payment.payment_intent)!==p.payment_intent_id||paid?.amount_paid!==p.amount_cents)throw new Error('Invoice payment mapping changed');
   const intent=await stripe.paymentIntents.retrieve(p.payment_intent_id,{expand:['latest_charge.balance_transaction']},options);
   const charge=intent.latest_charge&&typeof intent.latest_charge!=='string'?intent.latest_charge:null,balance=charge?.balance_transaction&&typeof charge.balance_transaction!=='string'?charge.balance_transaction:null;
   if(intent.livemode||intent.status!=='succeeded'||intent.amount_received!==p.amount_cents||idOf(intent.customer)!==customer.id
    ||!balance||balance.id!==p.balance_transaction_id||balance.amount!==p.amount_cents||balance.fee!==p.fee_cents||balance.net!==p.net_cents)throw new Error('Wait for verified cash settlement');
   settlements.push({invoiceId:p.stripe_invoice_id,paymentIntentId:p.payment_intent_id,status:intent.status,grossCents:balance.amount,feeCents:balance.fee,netCents:balance.net,verified:true});
  }
  if(mode==='verify'){
   if(!['renewed','failed','recovered','reconciled'].includes(stage??''))throw new Error('Expected renewed|failed|recovered|reconciled verification stage');
   const paid=['recovered','reconciled'].includes(stage!)?3:2,expectedStatus=stage==='failed'?'past_due':'active';
   if(current.status!==expectedStatus||db?.provider_status!==expectedStatus||db?.invoices!==paid||db.cash_cents!==paid*amount||db.cycles!==paid*cyclesPerInvoice
    ||db.ledger_rows!==1||db.available_current_quantity!==1||db.planned_cycles!==paid*cyclesPerInvoice-1||db.signed_paid_events<paid||invoices.filter(i=>i.status==='paid').length!==paid
    ||(stage==='failed'&&(!invoices.some(i=>i.status==='open'&&i.paidCents===0)||db.signed_failed_events<1))
    ||(['recovered','reconciled'].includes(stage!)&&db.signed_failed_events<1)
    ||(stage==='reconciled'&&(owned.reconciliationRuns??0)<2))throw new Error('Wait for genuine signed lifecycle events or investigate mismatched facts');
   if(cycleCoverage.length!==paid||cycleCoverage.some(c=>{
    const i=invoices.find(invoice=>invoice.id===c.stripe_invoice_id);
    return c.batch_count!==cyclesPerInvoice||c.value_cents!==amount||c.quantity!==cyclesPerInvoice
     ||!i||new Date(c.starts_at).getTime()/1000!==i.periodStart||new Date(c.ends_at).getTime()/1000!==i.periodEnd;
   }))throw new Error('Paid calendar benefit coverage or value allocation changed');
  }
  const report={at:new Date().toISOString(),scope:`P4 actual original ${annual?'annual':'monthly'} subscription clock renewal and recovery`,stage:stage??'observed',stripeVerified:true,
   originalBrowserPurchaseReused:true,productionPublished:false,realEmailSent:false,clock:{id:clock.id,status:clock.status,frozenTime:clock.frozen_time,autoDeletesAt:clock.deletes_after},
   stripe:{subscriptionId:current.id,customerId:customer.id,accountId:owned.accountId,status:current.status,livemode:current.livemode,effectiveGoodPaymentMethod:(idOf(current.default_payment_method)??idOf(customer.invoice_settings.default_payment_method))===owned.goodPaymentMethod,invoices,settlements},db,cycleCoverage,notices,
   authenticatedReconciliationRuns:owned.reconciliationRuns??0,
   applicationClockAdvanced:false,futureBenefitsIssued:false,lifecycleAcceptanceComplete:false,goalComplete:false};
  if(mode==='verify')await writeFile(`artifacts/customer-commerce/stripe-membership-clock-${annual?'annual-':''}${stage}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 }
}catch(error){const e=error as {code?:string;type?:string;statusCode?:number;param?:string};console.error(JSON.stringify({clockFixtureFailed:true,mode,code:e.code??null,type:e.type??'Error',statusCode:e.statusCode??null,param:e.param??null,reason:e.type?undefined:error instanceof Error?error.message:'fixture_failed',providerFactsNotFabricated:true}));process.exitCode=1;}
finally{await closeDb();}
