// Exercise the already-paid sandbox Checkout through authenticated service and refund APIs.
// No database monetary writes, card credentials, or real customers are used here.
import {readFile,writeFile} from 'node:fs/promises';
import {commerceStripeClient} from '../apps/api/src/commerce/client';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(!key.startsWith('sk_test_')||process.env.COMMERCE_STRIPE_MODE!=='test'||!process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Explicit test-only Stripe context required');
const original=JSON.parse(await readFile('/tmp/commerce-stripe-checkout-private.json','utf8')) as {orderId:string};
const statePath='/tmp/commerce-stripe-consume-refund-private.json';
type State={orderId:string;staffId?:string;serviceId?:string;ticketId?:string;ticketItemId?:string;refundId?:string};
let state:State;
try{state=JSON.parse(await readFile(statePath,'utf8'));}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state={orderId:original.orderId};}
if(state.orderId!==original.orderId)throw new Error('Resume state belongs to a different order');
const save=()=>writeFile(statePath,JSON.stringify(state),{mode:0o600});
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  const [source]=await withTenant(tenant,tx=>tx`select o.customer_id,o.asset_id,p.id as payment_id,p.amount_cents,p.stripe_account_id,p.livemode,
    p.checkout_session_id,g.face_value_cents from commerce_orders o join commerce_payments p on p.order_id=o.id
    join gift_cards g on g.id=o.asset_id where o.id=${original.orderId} and o.kind='gift_card'`);
  if(!source||source.livemode||source.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID||source.amount_cents!==8000||source.face_value_cents!==10000)throw new Error('Original paid QA purchase required');
  const session=await commerceStripeClient().checkout.sessions.retrieve(source.checkout_session_id,{}, {stripeAccount:source.stripe_account_id});
  if(session.livemode||session.payment_status!=='paid'||session.client_reference_id!==original.orderId||session.metadata?.gf_location_id!==tenant.locationId
    ||session.metadata.gf_domain!=='customer_commerce'||session.amount_total!==8000||session.currency!=='usd')throw new Error('Actual sandbox payment verification failed');
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',
    headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
    body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error(`QA login failed (${auth.status})`);
  const login=await auth.json() as {access_token:string;user:{id:string}};
  const [membership]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${login.user.id} and status='active'`);
  if(!membership)throw new Error('QA operator membership missing');
  const headers={'content-type':'application/json',authorization:`Bearer ${login.access_token}`,'x-membership-id':membership.id};
  const replayedCommands:string[]=[];
  const command=async<T>(name:string,input:unknown):Promise<T>=>{
    const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,
      body:JSON.stringify({input,idempotencyKey:`sandbox-gift-story:${original.orderId}:${name}`})});
    const body=await response.json() as {result:T;replayed?:boolean;code?:string;error?:{code?:string};details?:{reason?:string}};
    if(!response.ok)throw new Error(`QA command ${name}: ${response.status} ${body.code??body.error?.code??'error'} ${body.details?.reason??''}`);
    if(body.replayed)replayedCommands.push(name);
    return body.result;
  };
  if(!state.staffId){
    const [staff]=await withTenant(tenant,tx=>tx`select m.id from memberships m join staff_profiles sp on sp.membership_id=m.id
      where m.location_id=${tenant.locationId} and m.status='active' and sp.is_bookable order by m.id limit 1`);
    if(!staff)throw new Error('QA service staff missing');state.staffId=staff.id;await save();
  }
  const service=await command<{serviceId:string}>('catalog.saveService',{name:{en:'Sandbox gift consumption QA', 'zh-Hans':'沙盒礼品卡消费验收'},
    durationMin:5,basePriceCents:3000,taxable:false,onlineBookable:false});
  state.serviceId=service.serviceId;await save();
  const ticket=await command<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{customerId:source.customer_id,
    items:[{serviceId:state.serviceId,membershipId:state.staffId,priceCentsOverride:3000}]});
  state.ticketId=ticket.ticketId;state.ticketItemId=ticket.ticketItemIds[0];await save();
  await command('ticket.startItem',{ticketItemId:state.ticketItemId,membershipId:state.staffId});
  await command('ticket.finishItem',{ticketItemId:state.ticketItemId,membershipId:state.staffId});
  await command('ticket.pay',{ticketId:state.ticketId,paymentStage:'combined',payments:[{method:'gift_card',giftCardId:source.asset_id,amountCents:3000,tipCents:0}]});
  const [consumption]=await withTenant(tenant,tx=>tx`select t.status,t.subtotal_cents,t.total_cents,
    (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id and method='gift_card') as gift_tender_cents,
    (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id and method in ('cash','card','external')) as new_cash_cents,
    (select coalesce(-sum(amount_cents),0)::int from customer_credit_ledger where ticket_id=t.id and kind='gift_card' and entry='redeem') as redeemed_face_cents,
    (select count(*)::int from customer_credit_ledger where ticket_id=t.id and kind='gift_card' and entry='redeem') as redemption_rows,
    (select coalesce(sum(base_cents),0)::int from earnings where ticket_id=t.id and kind='commission' and reversed_at is null) as commission_base_cents
    from tickets t where t.id=${state.ticketId}`);
  if(consumption?.status!=='closed'||consumption.total_cents!==3000||consumption.gift_tender_cents!==3000
    ||consumption.new_cash_cents!==0||consumption.redeemed_face_cents!==3000||consumption.redemption_rows!==1)throw new Error('Service consumption facts mismatch');
  const refund=await command<{refundId:string;status:string}>('commerce.requestRefund',{paymentId:source.payment_id,amountCents:5600,
    reason:'Sandbox acceptance: refund the unused $70 face value of the original $80-for-$100 purchase'});
  state.refundId=refund.refundId;await save();
  const reconciliation=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${original.orderId}/reconcile`,{method:'POST',headers});
  if(!reconciliation.ok)throw new Error(`Real Stripe reconciliation failed (${reconciliation.status})`);
  const [currentRefund]=await withTenant(tenant,tx=>tx`select status from commerce_refunds where id=${state.refundId}`);
  const report={at:new Date().toISOString(),liveMode:false,orderId:original.orderId,ticketId:state.ticketId,refundId:state.refundId,
    service:consumption,refundRequestedCents:5600,refundStatus:currentRefund?.status,refundRequestResult:refund.status,
    replayedCommands,reconciled:true,originalPurchaseVerified:true,goalComplete:false};
  await writeFile('artifacts/customer-commerce/stripe-gift-consumption.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await closeDb();}
