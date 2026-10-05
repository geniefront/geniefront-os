// One real online $500/10 package purchase will also fund the test merchant's payout acceptance.
// Preparation creates only a QA catalog entry; the customer purchase and Checkout happen in the browser.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const u=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='58332')throw new Error('Dedicated preserved QA database required');u.pathname='/gf_commerce_ci';process.env[target]=u.href;
}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!key.startsWith('sk_test_')||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local authentication and explicit test mode required');
const mode=process.argv[2];if(!['prepare','discover','verify','checkout-check','restore','open-store','open-result','prepare-service','edit-template','open-desk','verify-consumed','verify-restored','verify-unused-refund','verify-service-partial','verify-service-return','reconcile'].includes(mode??''))throw new Error('Unknown package fixture mode');
const path='/tmp/commerce-package-payout-private.json';
type State={key:string;templateId?:string;serviceId?:string;slug?:string;orderId?:string;ticketId?:string;itemId?:string;staffId?:string;templateEdited?:boolean;reconcileRuns?:number;previousSettings?:{salesEnabled:boolean;depositsEnabled:boolean;membershipsEnabled:boolean};settingsRestored?:boolean};
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const {withTenant,closeDb}=await import('../packages/db/src/index');
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
try{
 const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
 if(!auth.ok)throw new Error('Existing local owner login required');const login=await auth.json() as {access_token:string;user:{id:string}};
 const [employee]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!employee)throw new Error('Existing owner membership required');
 async function command<T>(name:string,input:unknown,suffix:string):Promise<T>{
  const r=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee!.id,'content-type':'application/json'},body:JSON.stringify({input,idempotencyKey:`package-payout:${state.key}:${suffix}`})});
  const out=await r.json() as {result:T;code?:string};if(!r.ok)throw new Error(`QA command ${name}: ${r.status} ${out.code??''}`);return out.result;
 }
 const [location]=await withTenant(tenant,tx=>tx<{slug:string;settings:{commerce:NonNullable<State['previousSettings']>}}[]>`select slug,settings from locations where id=${tenant.locationId}`);if(!location)throw new Error('Existing QA shop required');state.slug=location.slug;
 if(mode==='prepare'){
  if(state.orderId)throw new Error('Actual purchase exists; preserve and verify it');
  state.previousSettings??=location.settings.commerce;await save();
  if(!location.settings.commerce.salesEnabled)await command('commerce.saveSettings',{...location.settings.commerce,salesEnabled:true},'enable-sales');
  if(!state.templateId){
   const [service]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from services where location_id=${tenant.locationId} and active and name->>'en'='Foot Reflexology 60min'`);if(!service)throw new Error('Existing catalog service required');state.serviceId=service.id;
   const t=await command<{templateId:string}>('package.saveTemplate',{name:{en:'QA 10 service package','zh-Hans':'验收10次护理次卡'},priceCents:50000,sessions:10,serviceIds:[service.id],validDays:365,scope:'location',onlineSale:true,coverageMode:'any_included',commissionBasis:'sale_price',active:true},'template');state.templateId=t.templateId;await save();
  }
  console.log(JSON.stringify({prepared:true,templateId:state.templateId,priceCents:50000,quantity:10,checkoutCreated:false,productionChanged:false}));
 }
 if(mode==='open-store'){
  if(!state.templateId)throw new Error('Prepare catalog first');
  const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
  const r=spawnSync(process.execPath,[cli,'--session','commerce-package-payout-purchase','open',`http://localhost:5296/${encodeURIComponent(location.slug)}/shop`],{encoding:'utf8'});if(r.status!==0)throw new Error('Owned browser opening failed');console.log(JSON.stringify({opened:true}));
 }
 if(mode==='open-result'){
  if(!state.orderId)throw new Error('Original paid browser purchase required');
  const emails=await withTenant(tenant,tx=>tx<{body_text:string;to_email:string}[]>`select body_text,to_email from email_outbox where commerce_order_id=${state.orderId} and entity_type='commerce_purchase_buyer' order by created_at`);
  let url:string|undefined;
  for(const email of emails){if(email.to_email!=='package-payout@example.test')continue;for(const line of email.body_text.split('\n')){try{const u=new URL(line);
    if(u.origin!=='http://localhost:5296'||u.searchParams.get('order')!==state.orderId||!u.hash.startsWith('#c/'))continue;
    const [valid]=await withTenant(tenant,tx=>tx`select id from commerce_access_tokens where order_id=${state.orderId} and token_hash=${createHash('sha256').update(u.hash.slice(3)).digest('hex')} and revoked_at is null and expires_at>now()`);if(valid)url=u.href;
  }catch{}}}
  if(!url)throw new Error('Existing scoped buyer receipt link is unavailable; do not mint a replacement');
  const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js',r=spawnSync(process.execPath,[cli,'--session','commerce-package-payout-purchase','open',url],{encoding:'utf8'});
  if(r.status!==0)throw new Error('Owned original buyer result could not be opened');console.log(JSON.stringify({opened:true,originalCapturedBuyerReceiptLinkReused:true,newAccessTokenIssued:false}));
 }
 if(mode==='discover'){
  const orders=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_orders where kind='package' and snapshot->>'templateId'=${state.templateId??''}`);
  if(orders.length!==1)throw new Error('Exactly one actual browser purchase required');state.orderId=orders[0]!.id;await save();console.log(JSON.stringify({discovered:true,orderId:state.orderId}));
 }
 if(mode==='restore'){if(state.previousSettings&&!state.settingsRestored){await command('commerce.saveSettings',state.previousSettings,'restore-settings');state.settingsRestored=true;await save();}console.log(JSON.stringify({restored:true,financialHistoryPreserved:true}));}
 if(mode==='reconcile'){
  if(!state.orderId)throw new Error('Actual browser purchase required');for(let run=0;run<3;run++){
   const response=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${state.orderId}/reconcile`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee.id}});
   if(!response.ok)throw new Error('Actual original purchase reconciliation failed');
  }state.reconcileRuns=(state.reconcileRuns??0)+3;await save();console.log(JSON.stringify({actualSdkReconciliationRuns:state.reconcileRuns}));
 }
 if(mode==='prepare-service'){
  if(!state.orderId||!state.serviceId)throw new Error('Actual paid package required');
  if(!state.ticketId){
   const [order]=await withTenant(tenant,tx=>tx<{customer_id:string}[]>`select customer_id from commerce_orders where id=${state.orderId} and status='fulfilled' and asset_id is not null`);if(!order)throw new Error('Original purchase not fulfilled');
   const [staff]=await withTenant(tenant,tx=>tx<{membership_id:string}[]>`select sp.membership_id from staff_profiles sp join memberships m on m.id=sp.membership_id
    where sp.location_id=${tenant.locationId} and sp.is_bookable and m.status='active' and not exists(select 1 from service_skill_requirements r
      where r.location_id=${tenant.locationId} and r.service_id=${state.serviceId!} and not exists(select 1 from staff_skills s where s.membership_id=m.id and s.skill_id=r.skill_id)) order by sp.membership_id limit 1`);
   if(!staff)throw new Error('Qualified QA staff required');state.staffId=staff.membership_id;await save();
   const ticket=await command<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{customerId:order.customer_id,items:[{serviceId:state.serviceId,membershipId:state.staffId,priceCentsOverride:10000}]},'service-open');state.ticketId=ticket.ticketId;state.itemId=ticket.ticketItemIds[0];await save();
  }
  await command('ticket.startItem',{ticketItemId:state.itemId,membershipId:state.staffId},'service-start');await command('ticket.finishItem',{ticketItemId:state.itemId,membershipId:state.staffId},'service-finish');
  console.log(JSON.stringify({preparedActualService:true,ticketId:state.ticketId,servicePriceCents:10000,newChargeCreated:false}));
 }
 if(mode==='edit-template'){
  if(!state.ticketId||!state.templateId)throw new Error('Prepare the actual service first');
  const [other]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from services where location_id=${tenant.locationId} and active and id<>${state.serviceId!} order by id limit 1`);if(!other)throw new Error('Existing alternate catalog service required');
  await command('package.saveTemplate',{templateId:state.templateId,name:{en:'QA changed future package','zh-Hans':'验收后续变更模板'},priceCents:60000,sessions:12,validDays:30,scope:'org',serviceIds:[other.id],coverageMode:'bundle',commissionBasis:'zero',onlineSale:false,active:true},'template-edit');state.templateEdited=true;await save();
  console.log(JSON.stringify({futureTemplateChanged:true,originalPurchasedRulesNotChanged:true}));
 }
 if(mode==='open-desk'){
  if(!state.ticketId)throw new Error('Prepare the actual service first');
  const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js',r=spawnSync(process.execPath,[cli,'--session','commerce-payout-desk','open',`http://localhost:5297/checkout?ticketId=${state.ticketId}`],{encoding:'utf8'});if(r.status!==0)throw new Error('Owned cashier browser failed');console.log(JSON.stringify({actualCashierOpened:true}));
 }
 if(mode==='verify-unused-refund'){
  if(!state.orderId||!state.ticketId||!state.templateEdited)throw new Error('Actual original purchase/service required');
  const rows=await withTenant(tenant,tx=>tx<{id:string;stripe_refund_id:string;status:string;amount_cents:number;asset_quantity:number;stripe_account_id:string;asset_id:string;purchase_snapshot:unknown;remaining_sessions:number;reserved_sessions:number;refund_frozen:boolean;asset_created_at:Date;expires_at:Date}[]>`select r.*,p.stripe_account_id,o.asset_id,cp.purchase_snapshot,cp.remaining_sessions,cp.reserved_sessions,cp.refund_frozen,cp.created_at as asset_created_at,cp.expires_at from commerce_refunds r join commerce_payments p on p.id=r.payment_id join commerce_orders o on o.id=p.order_id join customer_packages cp on cp.id=o.asset_id where o.id=${state.orderId}`);
  const r=rows[0],original=JSON.parse(await readFile('artifacts/customer-commerce/p2-package-payout-purchase.json','utf8')) as {purchaseSnapshot:unknown};
  if(rows.length!==1||!r||r.status!=='succeeded'||r.amount_cents!==45000||r.asset_quantity!==9||r.remaining_sessions!==0||r.reserved_sessions!==0||r.refund_frozen||JSON.stringify(r.purchase_snapshot)!==JSON.stringify(original.purchaseSnapshot)
   ||new Date(r.expires_at).getTime()-new Date(r.asset_created_at).getTime()!==365*86400000)throw new Error('Wait for the actual unused-package refund, original snapshot and expiry');
  const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const stripe=commerceStripeClient(),options={stripeAccount:r.stripe_account_id};const actual=await stripe.refunds.retrieve(r.stripe_refund_id,{expand:['balance_transaction']},options),bt=actual.balance_transaction&&typeof actual.balance_transaction!=='string'?actual.balance_transaction:null;
  if(actual.status!=='succeeded'||actual.amount!==45000||actual.currency!=='usd'||!bt||bt.amount!==-45000||bt.fee!==0||bt.net!==-45000)throw new Error('Actual unused refund balance mismatch');
  const ledger=await withTenant(tenant,tx=>tx`select entry,quantity,value_cents from customer_package_ledger where package_id=${r.asset_id} order by seq`);
  const [facts]=await withTenant(tenant,tx=>tx`select status,total_cents,refund_cents,(select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as commission_base_cents from tickets t where id=${state.ticketId}`);
  const signed=await withTenant(tenant,tx=>tx`select event_type,count(*)::int as n from commerce_events where object_id=${actual.id} and left(event_id,4)='evt_' and event_type like 'refund.%' group by event_type order by event_type`);
  const [observations]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_events where object_id=${actual.id} and event_id like 'reconcile:%'`);
  if(ledger.length!==3||ledger.filter(l=>l.entry==='purchase_refund'&&l.quantity===-9&&l.value_cents===-45000).length!==1||facts?.status!=='closed'||facts.total_cents!==10000||facts.refund_cents!==0||facts.commission_base_cents!==5000||signed.length<1)throw new Error('Actual refund must retain fulfilled service and retire nine unused units exactly once');
  const report={at:new Date().toISOString(),scope:'Original actual $500 package: one service consumed, nine unused visits refunded for $450',actualStripeSandbox:true,originalOrderId:state.orderId,refundId:r.id,remainingSessions:r.remaining_sessions,assetQuantityRetired:r.asset_quantity,refundCents:actual.amount,status:actual.status,balanceGrossCents:bt.amount,balanceFeeCents:bt.fee,balanceNetCents:bt.net,originalPurchasedSnapshotPreserved:true,originalExpiry:r.expires_at,originalValidityDays:365,originalService:facts,ledger,signedEvents:signed,sdkObservationRows:observations!.n,manualSdkReconciliationRuns:state.reconcileRuns??0,productionChanged:false};
  await writeFile('artifacts/customer-commerce/p2-package-unused-refund-sandbox.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
 if(mode==='verify-consumed'||mode==='verify-restored'){
  if(!state.ticketId||!state.templateEdited)throw new Error('Original service and changed future template required');const restored=mode==='verify-restored';
  const [asset]=await withTenant(tenant,tx=>tx`select cp.id,cp.total_sessions,cp.remaining_sessions,cp.purchase_snapshot,pt.price_cents as current_template_price,pt.sessions as current_template_sessions
    from commerce_orders o join customer_packages cp on cp.id=o.asset_id join package_templates pt on pt.id=cp.template_id where o.id=${state.orderId!}`);
  const original=JSON.parse(await readFile('artifacts/customer-commerce/p2-package-payout-purchase.json','utf8')) as {purchaseSnapshot:unknown};
  if(!asset||JSON.stringify(asset.purchase_snapshot)!==JSON.stringify(original.purchaseSnapshot)||asset.total_sessions!==10||asset.remaining_sessions!==(restored?10:9)||asset.current_template_price!==60000||asset.current_template_sessions!==12)throw new Error('Original package terms/quantity changed');
  const [facts]=await withTenant(tenant,tx=>tx`select t.status,t.subtotal_cents,t.total_cents,t.refund_cents,
    (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id and method in('cash','card','external')) as new_cash_cents,
    (select coalesce(sum(base_cents),0)::int from earnings where ticket_id=t.id and kind='commission') as commission_base_cents
    from tickets t where t.id=${state.ticketId!}`);
  const ledger=await withTenant(tenant,tx=>tx`select entry,quantity,value_cents from customer_package_ledger where package_id=${asset.id} order by created_at,id`);
  if(facts?.status!=='closed'||facts.subtotal_cents!==10000||facts.total_cents!==10000||facts.new_cash_cents!==0||facts.commission_base_cents!==(restored?0:5000)||facts.refund_cents!==(restored?10000:0)
    ||ledger.filter(r=>r.entry==='issue').length!==1||ledger.filter(r=>r.entry==='redeem'&&r.quantity===-1&&r.value_cents===-5000).length!==1||ledger.filter(r=>r.entry==='restore').length!==(restored?1:0))throw new Error('Actual package service/restore financial mismatch');
  const report={at:new Date().toISOString(),scope:restored?'Original package service returned once':'Original online package service consumed after template changes',actualStripeSandboxPurchaseReused:true,ticketId:state.ticketId,asset,facts,ledger,originalPurchaseCashCents:50000,originalPurchaseRefunded:false,productionChanged:false};
  await writeFile(`artifacts/customer-commerce/p2-package-service-${restored?'restored':'consumed'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
 if(mode==='verify-service-partial'||mode==='verify-service-return'){
  if(!state.orderId||!state.ticketId||!state.templateEdited)throw new Error('Existing original online purchase and consumed service required');const complete=mode==='verify-service-return';
  const [fact]=await withTenant(tenant,tx=>tx`select t.status,t.refund_cents,cp.total_sessions,cp.remaining_sessions,cp.reserved_sessions,cp.available_units,cp.purchase_snapshot,
   p.amount_cents as original_paid_cents,p.status as payment_status,(select sum(amount_cents)::int from commerce_refunds where payment_id=p.id and status='succeeded') as original_purchase_refund,
   (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as net_commission,
   (select count(*)::int from ticket_source_receipts where ticket_id=t.id and origin='legacy_projection') as legacy_receipts,
   (select sum(cash_cents+card_cents+customer_credit_cents)::int from ticket_refunds where ticket_id=t.id) as new_money,
   (select count(*)::int from customer_package_ledger where package_id=cp.id and entry='restore') as restores,
   (select sum(quantity)::int from customer_package_ledger where package_id=cp.id) as remaining_ledger_units,
   (select sum(value_cents)::int from customer_package_ledger where package_id=cp.id) as remaining_ledger_value
   from commerce_orders o join commerce_payments p on p.order_id=o.id join customer_packages cp on cp.id=o.asset_id join tickets t on t.id=${state.ticketId} where o.id=${state.orderId}`);
  if(!fact||fact.original_paid_cents!==50000||fact.original_purchase_refund!==45000||fact.payment_status!=='paid'||fact.total_sessions!==10||fact.purchase_snapshot.amountCents!==50000||fact.purchase_snapshot.sessions!==10
   ||fact.status!==(complete?'refunded':'closed')||fact.refund_cents!==(complete?10000:4000)||fact.remaining_sessions!==(complete?1:0)||fact.reserved_sessions!==0||fact.available_units!==(complete?'{[0,1)}':'{}')
   ||fact.new_money!==0||fact.net_commission!==(complete?0:3000)||fact.restores!==(complete?1:0)||fact.remaining_ledger_units!==(complete?1:0)||fact.remaining_ledger_value!==(complete?5000:0)||fact.legacy_receipts!==1)throw new Error('Original service return did not conserve original package funding');
  const sources=await withTenant(tenant,tx=>tx`select s.kind,s.amount_cents,s.funded_value_cents,s.item_ids,(select sum(amount_cents)::int from ticket_source_refunds where source_id=s.id) as returned from ticket_settlement_sources s where ticket_id=${state.ticketId}`);
  if(sources.length!==1||sources[0]!.kind!=='package'||sources[0]!.amount_cents!==10000||sources[0]!.funded_value_cents!==5000||sources[0]!.returned!==fact.refund_cents)throw new Error('Original service source graph mismatch');
  const slices=await withTenant(tenant,tx=>tx`select r.amount_cents,r.tip_cents,r.destination from ticket_source_refunds r join ticket_settlement_sources s on s.id=r.source_id where s.ticket_id=${state.ticketId} order by r.created_at`);
  const report={at:new Date().toISOString(),scope:complete?'Original Stripe-paid package service returned in two parts':'Partial original package service return without fractional quota',actualSandboxPurchaseReused:true,nativeCashier:true,productionChanged:false,ticketId:state.ticketId,facts:fact,sources,slices};
  await writeFile(`artifacts/customer-commerce/p5-package-service-${complete?'returned':'partial'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
 if(mode==='checkout-check'){
  if(!state.orderId)throw new Error('Discover the browser purchase first');
  const [p]=await withTenant(tenant,tx=>tx<{checkout_session_id:string;stripe_account_id:string;livemode:boolean}[]>`select checkout_session_id,stripe_account_id,livemode from commerce_payments where order_id=${state.orderId}`);
  if(!p||p.livemode||!p.checkout_session_id)throw new Error('Actual test Checkout required');const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
  const session=await commerceStripeClient().checkout.sessions.retrieve(p.checkout_session_id,{}, {stripeAccount:p.stripe_account_id});
  if(session.livemode||session.amount_total!==50000||session.currency!=='usd'||session.metadata?.gf_order_id!==state.orderId||session.metadata.gf_domain!=='customer_commerce')throw new Error('Actual Checkout contract mismatch');
  console.log(JSON.stringify({actualCheckoutVerified:true,testMode:true,amountCents:session.amount_total,currency:session.currency,status:session.status,productionChanged:false}));
 }
 if(mode==='verify'){
  if(!state.orderId)throw new Error('Discover the real browser purchase first');
  const [p]=await withTenant(tenant,tx=>tx<{payment_intent_id:string;stripe_account_id:string;balance_transaction_id:string;fee_cents:number;net_cents:number;asset_id:string;status:string;amount_cents:number}[]>`select p.*,o.asset_id from commerce_payments p join commerce_orders o on o.id=p.order_id where o.id=${state.orderId}`);
  if(!p||p.status!=='paid'||p.amount_cents!==50000||!p.asset_id)throw new Error('Wait for genuine payment and package issuance');
  const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const stripe=commerceStripeClient();
  const intent=await stripe.paymentIntents.retrieve(p.payment_intent_id,{expand:['latest_charge.balance_transaction']},{stripeAccount:p.stripe_account_id});
  const charge=intent.latest_charge&&typeof intent.latest_charge!=='string'?intent.latest_charge:null,bt=charge?.balance_transaction&&typeof charge.balance_transaction!=='string'?charge.balance_transaction:null;
  if(intent.livemode||intent.status!=='succeeded'||intent.amount_received!==50000||!bt||bt.id!==p.balance_transaction_id||bt.amount!==50000||bt.fee!==p.fee_cents||bt.net!==p.net_cents){
   console.log(JSON.stringify({settlementDiagnostic:{providerStatus:intent.status,receivedCents:intent.amount_received,balancePresent:!!bt,balanceIdMatches:bt?.id===p.balance_transaction_id,providerGross:bt?.amount,providerFee:bt?.fee,providerNet:bt?.net,storedFee:p.fee_cents,storedNet:p.net_cents}}));throw new Error('Actual settlement mismatch');
  }
  const [asset]=await withTenant(tenant,tx=>tx`select total_sessions,remaining_sessions,purchase_snapshot from customer_packages where id=${p.asset_id}`);
  const [issue]=await withTenant(tenant,tx=>tx`select count(*)::int as rows,sum(quantity)::int as quantity,sum(value_cents)::int as value_cents from customer_package_ledger where package_id=${p.asset_id} and entry='issue'`);
  if(asset?.total_sessions!==10||asset.remaining_sessions!==10||asset.purchase_snapshot.amountCents!==50000||asset.purchase_snapshot.sessions!==10||issue?.rows!==1||issue.quantity!==10||issue.value_cents!==50000)throw new Error('Initial package snapshot/issuance mismatch; preserve historical verification after consumption');
  const [signed]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_events e join commerce_payments p on p.checkout_session_id=e.object_id where p.order_id=${state.orderId} and e.event_type='checkout.session.completed'`);
  if(signed?.n!==1)throw new Error('Genuine signed Checkout callback required');
  const report={at:new Date().toISOString(),scope:'Initial actual $500/10 online package purchase and payout funding',actualStripeSandbox:true,orderId:state.orderId,packageId:p.asset_id,grossCents:bt.amount,feeCents:bt.fee,netCents:bt.net,providerBalanceStatus:bt.status,quantity:10,issueRows:issue.rows,signedCheckoutEvents:signed.n,purchaseSnapshot:asset.purchase_snapshot,productionChanged:false};
  await writeFile('artifacts/customer-commerce/p2-package-payout-purchase.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}catch(e){console.error(JSON.stringify({failed:true,mode,code:(e as {code?:string}).code??'fixture_validation_failed',reason:e instanceof Error?e.message:'unknown'}));process.exitCode=1;}finally{await closeDb();}
