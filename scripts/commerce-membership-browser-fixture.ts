// Preserved, local-only browser QA. No fabricated provider facts, database resets or production changes.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const url=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated QA database required');
 url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local test mode only');
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
const mode=process.argv[2];if(!['prepare','restore','verify','discover','portal-verify','reconcile','open-member'].includes(mode??''))throw new Error('Expected prepare|restore|verify|discover|portal-verify|reconcile|open-member');
const discountFamily=process.argv[3]==='discount';
const cadence=process.argv[3]==='year'?'year':'month',expectedAmount=discountFamily?4900:cadence==='year'?99900:9900;
const path=discountFamily?'/tmp/commerce-membership-discount-browser-private.json':cadence==='year'?'/tmp/commerce-membership-year-browser-private.json':'/tmp/commerce-membership-browser-private.json';
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
type State={key:string;previousSettings?:{salesEnabled:boolean;depositsEnabled:boolean;membershipsEnabled:boolean};planId?:string;versionId?:string;membershipId?:string;orderId?:string;settingsRestored?:boolean};
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
const {withTenant,closeDb}=await import('../packages/db/src/index');
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
try{
 const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
  body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
 if(!auth.ok)throw new Error('Existing local QA owner login required');const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
 const [employee]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
 if(!employee)throw new Error('Existing QA owner required');
 const authPath='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(authPath,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
 const origin=browser.origins.find(o=>o.origin==='http://localhost:5297'),entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
 if(!origin||!entry)throw new Error('Owned browser auth state missing');entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
 await writeFile(authPath,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(authPath,0o600);
 async function command<T>(name:string,input:unknown,suffix:string):Promise<T>{
  const r=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee!.id,'content-type':'application/json'},
   body:JSON.stringify({input,idempotencyKey:`membership-browser:${state.key}:${suffix}`})});
  const out=await r.json() as {result:T;code?:string;details?:{reason?:string}};if(!r.ok)throw new Error(`QA command ${name}: ${r.status} ${out.code??''} ${out.details?.reason??''}`);return out.result;
 }
 const [location]=await withTenant(tenant,tx=>tx<{slug:string;settings:{commerce:State['previousSettings']}}[]>`select slug,settings from locations where id=${tenant.locationId}`);
 if(mode==='prepare'){
  if(state.membershipId)throw new Error('Preserved browser purchase already exists; use verify instead of buying again');
  if(!state.previousSettings){state.previousSettings=location!.settings.commerce;await save();}
  if(!state.previousSettings)throw new Error('Full prior commerce settings required');
  if(!state.planId){
   const p=await command<{planId:string;versionId:string}>('commerce.saveMembershipPlan',{active:true,onlineSale:true,
    terms:{name:{en:discountFamily?'QA Member Price':cadence==='year'?'QA Annual Care':'QA Monthly Care', 'zh-Hans':discountFamily?'验收次数与折扣会员':cadence==='year'?'验收年付护理会员':'验收月付护理会员'},amountCents:expectedAmount,cadence,benefitFrequency:'month',quantity:1,
     serviceIds:['58358808-efbf-4c74-83c8-de5105f3893c'],discountBps:discountFamily?1000:0,discountServiceIds:discountFamily?['58358808-efbf-4c74-83c8-de5105f3893c']:[],commissionBasis:'sale_price'}},'plan');
   state.planId=p.planId;state.versionId=p.versionId;await save();
  }
  await command('commerce.saveSettings',{...state.previousSettings,membershipsEnabled:true},'enable');state.settingsRestored=false;await save();
  console.log(JSON.stringify({prepared:true,planId:state.planId,versionId:state.versionId,url:`http://localhost:5296/${location!.slug}/memberships`,amountCents:expectedAmount,prod:false}));
 }
 if(mode==='restore'){
  if(!state.previousSettings)throw new Error('Prior settings required');await command('commerce.saveSettings',state.previousSettings,'restore');state.settingsRestored=true;await save();
  console.log(JSON.stringify({settingsRestored:true,productionChanged:false}));
 }
 if(mode==='discover'||mode==='verify'){
  const rows=await withTenant(tenant,tx=>tx<{id:string;original_order_id:string;provider_status:string;stripe_subscription_id:string|null;stripe_customer_id:string|null;current_period_end:string|null}[]>`
   select id,original_order_id,provider_status,stripe_subscription_id,stripe_customer_id,current_period_end from customer_paid_memberships where plan_version_id=${state.versionId!}`);
  if(rows.length!==1)throw new Error('Expected exactly one actual browser membership');const m=rows[0]!;state.membershipId=m.id;state.orderId=m.original_order_id;await save();
  if(mode==='discover')console.log(JSON.stringify({membershipId:m.id,orderId:m.original_order_id,status:m.provider_status}));
  else{
   const [payment]=await withTenant(tenant,tx=>tx`select id,status,amount_cents,currency,payment_intent_id,fee_cents,net_cents,balance_transaction_id,livemode from commerce_payments where order_id=${m.original_order_id}`);
   const invoices=await withTenant(tenant,tx=>tx`select id,stripe_invoice_id,period_start,period_end,paid_at from customer_membership_invoices where membership_id=${m.id}`);
   const cycles=await withTenant(tenant,tx=>tx`select id,starts_at,ends_at,quantity,value_cents,status from customer_membership_cycles where membership_id=${m.id}`);
   const [counts]=await withTenant(tenant,tx=>tx`select
    (select count(*)::int from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${m.id}) as ledger_entries,
    (select count(*)::int from commerce_events e where e.object_id=${m.stripe_subscription_id} and e.event_id like 'evt_%') as signed_subscription_events,
    (select count(*)::int from commerce_events e where e.object_id=any(${invoices.map(i=>i.stripe_invoice_id)}::text[]) and e.event_id like 'evt_%') as signed_invoice_events,
    (select count(*)::int from email_outbox e where e.commerce_order_id=${m.original_order_id} and e.entity_type='customer_membership_payment') as payment_notices`);
   const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
   const [mapping]=await withTenant(tenant,tx=>tx<{stripe_account_id:string}[]>`select stripe_account_id from commerce_accounts where location_id=${tenant.locationId} and not livemode`);
   if(!m.stripe_subscription_id||invoices.length!==1)throw new Error('Wait for the actual signed invoice before verifying');
   const [original]=await withTenant(tenant,tx=>tx`select snapshot->'terms'->>'amountCents' as purchased_amount from customer_paid_memberships where id=${m.id}`);
   const [latestPlan]=await withTenant(tenant,tx=>tx`select version,terms->>'amountCents' as amount from customer_membership_plan_versions where plan_id=${state.planId!} order by version desc limit 1`);
   const stripe=commerceStripeClient(),options={stripeAccount:mapping!.stripe_account_id};
   const sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id!,{},options),invoice=await stripe.invoices.retrieve(String(invoices[0]?.stripe_invoice_id),{},options);
   if(cycles.reduce((sum,c)=>sum+Number(c.value_cents),0)!==expectedAmount||cycles.filter(c=>c.status==='issued').length!==1||payment?.status!=='paid'||payment.amount_cents!==expectedAmount||invoices.length!==1||cycles.length!==(cadence==='year'?12:1)||counts?.ledger_entries!==1||counts.payment_notices!==1
    ||counts.signed_invoice_events<1||sub.items.data.length!==1||sub.items.data[0]?.price.unit_amount!==expectedAmount||sub.items.data[0]?.price.recurring?.interval!==cadence||sub.livemode||sub.status!=='active'||invoice.status!=='paid')throw new Error('Actual membership payment evidence incomplete');
   const report={scope:`P4 first ${cadence==='year'?'annual':'monthly'} subscription purchase`,at:new Date().toISOString(),productionPublished:false,realEmailSent:false,bankPayoutVerified:false,
    originalPlanAmountCents:Number(original?.purchased_amount),currentPlanVersion:latestPlan,customer:m,account:mapping!.stripe_account_id,payment,invoices,cycles,counts,
    stripe:{subscriptionId:sub.id,status:sub.status,livemode:sub.livemode,invoiceId:invoice.id,invoiceStatus:invoice.status,paidCents:invoice.amount_paid,
     renewalPriceCents:sub.items.data[0]?.price.unit_amount,renewalInterval:sub.items.data[0]?.price.recurring?.interval,nextPeriodEnd:sub.items.data[0]?.current_period_end},renewalVerified:false,annualSandboxVerified:cadence==='year',lifecycleAcceptanceComplete:false,settingsRestored:state.settingsRestored??false};
   await writeFile(`artifacts/customer-commerce/browser-membership-${discountFamily?'discount-purchase':cadence==='year'?'annual':'monthly'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }
 }
 if(mode==='portal-verify'){
  if(!state.membershipId||!state.orderId)throw new Error('Preserved actual membership required');
  const [m]=await withTenant(tenant,tx=>tx<{provider_status:string;cancel_at_period_end:boolean;stripe_subscription_id:string;stripe_customer_id:string;current_period_end:string}[]>`
   select provider_status,cancel_at_period_end,scheduled_cancel_at,provider_cancel_at_period_end,stripe_subscription_id,stripe_customer_id,current_period_end from customer_paid_memberships where id=${state.membershipId!}`);
  const [a]=await withTenant(tenant,tx=>tx<{stripe_account_id:string}[]>`select stripe_account_id from commerce_accounts where location_id=${tenant.locationId} and not livemode`);
  const {commerceStripeClient}=await import('../apps/api/src/commerce/client'),stripe=commerceStripeClient(),options={stripeAccount:a!.stripe_account_id};
  const sub=await stripe.subscriptions.retrieve(m!.stripe_subscription_id,{},options),customer=await stripe.customers.retrieve(m!.stripe_customer_id,{},options);
  const configs=[];for await(const c of stripe.billingPortal.configurations.list({active:true,limit:100},options))if(c.metadata?.gf_domain==='customer_membership_portal')configs.push({id:c.id,livemode:c.livemode,isDefault:c.is_default,features:c.features,loginPageEnabled:c.login_page.enabled});
  const notices=await withTenant(tenant,tx=>tx`select entity_type,count(*)::int as n,min(status) as status from email_outbox
   where commerce_order_id=${state.orderId!} and entity_type like 'customer_membership_%' group by entity_type order by entity_type`);
  const [counts]=await withTenant(tenant,tx=>tx`select
   (select count(*)::int from customer_membership_invoices where membership_id=${state.membershipId!}) as paid_invoices,
   (select count(*)::int from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${state.membershipId!}) as ledger_rows,
   (select sum(p.amount_cents)::int from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=${state.membershipId!}) as cash_cents,
   (select count(*)::int from commerce_events where object_id=${m!.stripe_subscription_id} and event_id like 'evt_%' and event_type='customer.subscription.updated') as signed_updates,
   (select count(*)::int from audit_log where entity_id=${state.membershipId!} and command='commerce.authorizeMembershipPortal') as portal_authorizations`);
  const effectiveCancel=sub.cancel_at_period_end||sub.cancel_at===sub.items.data[0]!.current_period_end;
  const defaultMethod=typeof sub.default_payment_method==='string'?sub.default_payment_method:sub.default_payment_method?.id;
  const customerMethod=!customer.deleted?(typeof customer.invoice_settings.default_payment_method==='string'?customer.invoice_settings.default_payment_method:customer.invoice_settings.default_payment_method?.id):null;
  const method=(defaultMethod||customerMethod)?await stripe.paymentMethods.retrieve((defaultMethod||customerMethod)!,{},options):null;
  console.log(JSON.stringify({observed:{dbStatus:m?.provider_status,dbCancel:m?.cancel_at_period_end,stripeStatus:sub.status,stripeCancel:sub.cancel_at_period_end,cancelAt:sub.cancel_at,currentPeriodEnd:sub.items.data[0]?.current_period_end,billingMode:sub.billing_mode?.type,counts,configs:configs.length}}));
  if(!m||m.provider_status!==sub.status||m.cancel_at_period_end!==effectiveCancel||sub.livemode||counts?.paid_invoices!==1||counts.ledger_rows!==1||counts.cash_cents!==expectedAmount
   ||configs.length!==1||configs[0]!.livemode||configs[0]!.features.subscription_update.enabled||configs[0]!.features.subscription_cancel.mode!=='at_period_end')throw new Error('Portal facts incomplete');
  const stage=process.argv[4]??'state';if(!['canceled','resumed','method-updated','invoice-viewed'].includes(stage))throw new Error('Expected portal stage');
  if(stage==='canceled'&&!effectiveCancel)throw new Error('Expected real period-end cancellation');
  if(stage==='resumed'&&effectiveCancel)throw new Error('Expected real renewal resumption');
  if(stage==='method-updated'&&method?.card?.last4!=='4444')throw new Error('Expected real replacement test payment method');
  const report={scope:'P4 actual connected-account portal lifecycle',at:new Date().toISOString(),stage,productionPublished:false,realEmailSent:false,
   membershipId:state.membershipId,accountId:a!.stripe_account_id,stripe:{subscriptionId:sub.id,status:sub.status,cancelAtPeriodEnd:effectiveCancel,providerCancelAtPeriodEnd:sub.cancel_at_period_end,scheduledCancelAt:sub.cancel_at,periodEnd:sub.items.data[0]!.current_period_end,
    priceCents:sub.items.data[0]!.price.unit_amount,livemode:sub.livemode,effectivePaymentMethod:{brand:method?.card?.brand,last4:method?.card?.last4}},db:m,counts,notices,configs,
   renewalChargeVerified:false,portalSessionUrlSaved:false};
  await writeFile(`artifacts/customer-commerce/browser-membership-portal-${stage}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({verified:true,stage,cancelAtPeriodEnd:effectiveCancel,counts}));
 }
 if(mode==='reconcile'){
  if(!state.orderId)throw new Error('Preserved actual membership required');
  const response=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${state.orderId}/reconcile`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee.id,'content-type':'application/json'},
   body:JSON.stringify({idempotencyKey:crypto.randomUUID()})});
  if(!response.ok)throw new Error('Actual membership reconciliation failed');console.log(JSON.stringify({reconciled:true,orderId:state.orderId,source:'verified_provider_retrieval'}));
 }
 if(mode==='open-member'){
  if(!state.membershipId)throw new Error('Preserved actual membership required');
  process.env.BOOKING_BASE_URL='http://localhost:5296';
  const {membershipManageUrl}=await import('../apps/api/src/commerce/customerMembership');
  const {workerContext}=await import('../apps/api/src/commerce/worker');
  const url=await membershipManageUrl(workerContext(tenant.orgId,tenant.locationId),state.membershipId);
  const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
  const opened=spawnSync(process.execPath,[cli,'--session',`commerce-member-${discountFamily?'discount':cadence==='year'?'annual':'monthly'}-portal-final`,'open',url],{encoding:'utf8'});
  if(opened.status!==0)throw new Error('Owned browser opening failed');
  console.log(JSON.stringify({opened:true,membershipId:state.membershipId,privateTokenPrinted:false}));
 }
}catch(error){console.error(JSON.stringify({failed:true,mode,code:(error as {code?:string}).code??'fixture_validation_failed'}));process.exitCode=1;}finally{await closeDb();}
