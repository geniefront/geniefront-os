// Reuse the original Stripe-funded remaining package unit; never mint a replacement purchase.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {TicketPay} from '../packages/contracts/src/index';
import {commerceFingerprint} from '../packages/payroll/src/commerce';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332')throw new Error('Dedicated preserved QA database required');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!(process.env.COMMERCE_STRIPE_SECRET_KEY||process.env.STRIPE_SECRET_KEY||'').startsWith('sk_test_')||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local authentication and explicit sandbox required');
const mode=process.argv[2];if(!['prepare','pay','verify-paid','verify-package','verify-partial','verify-final','verify-quote','verify-quote-return','verify-replay'].includes(mode??''))throw new Error('Unknown mode');
const original=JSON.parse(await readFile('/tmp/commerce-package-payout-private.json','utf8')) as {orderId:string;serviceId:string;staffId:string};
const scenario=process.argv[3]??'items';if(!['items','quote','quote-retry','queue'].includes(scenario))throw new Error('Unknown fixture scenario');
const path=scenario==='items'?'/tmp/commerce-item-return-private.json':`/tmp/commerce-checkout-${scenario}-private.json`;type State={key:string;ticketId?:string;itemIds?:string[]};let state:State;
try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
const {withTenant,closeDb}=await import('../packages/db/src/index');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
try{
 const [order]=await withTenant(tenant,tx=>tx`select o.customer_id,o.asset_id,cp.remaining_sessions,cp.available_units,cp.purchase_snapshot,p.amount_cents,
  (select sum(amount_cents)::int from commerce_refunds where payment_id=p.id and status='succeeded') as purchase_refund,
  (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_type='checkout.session.completed' and left(event_id,4)='evt_') as signed_purchase
  from commerce_orders o join commerce_payments p on p.order_id=o.id join customer_packages cp on cp.id=o.asset_id where o.id=${original.orderId}`);
 if(!order||order.amount_cents!==50000||order.purchase_refund!==45000||order.purchase_snapshot.sessions!==10||order.signed_purchase!==1)throw new Error('Original actual Stripe purchase and refund must be preserved');
 if(mode==='prepare'||mode==='pay'||mode==='verify-quote'){
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error('Existing local owner login required');const login=await auth.json() as {access_token:string;user:{id:string}};
  const [employee]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!employee)throw new Error('Owner membership required');
  async function command<T>(name:string,input:unknown,suffix:string):Promise<T>{const r=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':employee!.id,'content-type':'application/json'},body:JSON.stringify({input,idempotencyKey:`item-return:${state.key}:${suffix}`})});const out=await r.json() as {result:T;code?:string;details?:unknown};if(!r.ok)throw new Error(`QA command ${name}: ${r.status} ${out.code??''} ${JSON.stringify(out.details??{})}`);return out.result;}
  if(mode==='prepare'){
   if(!state.ticketId){if(order.remaining_sessions!==1||order.available_units!=='{[0,1)}')throw new Error('Exactly the original returned unit is required');await save();
    const ticket=await command<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{customerId:order.customer_id,items:[10000,20000].map(price=>({serviceId:original.serviceId,membershipId:original.staffId,priceCentsOverride:price}))},'open');state.ticketId=ticket.ticketId;state.itemIds=ticket.ticketItemIds;await save();}
   for(const [index,id] of state.itemIds!.entries()){await command('ticket.startItem',{ticketItemId:id,membershipId:original.staffId},`start-${index}`);await command('ticket.finishItem',{ticketItemId:id,membershipId:original.staffId},`finish-${index}`);}
   console.log(JSON.stringify({prepared:true,ticketId:state.ticketId,items:state.itemIds,originalStripePurchaseReused:true,newPurchase:false}));
  }else if(mode==='pay'){if(!state.ticketId)throw new Error('Prepare first');await command('ticket.pay',{ticketId:state.ticketId,packageRedemptions:[{customerPackageId:order.asset_id,units:1}],payments:[{method:'cash',amountCents:21000,tipCents:1000}]},'pay');console.log(JSON.stringify({paid:true,ticketId:state.ticketId,offlineQaCashCents:21000,realStripeChargeCreated:false}));}
  else{
   if(!state.ticketId)throw new Error('Prepare first');
   const facts=()=>withTenant(tenant,tx=>tx`select cp.remaining_sessions,cp.available_units,(select count(*)::int from customer_package_ledger where package_id=cp.id) as ledger,(select count(*)::int from payments where ticket_id=${state.ticketId!}) as payments,(select count(*)::int from ticket_price_adjustments where ticket_id=${state.ticketId!}) as adjustments from customer_packages cp where cp.id=${order.asset_id}`);
   const before=await facts(),input={ticketId:state.ticketId,packageRedemptions:[{customerPackageId:order.asset_id,units:1}],tipCents:1000};
   const one=await command<{quoteHash:string;amountDueCents:number}>('ticket.quoteCheckout',input,'quote-one'),two=await command<{quoteHash:string}>('ticket.quoteCheckout',input,'quote-two');
   const after=await facts();if(JSON.stringify(before)!==JSON.stringify(after)||one.quoteHash!==two.quoteHash||one.amountDueCents!==21000)throw new Error('Real repeated quotes mutated financial state or disagreed');
   const report={at:new Date().toISOString(),scenario,ticketId:state.ticketId,actualOriginalSandboxPurchaseReused:true,financialFactsUnchanged:true,newStripePayment:false,before,after,quote:one,productionChanged:false};
   await writeFile(`artifacts/customer-commerce/p5-checkout-${scenario}-readonly.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }
 }else if(mode==='verify-replay'){
  if(scenario!=='quote-retry'||!state.ticketId)throw new Error('Actual quote-retry scenario required');
  const attempt=JSON.parse(await readFile('/tmp/commerce-checkout-quote-retry-attempt.json','utf8'));
  const expected=createHash('sha256').update(commerceFingerprint(TicketPay.input.parse(attempt.requestInput))).digest('hex');
  const [receipt]=await withTenant(tenant,tx=>tx`select input_fingerprint from command_idempotency where location_id=${tenant.locationId} and command='ticket.pay' and key=${attempt.key}`);
  const [counts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from payments where ticket_id=${state.ticketId!}) as payments,(select count(*)::int from customer_package_ledger where ticket_id=${state.ticketId!} and entry='redeem') as redemptions,(select count(*)::int from ticket_item_graph_receipts where ticket_id=${state.ticketId!}) as item_receipts,(select count(*)::int from audit_log where entity_id=${state.ticketId!} and command='ticket.pay' and after->>'checkoutQuoteHash'=${attempt.requestInput.expectedQuoteHash}) as payment_audits`);
  if(receipt?.input_fingerprint!==expected||commerceFingerprint(TicketPay.input.parse(attempt.saved.input))!==commerceFingerprint(TicketPay.input.parse(attempt.requestInput))||counts?.payments!==1||counts.redemptions!==1||counts.item_receipts!==1||counts.payment_audits!==1||!attempt.replay?.replayed||attempt.replay.httpStatus!==200)throw new Error('Original canonical payment replay or exactly-once financial records mismatch');
  const report={at:new Date().toISOString(),ticketId:state.ticketId,originalCanonicalRequestAndQuotePreserved:true,replayed:true,counts,productionChanged:false};await writeFile('artifacts/customer-commerce/p5-checkout-quote-replay-ledger.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }else{
  if(!state.ticketId)throw new Error('Prepare first');
  const [facts]=await withTenant(tenant,tx=>tx`select t.status,t.total_cents,t.refund_cents,t.settlement_tax_mode,
   (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as commission_base,
   (select sum(amount_cents)::int from tip_allocations where ticket_id=t.id) as tips,
   (select coalesce(sum(cash_cents),0)::int from ticket_refunds where ticket_id=t.id) as cash_return,
   (select count(*)::int from ticket_refunds where ticket_id=t.id) as refunds,
   (select count(*)::int from ticket_item_graph_receipts where ticket_id=t.id) as item_receipts,
   (select count(*)::int from customer_package_ledger where ticket_id=t.id and entry='restore') as unit_restores
   from tickets t where t.id=${state.ticketId}`);
  const expected=mode==='verify-paid'?[0,25000,1000,0,0,0]:mode==='verify-package'?[10000,20000,1000,0,1,1]:mode==='verify-partial'?[18000,12000,1000,8000,1,2]:mode==='verify-quote-return'?[31000,0,0,21000,1,1]:[31000,0,0,21000,1,3];
  if(!facts||facts.total_cents!==31000||facts.item_receipts!==1||facts.refund_cents!==expected[0]||facts.commission_base!==expected[1]||facts.tips!==expected[2]||facts.cash_return!==expected[3]||order.remaining_sessions!==expected[4]||facts.refunds!==expected[5]||facts.unit_restores!==(mode==='verify-paid'?0:1))throw new Error(`Original item return mismatch: ${JSON.stringify(facts)}`);
  const sources=await withTenant(tenant,tx=>tx`select s.kind,i.seq,a.service_cents,a.tax_cents,a.fee_cents,coalesce((select sum(service_cents)::int from ticket_item_source_returns where allocation_id=a.id),0) as returned_service from ticket_item_source_allocations a join ticket_settlement_sources s on s.id=a.source_id join ticket_items i on i.id=a.ticket_item_id where s.ticket_id=${state.ticketId} order by i.seq,s.kind`);
  const report={at:new Date().toISOString(),scope:mode,actualStripePurchaseReused:true,originalOrderId:original.orderId,ticketId:state.ticketId,originalPaidCents:50000,originalPurchaseRefundCents:45000,newCashIsOfflineQa:true,newStripePayment:false,remainingOriginalUnits:order.remaining_sessions,availableUnits:order.available_units,facts,sources,productionChanged:false};
  await writeFile(`artifacts/customer-commerce/p5-${scenario==='items'?'item':`checkout-${scenario}`}-${mode}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}finally{await closeDb();}
