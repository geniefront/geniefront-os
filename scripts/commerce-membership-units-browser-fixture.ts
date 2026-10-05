// Preserved local QA: real paid membership, authenticated service commands and actual cashier UI.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const url=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='58332')throw new Error('Preserved local QA only');
 url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';process.env.BOOKING_BASE_URL='http://localhost:5296';assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local test environment required');
const discountFamily=process.argv.includes('--discount');
const mode=process.argv[2],stage=process.argv[3],path=discountFamily?'/tmp/commerce-membership-discount-units-private.json':'/tmp/commerce-membership-units-private.json';
if(!['prepare','open-desk','open-member','verify','verify-security'].includes(mode??''))throw new Error('Expected prepare|open-desk|open-member|verify consumed|restored|verify-security');
const purchase=JSON.parse(await readFile(discountFamily?'/tmp/commerce-membership-discount-browser-private.json':'/tmp/commerce-membership-browser-private.json','utf8')) as {membershipId:string;orderId:string};
type State={key:string;ticketId?:string;itemId?:string;itemIds?:string[];staffId?:string;cycleId?:string};let state:State;
try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
const browser='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
function cli(session:string,args:string[]){const r=spawnSync(process.execPath,[browser,'--session',session,...args],{encoding:'utf8'});if(r.status!==0)throw new Error('Owned browser command failed');}
try{
 const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
  body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
 if(!auth.ok)throw new Error('Existing local owner login failed');const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
 const [employee]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
 if(!employee)throw new Error('Existing owner membership required');
 const headers={authorization:`Bearer ${login.access_token}`,'x-membership-id':employee.id,'content-type':'application/json'};
 async function command<T>(name:string,input:unknown,suffix=''){const r=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,body:JSON.stringify({input,idempotencyKey:`membership-units:${state.key}:${name}${suffix?':'+suffix:''}`})});
  const data=await r.json() as {result:T;code?:string;details?:{reason?:string}};if(!r.ok)throw new Error(`QA ${name} ${r.status} ${data.code??''} ${data.details?.reason??''}`);return data.result;}
 const [m]=await withTenant(tenant,tx=>tx<{customer_id:string;snapshot:{terms:{serviceIds:string[]}}}[]>`select customer_id,snapshot from customer_paid_memberships where id=${purchase.membershipId}`);
 if(!m)throw new Error('Preserved paid membership required');
 if(mode==='prepare'){
  if(!state.ticketId){
   const [cycle]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from customer_membership_cycles where membership_id=${purchase.membershipId}
    and status='issued' and starts_at<=now() and ends_at>now() and available_units='{[0,1)}'::int4multirange`);
   if(!cycle)throw new Error('One original valid paid unit required');state.cycleId=cycle.id;
   const serviceId=m.snapshot.terms.serviceIds[0]!;
   const [staff]=await withTenant(tenant,tx=>tx<{membership_id:string}[]>`select sp.membership_id from staff_profiles sp join memberships m on m.id=sp.membership_id
    where sp.location_id=${tenant.locationId} and sp.is_bookable and m.status='active' and not exists(select 1 from service_skill_requirements r
      where r.location_id=${tenant.locationId} and r.service_id=${serviceId} and not exists(select 1 from staff_skills s where s.membership_id=m.id and s.skill_id=r.skill_id))
    order by sp.membership_id limit 1`);
   if(!staff)throw new Error('Qualified existing QA staff required');state.staffId=staff.membership_id;await save();
   const t=await command<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{customerId:m.customer_id,items:(discountFamily?[10000,5000,4000]:[10000]).map(price=>({serviceId,membershipId:state.staffId,priceCentsOverride:price}))});
   state.ticketId=t.ticketId;state.itemId=t.ticketItemIds[0]!;if(discountFamily)state.itemIds=t.ticketItemIds;await save();
  }
  if(discountFamily){for(const id of state.itemIds??[]){await command('ticket.startItem',{ticketItemId:id,membershipId:state.staffId},id);await command('ticket.finishItem',{ticketItemId:id,membershipId:state.staffId},id);}}
  else{await command('ticket.startItem',{ticketItemId:state.itemId,membershipId:state.staffId});await command('ticket.finishItem',{ticketItemId:state.itemId,membershipId:state.staffId});}
  console.log(JSON.stringify({prepared:true,ticketId:state.ticketId,cycleId:state.cycleId,newStripeCharge:false,productionChanged:false}));
 }
 if(mode==='open-desk'){
  if(!state.ticketId)throw new Error('Prepare the service first');
  const authPath='/tmp/commerce-desk-auth.json',saved=JSON.parse(await readFile(authPath,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
  const origin=saved.origins.find(o=>o.origin==='http://localhost:5297'),token=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
  if(!origin||!token)throw new Error('Owned auth storage missing');token.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
  await writeFile(authPath,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(authPath,0o600);
  cli(discountFamily?'commerce-member-discount-desk':'commerce-member-units-desk',['state','load',authPath]);cli(discountFamily?'commerce-member-discount-desk':'commerce-member-units-desk',['open',`http://localhost:5297/checkout?ticketId=${state.ticketId}`]);
  console.log(JSON.stringify({deskOpened:true,credentialsPrinted:false}));
 }
 if(mode==='open-member'){
  const {membershipManageUrl}=await import('../apps/api/src/commerce/customerMembership'),{workerContext}=await import('../apps/api/src/commerce/worker');
  cli(discountFamily?'commerce-member-discount-customer':'commerce-member-units-customer',['open',await membershipManageUrl(workerContext(tenant.orgId,tenant.locationId),purchase.membershipId)]);
  console.log(JSON.stringify({memberOpened:true,privateUrlPrinted:false}));
 }
 if(mode==='verify'){
  if(!state.ticketId||!['consumed','restored'].includes(stage??''))throw new Error('Expected consumed|restored verification');
  const [facts]=await withTenant(tenant,tx=>tx`select t.status,t.total_cents,t.refund_cents,
   (select available_units::text from customer_membership_cycles where id=${state.cycleId!}) as available_units,
   (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id) as new_payment_cents,
   (select sum(covered_cents)::int from customer_membership_ledger where ticket_id=t.id and entry='redeem') as coverage,
   (select sum(value_cents)::int from customer_membership_ledger where ticket_id=t.id and entry='redeem') as funded_value,
   (select count(*)::int from customer_membership_ledger where ticket_id=t.id and entry='redeem') as redemptions,
   (select count(*)::int from customer_membership_ledger where ticket_id=t.id and entry='restore') as restorations,
   (select coalesce(sum(membership_cents),0)::int from ticket_refunds where ticket_id=t.id) as membership_return,
   (select coalesce(sum(cash_cents+card_cents+gift_card_cents+customer_credit_cents+deposit_cents),0)::int from ticket_refunds where ticket_id=t.id) as money_return,
   (select coalesce(sum(base_cents),0)::int from earnings where ticket_id=t.id and kind='commission' and not coalesce((basis->>'refund')::boolean,false)) as original_commission_base,
   (select count(*)::int from customer_membership_invoices where membership_id=${purchase.membershipId}) as paid_invoices,
   (select sum(p.amount_cents)::int from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=${purchase.membershipId}) as cash_cents
   from tickets t where t.id=${state.ticketId}`);
  const restored=stage==='restored';
  if(!facts||facts.total_cents!==(discountFamily?18500:10000)||facts.new_payment_cents!==(discountFamily?8500:0)||facts.coverage!==10000||facts.funded_value!==-(discountFamily?4900:9900)||facts.redemptions!==1
   ||facts.original_commission_base!==(discountFamily?12400:9900)||facts.paid_invoices!==(discountFamily?1:3)||facts.cash_cents!==(discountFamily?4900:29700)||facts.money_return!==(discountFamily&&restored?8500:0)
   ||facts.status!==(restored?'refunded':'closed')||facts.available_units!==(restored?'{[0,1)}':'{}')||facts.restorations!==(restored?1:0)
   ||facts.membership_return!==(restored?10000:0))throw new Error('Actual membership service financial facts mismatch');
  const report={at:new Date().toISOString(),scope:'P4 actual browser service of the original Stripe-paid membership',stage,membershipId:purchase.membershipId,ticketId:state.ticketId,
   originalPurchaseAndRenewalsVerified:!discountFamily,originalPurchaseVerified:true,facts,newStripeCharge:false,productionPublished:false,realEmailSent:false,goalComplete:false};
  await writeFile(`artifacts/customer-commerce/browser-membership-${discountFamily?'discount-units':'units'}-${stage}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
 if(mode==='verify-security'){
  const tables=await withTenant(tenant,tx=>tx`select c.relname,c.relrowsecurity,c.relforcerowsecurity,
   has_table_privilege('app_user',c.oid,'SELECT') as app_select,has_table_privilege('app_user',c.oid,'INSERT') as app_insert,
   has_table_privilege('app_user',c.oid,'UPDATE') as app_update,has_table_privilege('app_user',c.oid,'DELETE') as app_delete,
   has_table_privilege('app_user',c.oid,'TRUNCATE') as app_truncate,
   has_table_privilege('anon',c.oid,'SELECT') as anon_select,has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname=any(${['customer_membership_ledger','customer_membership_service_refunds',...(discountFamily?['ticket_price_adjustments']:[])]}::text[]) order by c.relname`);
  const [helper]=await withTenant(tenant,tx=>tx`select p.prosecdef,
   has_function_privilege('app_user',p.oid,'EXECUTE') as app_execute,
   has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
   has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commerce_internal' and p.proname='membership_range_value'`);
  const [foreignScope]=await withTenant({orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null},tx=>tx`select
   (select count(*)::int from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${purchase.membershipId}) as ledger_rows,
   (select count(*)::int from customer_membership_service_refunds r join customer_membership_ledger l on l.id=r.redemption_id join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${purchase.membershipId}) as refund_rows`);
  const [current]=await withTenant(tenant,tx=>tx`select current_user as role,
   (select count(*)::int from customer_membership_ledger where ticket_id=${state.ticketId!} and entry='redeem') as redemptions,
   (select count(*)::int from customer_membership_ledger where ticket_id=${state.ticketId!} and entry='restore') as restorations,
   (select count(*)::int from customer_membership_service_refunds r join customer_membership_ledger l on l.id=r.redemption_id where l.ticket_id=${state.ticketId!}) as return_allocations,
   (select ends_at from customer_membership_cycles where id=${state.cycleId!}) as original_cycle_ends_at`);
  const report={at:new Date().toISOString(),scope:'Preserved local paid-membership read-only security verification',tables,helper,foreignScope,current,
   businessRowsMutated:false,productionPublished:false,goalComplete:false};
  if(tables.length!==(discountFamily?3:2)||tables.some(t=>!t.relrowsecurity||!t.relforcerowsecurity||!t.app_select||!t.app_insert||t.app_update||t.app_delete||t.app_truncate||t.anon_select||t.authenticated_select)
   ||!helper||helper.prosecdef||!helper.app_execute||helper.anon_execute||helper.authenticated_execute
   ||foreignScope?.ledger_rows!==0||foreignScope?.refund_rows!==0||current?.role!=='app_user'
   ||current.redemptions!==1||current.restorations!==1||current.return_allocations!==1){console.error(JSON.stringify(report));throw new Error('Actual membership security or immutable row counts mismatch');}
  if(discountFamily){
   const prices=await withTenant(tenant,tx=>tx`select kind,original_cents,discount_cents,cycle_id,plan_version_id,rule_snapshot
    from ticket_price_adjustments where ticket_id=${state.ticketId!} order by kind`);
   const [financial]=await withTenant(tenant,tx=>tx`select t.subtotal_cents,t.discount_cents,t.total_cents,t.tip_cents,t.refund_cents,
    (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as remaining_commission_base,
    (select sum(amount_cents)::int from earnings where ticket_id=t.id and kind in('tip_cash','tip_card')) as remaining_tip_earnings,
    (select coalesce(sum(membership_cents),0)::int from ticket_refunds where ticket_id=t.id) as returned_membership,
    (select coalesce(sum(cash_cents),0)::int from ticket_refunds where ticket_id=t.id) as returned_cash from tickets t where t.id=${state.ticketId!}`);
   const [foreignPrices]=await withTenant({orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null},tx=>tx`select count(*)::int as n from ticket_price_adjustments where ticket_id=${state.ticketId!}`);
   if(prices.length!==2||prices[0]?.kind!=='manual'||prices[0].discount_cents!==1000||prices[0].original_cents!==4000
    ||prices[1]?.kind!=='membership'||prices[1].discount_cents!==500||prices[1].original_cents!==5000||prices[1].cycle_id!==state.cycleId
    ||financial?.subtotal_cents!==19000||financial.discount_cents!==1500||financial.total_cents!==18500||financial.tip_cents!==1000
    ||financial.refund_cents!==18500||financial.remaining_commission_base!==0||financial.remaining_tip_earnings!==0
    ||financial.returned_membership!==10000||financial.returned_cash!==8500||foreignPrices?.n!==0)throw new Error('Actual immutable member price and original refund facts mismatch');
   const previous=[];
   for(const [file,invoices,cash,cycles] of [['/tmp/commerce-membership-browser-private.json',3,29700,3],['/tmp/commerce-membership-year-browser-private.json',2,199800,24]] as const){
    const old=JSON.parse(await readFile(file,'utf8')) as {membershipId:string};
    const [preserved]=await withTenant(tenant,tx=>tx`select
     (select count(*)::int from customer_membership_invoices where membership_id=${old.membershipId}) as invoices,
     (select sum(p.amount_cents)::int from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id where i.membership_id=${old.membershipId}) as cash,
     (select count(*)::int from customer_membership_cycles where membership_id=${old.membershipId}) as cycles`);
    if(preserved?.invoices!==invoices||preserved.cash!==cash||preserved.cycles!==cycles)throw new Error('Previous original monthly or annual membership payment facts changed');previous.push(preserved);
   }
   await writeFile('artifacts/customer-commerce/p4-discount-prior-payments-preserved.json',JSON.stringify({at:new Date().toISOString(),previous,businessRowsMutated:false,productionPublished:false},null,2)+'\n');
   await writeFile('artifacts/customer-commerce/p4-discount-price-facts.json',JSON.stringify({at:new Date().toISOString(),prices,financial,foreignPriceRows:foreignPrices.n,
    scope:'Read-only actual browser paid membership prices and service refunds',offlineCashOnlyQaRecording:true,originalMembershipPurchaseRefunded:false,productionPublished:false,goalComplete:false},null,2)+'\n');
  }
  await writeFile(discountFamily?'artifacts/customer-commerce/p4-discount-service-security.json':'artifacts/customer-commerce/p4-units-security.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}catch(error){console.error(JSON.stringify({membershipServiceFixtureFailed:true,reason:error instanceof Error?error.message:'fixture_failed'}));process.exitCode=1;}
finally{await closeDb();}
