// Read the actual Stripe Session and corresponding isolated financial facts; never invent a paid status.
import {readFile,writeFile} from 'node:fs/promises';
import {commerceStripeClient} from '../apps/api/src/commerce/client';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');if(url.port!=='58332')throw new Error('Dedicated commerce QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(!key.startsWith('sk_test_')||process.env.COMMERCE_STRIPE_MODE==='live')throw new Error('Test-only Stripe credentials required');
const privateState=JSON.parse(await readFile('/tmp/commerce-stripe-checkout-private.json','utf8')) as {orderId:string};
const {withTenant,closeDb}=await import('../packages/db/src/index');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
try{
  const [p]=await withTenant(tenant,tx=>tx`select * from commerce_payments where order_id=${privateState.orderId}`);
  if(!p?.checkout_session_id||p.livemode||p.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Test payment context mismatch');
  const session=await commerceStripeClient().checkout.sessions.retrieve(p.checkout_session_id,{}, {stripeAccount:p.stripe_account_id});
  if(session.livemode||session.client_reference_id!==privateState.orderId||session.metadata?.gf_domain!=='customer_commerce'
    ||session.metadata.gf_location_id!==tenant.locationId||session.amount_total!==8000||session.currency!=='usd')throw new Error('Verified Checkout context mismatch');
  const [facts]=await withTenant(tenant,tx=>tx`select o.id,o.status as order_status,p.status as payment_status,p.amount_cents,p.currency,p.fee_cents,p.net_cents,
    p.balance_transaction_id,p.payment_intent_id,g.face_value_cents,g.balance_cents,g.reserved_cents,
    (select count(*)::int from customer_credit_ledger where subject_id=g.id and kind='gift_card' and entry='issue') as issue_rows,
    (select count(*)::int from commerce_events where stripe_account_id=p.stripe_account_id and object_id=p.checkout_session_id) as checkout_events
    from commerce_orders o join commerce_payments p on p.order_id=o.id left join gift_cards g on g.id=o.asset_id where o.id=${privateState.orderId}`);
  let story:{orderId:string;refundId?:string;ticketId?:string}|null=null;
  try{story=JSON.parse(await readFile('/tmp/commerce-stripe-consume-refund-private.json','utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(story&&story.orderId!==privateState.orderId)throw new Error('Refund story belongs to another order');
  let refundVerified=false,refundFacts:Record<string,unknown>|null=null;
  if(story?.refundId){
    const [r]=await withTenant(tenant,tx=>tx`select r.id,r.status,r.amount_cents,r.asset_quantity,r.stripe_refund_id,r.balance_transaction_id,
      r.settlement_currency,r.settlement_gross_cents,r.fee_cents,r.net_cents,
      (select count(*)::int from commerce_refunds where payment_id=r.payment_id) as refund_rows,
      (select count(*)::int from customer_credit_ledger l join commerce_orders o on o.asset_id=l.subject_id
        where o.id=${privateState.orderId} and l.entry='adjust' and l.meta->>'refundId'=r.id::text) as asset_refund_rows,
      (select count(*)::int from commerce_events where stripe_account_id=${p.stripe_account_id} and object_id=r.stripe_refund_id
        and event_type like 'refund.%' and event_id like 'evt_%') as signed_refund_events,
      (select count(*)::int from command_idempotency where location_id=${tenant.locationId} and command='commerce.completeRefund'
        and key like ${`commerce-event:${p.stripe_account_id}:evt_%`} and result_json->>'refundId'=r.id::text) as signed_refund_command_receipts
      from commerce_refunds r where r.id=${story.refundId} and r.payment_id=${p.id}`);
    if(!r)throw new Error('Requested refund missing');
    refundFacts={...r};
    if(r.stripe_refund_id){
      const provider=await commerceStripeClient().refunds.retrieve(r.stripe_refund_id,{}, {stripeAccount:p.stripe_account_id});
      const intent=typeof provider.payment_intent==='string'?provider.payment_intent:provider.payment_intent?.id;
      if(intent!==p.payment_intent_id||provider.amount!==5600||provider.currency!=='usd'||r.amount_cents!==5600||r.asset_quantity!==7000)throw new Error('Actual refund context mismatch');
      refundFacts={...refundFacts,providerStatus:provider.status,providerAmountCents:provider.amount,originalPaymentIntentVerified:true};
      refundVerified=provider.status==='succeeded'&&r.status==='succeeded';
      if(refundVerified&&(r.refund_rows!==1||r.asset_refund_rows!==1||facts?.balance_cents!==0||facts.reserved_cents!==0||facts.issue_rows!==1))throw new Error('Refund financial conservation mismatch');
    }
  }
  const report={at:new Date().toISOString(),stripeVerified:true,liveMode:false,accountId:p.stripe_account_id,orderId:privateState.orderId,
    checkoutCreated:true,sessionStatus:session.status,paymentStatus:session.payment_status,checkoutPaid:session.payment_status==='paid',facts,
    refundVerified,refundFacts,goalComplete:false};
  await writeFile('artifacts/customer-commerce/stripe-checkout.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await closeDb();}
