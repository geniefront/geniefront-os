// Actual original-subscription plan change and renewal; never replace the subscription or fabricate provider cash.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332')throw new Error('Preserved local QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';process.env.BOOKING_BASE_URL='http://localhost:5296';assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!(process.env.COMMERCE_STRIPE_SECRET_KEY||process.env.STRIPE_SECRET_KEY||'').startsWith('sk_test_')||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local Auth and test Stripe required');
const mode=process.argv[2],annual=process.argv.includes('--year'),cadence=annual?'year':'month',amount=annual?99900:14900,session='commerce-plan-change-native',path=`/tmp/commerce-plan-change-${cadence}-private.json`;
if(!['prepare','open','install-loss','capture-loss','observe-replay','verify-scheduled','clock-status','advance-boundary','advance-charge','reconcile','verify-renewed','restore'].includes(mode??''))throw new Error('Unknown plan-change fixture mode');
const purchase=JSON.parse(await readFile('/tmp/commerce-membership-browser-private.json','utf8')) as {membershipId:string;orderId:string};
const clock=JSON.parse(await readFile('/tmp/commerce-membership-clock-private.json','utf8')) as {clockId:string;customerId:string;subscriptionId:string;accountId:string};
type State={key:string;planId?:string;versionId?:string;changeId?:string;before?:Record<string,unknown>;previousSettings?:{salesEnabled:boolean;depositsEnabled:boolean;membershipsEnabled:boolean};targets?:{boundary:number;charge:number};attempt?:{businessKey:string;status:number};};let state:State;
try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index'),{commerceStripeClient}=await import('../apps/api/src/commerce/client');
const stripe=commerceStripeClient(),tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
function browser(args:string[],input?:string){const r=spawnSync(process.execPath,[cli,'--session',session,...args],{encoding:'utf8',...(input?{input}:{})});if(r.status!==0)throw new Error('Owned native browser failed');return r.stdout.trim();}
function evaluate(code:string){return JSON.parse(browser(['eval','--stdin'],code));}
async function originals(){return withTenant(tenant,async tx=>{
 const [invoices]=await tx`select count(*)::int as count,md5(string_agg(row_to_json(i)::text,'|' order by id)) as hash,array_agg(id order by id) as ids from customer_membership_invoices i where membership_id=${purchase.membershipId}`;
 const [payments]=await tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash,array_agg(id order by id) as ids from commerce_payments p`;
 return {invoices,payments};});}
async function auth(){const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});if(!response.ok)throw new Error('Local QA owner login failed');const login=await response.json() as {access_token:string;user:{id:string}};const [owner]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!owner)throw new Error('Owned QA employee required');return {authorization:`Bearer ${login.access_token}`,'x-membership-id':owner.id,'content-type':'application/json'};}
try{
 const [m]=await withTenant(tenant,tx=>tx`select m.*,a.stripe_account_id from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${purchase.membershipId}`);
 if(!m||m.livemode||m.original_order_id!==purchase.orderId||m.stripe_subscription_id!==clock.subscriptionId||m.stripe_customer_id!==clock.customerId||m.stripe_account_id!==clock.accountId||m.snapshot.terms.amountCents!==9900)throw new Error('Original monthly subscription binding required');
 const options={stripeAccount:m.stripe_account_id};
 if(mode==='prepare'||mode==='restore'){
  const headers=await auth();async function command<T>(name:string,input:unknown,suffix:string){const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,body:JSON.stringify({input,idempotencyKey:`plan-change-fixture:${state.key}:${suffix}`})});const data=await response.json() as {result:T;code?:string};if(!response.ok)throw new Error(`${name}: ${response.status} ${data.code??''}`);return data.result;}
  if(mode==='restore'){if(!state.previousSettings)throw new Error('Original settings required');await command('commerce.saveSettings',state.previousSettings,'restore');console.log(JSON.stringify({restored:true}));}
  else{
   if(!state.previousSettings){const [l]=await withTenant(tenant,tx=>tx`select settings->'commerce' as commerce from locations where id=${tenant.locationId}`);state.previousSettings={salesEnabled:!!l!.commerce?.salesEnabled,depositsEnabled:!!l!.commerce?.depositsEnabled,membershipsEnabled:!!l!.commerce?.membershipsEnabled};await save();}
   await command('commerce.saveSettings',{...state.previousSettings,membershipsEnabled:true},'enable');
   if(!state.versionId){const result=await command<{planId:string;versionId:string}>('commerce.saveMembershipPlan',{terms:{...m.snapshot.terms,name:{en:annual?'QA Next Annual Care':'QA Next Monthly Care','zh-Hans':annual?'验收下期年付护理':'验收下期月付护理'},amountCents:amount,cadence,quantity:2,benefitFrequency:'month'},active:true,onlineSale:true},'plan');state.planId=result.planId;state.versionId=result.versionId;await save();}
   if(!state.before){state.before=await originals();await save();}
   console.log(JSON.stringify({prepared:true,cadence,amountCents:amount,versionId:state.versionId,newSubscription:false}));
  }
 }else if(mode==='open'){
  const {membershipManageUrl}=await import('../apps/api/src/commerce/customerMembership'),{workerContext}=await import('../apps/api/src/commerce/worker');browser(['open',await membershipManageUrl(workerContext(tenant.orgId,tenant.locationId),purchase.membershipId)]);console.log(JSON.stringify({opened:true,privateTokenPrinted:false}));
 }else if(mode==='install-loss'){
  console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);let lost=false;window.fetch=async(...args)=>{const response=await original(...args);let body;try{body=JSON.parse(args[1]?.body??'null');}catch{}if(!lost&&String(args[0]).endsWith('/memberships/${purchase.membershipId}/plan-change')&&body?.versionId===${JSON.stringify(state.versionId)}&&response.ok){lost=true;window.__planChangeLoss={businessKey:body.businessKey,status:response.status};throw new Error('QA response lost after actual plan-change request');}return response;};return {installed:true};})()`)));
 }else if(mode==='capture-loss'){
  state.attempt=evaluate('window.__planChangeLoss');if(!state.attempt||state.attempt.status!==200)throw new Error('Actual successful response loss required');await save();console.log(JSON.stringify({captured:true,status:200}));
 }else if(mode==='observe-replay'){
  if(!state.attempt)throw new Error('Original request required');console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/memberships/${purchase.membershipId}/plan-change')){const result=await response.clone().json();window.__planChangeReplay={status:response.status,replayed:result.replayed,sameKey:JSON.parse(args[1].body).businessKey===${JSON.stringify(state.attempt.businessKey)}};}return response;};return {observing:true};})()`)));
 }else if(mode==='clock-status'||mode.startsWith('advance-')){
  const current=await stripe.testHelpers.testClocks.retrieve(clock.clockId,{},options),sub=await stripe.subscriptions.retrieve(clock.subscriptionId,{},options);
  if(current.livemode||sub.customer!==clock.customerId||sub.metadata.gf_membership_id!==m.id)throw new Error('Original clock ownership required');
  if(mode==='clock-status')console.log(JSON.stringify({clockStatus:current.status,frozenTime:current.frozen_time,priceCents:sub.items.data[0]!.price.unit_amount,periodEnd:sub.items.data[0]!.current_period_end}));
  else{
   if(current.status!=='ready')throw new Error('Original clock is still advancing');
   if(!state.targets){const item=sub.items.data[0]!;state.targets={boundary:item.current_period_end+60,charge:item.current_period_end+3660};await save();}
   const target=mode==='advance-boundary'?state.targets.boundary:state.targets.charge;
   if(current.frozen_time<target){await stripe.testHelpers.testClocks.advance(clock.clockId,{frozen_time:target},{...options,idempotencyKey:`plan-change-clock:${state.key}:${mode}`});console.log(JSON.stringify({advancing:true,target}));}else console.log(JSON.stringify({alreadyAdvanced:true,target}));
  }
 }else if(mode==='reconcile'){
  const response=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${purchase.orderId}/reconcile`,{method:'POST',headers:await auth(),body:'{}'});if(!response.ok)throw new Error(`Original subscription reconciliation failed ${response.status}`);console.log(JSON.stringify({reconciled:true}));
 }else{
  if(!state.before||!state.versionId)throw new Error('Prepared baseline required');
  const [change]=await withTenant(tenant,tx=>tx`select * from customer_membership_plan_changes where membership_id=${m.id} and plan_version_id=${state.versionId!}`);if(!change||!['scheduled','applied'].includes(change.status))throw new Error('Actual schedule is not confirmed');state.changeId=change.id;await save();
  const sub=await stripe.subscriptions.retrieve(clock.subscriptionId,{},options),schedule=await stripe.subscriptionSchedules.retrieve(change.stripe_schedule_id,{},options);
  if(sub.livemode||sub.id!==clock.subscriptionId||schedule.metadata.gf_change_id!==change.id||schedule.end_behavior!=='release'||schedule.phases[1]?.start_date!==Math.floor(new Date(change.effective_at).getTime()/1000)||schedule.phases[1]?.items[0]?.price!==change.stripe_price_id)throw new Error('Actual original subscription schedule mismatch');
  const before=state.before as {invoices:{count:number;hash:string;ids:string[]};payments:{count:number;hash:string;ids:string[]}};
  const [preserved]=await withTenant(tenant,tx=>tx`select (select md5(string_agg(row_to_json(i)::text,'|' order by id)) from customer_membership_invoices i where id=any(${before.invoices.ids}::uuid[])) as invoices,
   (select md5(string_agg(row_to_json(p)::text,'|' order by id)) from commerce_payments p where id=any(${before.payments.ids}::uuid[])) as payments`);
  if(preserved!.invoices!==before.invoices.hash||preserved!.payments!==before.payments.hash)throw new Error('Original invoices or payments changed');
  const [facts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from customer_membership_invoices where membership_id=${m.id}) as invoices,
   (select count(*)::int from commerce_payments) as payments,(select count(*)::int from customer_membership_plan_changes where membership_id=${m.id} and plan_version_id=${state.versionId!}) as changes,
   (select count(*)::int from audit_log where command='commerce.requestMembershipChange' and entity_id=${change.id}) as requests,
   (select coalesce(sum(upper(r)-lower(r)),0)::int from customer_membership_cycles c cross join lateral unnest(c.available_units)r where c.membership_id=${m.id} and c.status='issued' and c.starts_at<=now() and c.ends_at>now()) as currently_available`);
  const renewed=mode==='verify-renewed';if(facts!.changes!==1||facts!.requests!==1||facts!.invoices!==before.invoices.count+(renewed?1:0)||facts!.payments!==before.payments.count+(renewed?1:0)||facts!.currently_available!==1)throw new Error('Schedule or renewal duplicated/changed original assets');
  let renewal:unknown=null,replay:unknown=null;
  if(renewed){
   const [paid]=await withTenant(tenant,tx=>tx`select i.stripe_invoice_id,p.amount_cents,p.status,p.fee_cents,p.net_cents,i.snapshot,i.stripe_price_id,
    (select count(*)::int from customer_membership_cycles where invoice_id=i.id) as cycles,(select sum(quantity)::int from customer_membership_cycles where invoice_id=i.id) as planned_units
    from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=${m.id} and i.plan_version_id=${state.versionId!}`);
   if(!paid||paid.amount_cents!==amount||paid.status!=='paid'||paid.snapshot.terms.cadence!==cadence||paid.stripe_price_id!==change.stripe_price_id||paid.cycles!==(annual?12:1)||paid.planned_units!==(annual?24:2)||change.status!=='applied')throw new Error('New paid-period contract mismatch');
   const invoice=await stripe.invoices.retrieve(paid.stripe_invoice_id,{},options);if(invoice.status!=='paid'||invoice.amount_paid!==amount||invoice.parent?.subscription_details?.subscription!==clock.subscriptionId||invoice.lines.data[0]?.pricing?.price_details?.price!==change.stripe_price_id)throw new Error('Actual changed-price invoice is not paid');
   renewal={amountCents:paid.amount_cents,cycles:paid.cycles,plannedUnits:paid.planned_units,feeCents:paid.fee_cents,netCents:paid.net_cents};
  }else{replay=evaluate('window.__planChangeReplay');if(!(replay as {replayed?:boolean})?.replayed||!(replay as {sameKey?:boolean})?.sameKey)throw new Error('Actual refreshed request replay required');}
  const report={at:new Date().toISOString(),membershipId:m.id,changeId:change.id,status:change.status,cadence,nextAmountCents:amount,effectiveAt:change.effective_at,originalSubscriptionReused:true,oldInvoiceAndPaymentRowsUnchanged:true,facts,renewal,replay,productionPublished:false};
  await writeFile(`artifacts/customer-commerce/p4-plan-change-${cadence}-${renewed?'renewed':'scheduled'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}finally{await closeDb();}
