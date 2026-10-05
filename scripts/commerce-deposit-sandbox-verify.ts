// Read actual Stripe facts and the browser-created isolated reservation. Never creates a payment fact or edits booking time.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {commerceStripeClient} from '../apps/api/src/commerce/client';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!key.startsWith('sk_test_')||!process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Explicit test Stripe context required');
const path='/tmp/commerce-deposit-sandbox-private.json',state=JSON.parse(await readFile(path,'utf8')) as {serviceId:string;preparedAt:string;orderId?:string;holdId?:string;appointmentId?:string;ticketId?:string;purchaseRefundId?:string};
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  const rows=await withTenant(tenant,tx=>tx`select h.id,h.order_id,h.appointment_id from commerce_appointment_holds h
    where h.location_id=${tenant.locationId} and h.created_at>=${state.preparedAt}::timestamptz
      and exists(select 1 from appointment_items i where i.appointment_id=h.appointment_id and i.service_id=${state.serviceId})`);
  if(rows.length!==1)throw new Error(`Expected one browser-created QA deposit hold, found ${rows.length}`);
  const h=rows[0]!;
  if(state.orderId&&state.orderId!==h.order_id)throw new Error('Deposit story changed its original order');
  Object.assign(state,{orderId:h.order_id,holdId:h.id,appointmentId:h.appointment_id});
  await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);
  const [payment]=await withTenant(tenant,tx=>tx`select * from commerce_payments where order_id=${h.order_id}`);
  if(!payment?.checkout_session_id||payment.livemode||payment.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID||payment.amount_cents!==2000)throw new Error('Actual deposit Checkout context missing');
  const session=await commerceStripeClient().checkout.sessions.retrieve(payment.checkout_session_id,{}, {stripeAccount:payment.stripe_account_id});
  if(session.livemode||session.client_reference_id!==h.order_id||session.metadata?.gf_domain!=='customer_commerce'||session.metadata.gf_org_id!==tenant.orgId
    ||session.metadata.gf_location_id!==tenant.locationId||session.amount_total!==2000||session.currency!=='usd')throw new Error('Deposit provider context mismatch');
  const [facts]=await withTenant(tenant,tx=>tx`select h.status as hold_status,h.amount_cents,h.service_total_cents,h.reserved_cents,h.expires_at::text,
    h.expires_at>now() as hold_unexpired,h.policy_snapshot,a.status as appointment_status,a.deposit_status,a.business_date::text,loc.timezone,
    o.status as order_status,p.status as payment_status,p.fee_cents,p.net_cents,p.balance_transaction_id,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collection_rows,
    (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as available_cents,
    (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_id like 'evt_%' and event_type='checkout.session.completed') as signed_checkout_events,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm') as guest_confirmation_rows
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id join commerce_orders o on o.id=h.order_id
    join commerce_payments p on p.order_id=o.id join locations loc on loc.id=h.location_id where h.id=${h.id}`);
  if(facts?.amount_cents!==2000||facts.service_total_cents!==10000||facts.policy_snapshot.consent?.accepted!==true
    ||facts.policy_snapshot.method!=='percentage'||facts.policy_snapshot.percentBps!==2000)throw new Error('Purchased deposit quote/consent mismatch');
  const paid=session.payment_status==='paid';
  const confirmed=paid&&facts.payment_status==='paid'&&facts.order_status==='fulfilled'&&facts.hold_status==='paid'
    &&facts.deposit_status==='paid'&&facts.appointment_status==='booked'&&facts.collection_rows===1;
  if(!paid&&(facts.collection_rows!==0||facts.guest_confirmation_rows!==0))throw new Error('Unpaid deposit generated a collection or confirmation');
  const [service]=state.ticketId?await withTenant(tenant,tx=>tx`select t.status,t.business_date::text,t.subtotal_cents,t.discount_cents,t.total_cents,
    (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id and method='cash') as cash_cents,
    (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id and method='deposit') as deposit_cents,
    (select count(*)::int from commerce_deposit_ledger where hold_id=${h.id} and ticket_id=t.id and entry='applied') as application_rows,
    (select coalesce(sum(base_cents) filter(where base_cents>0),0)::int from earnings where ticket_id=t.id and kind='commission' and reversed_at is null) as original_commission_base_cents,
    (select coalesce(sum(base_cents),0)::int from earnings where ticket_id=t.id and kind='commission' and reversed_at is null) as commission_base_cents
    from tickets t where t.id=${state.ticketId} and t.appointment_id=${h.appointment_id}`):[];
  const consumed=service?.status==='closed'&&service.subtotal_cents===10000&&service.discount_cents===0&&service.total_cents===10000
    &&service.cash_cents===8000&&service.deposit_cents===2000&&service.application_rows===1&&service.original_commission_base_cents===10000;
  if(service?.status==='closed'&&!consumed)throw new Error('Service cash/deposit/commission facts mismatch');
  let refundVerified=false,refundFacts:Record<string,unknown>|null=null;
  if(state.purchaseRefundId){
    const [r]=await withTenant(tenant,tx=>tx`select r.id,r.status,r.amount_cents,r.stripe_refund_id,r.balance_transaction_id,r.settlement_currency,
      r.settlement_gross_cents,r.fee_cents,r.net_cents,
      (select count(*)::int from ticket_refunds where ticket_id=${state.ticketId!}) as service_refund_rows,
      (select sum(cash_cents)::int from ticket_refunds where ticket_id=${state.ticketId!}) as cash_refund_recorded_cents,
      (select sum(deposit_cents)::int from ticket_refunds where ticket_id=${state.ticketId!}) as deposit_restored_cents,
      (select count(*)::int from commerce_deposit_ledger where hold_id=${h.id} and entry='restored') as restoration_rows,
      (select count(*)::int from commerce_deposit_ledger where hold_id=${h.id} and entry='refund') as purchase_refund_rows,
      (select count(*)::int from commerce_events where object_id=r.stripe_refund_id and event_id like 'evt_%' and event_type like 'refund.%') as signed_refund_events
      from commerce_refunds r where r.id=${state.purchaseRefundId} and r.payment_id=${payment.id}`);
    if(!r)throw new Error('Original deposit refund request missing');refundFacts={...r};
    if(r.stripe_refund_id){
      const provider=await commerceStripeClient().refunds.retrieve(r.stripe_refund_id,{}, {stripeAccount:payment.stripe_account_id});
      const intent=typeof provider.payment_intent==='string'?provider.payment_intent:provider.payment_intent?.id;
      if(intent!==payment.payment_intent_id||provider.amount!==400||provider.currency!=='usd'||r.amount_cents!==400)throw new Error('Original deposit refund context mismatch');
      refundVerified=provider.status==='succeeded'&&r.status==='succeeded';refundFacts={...refundFacts,providerStatus:provider.status,providerAmountCents:provider.amount};
      if(refundVerified&&(r.service_refund_rows!==1||r.cash_refund_recorded_cents!==1600||r.deposit_restored_cents!==400
        ||r.restoration_rows!==1||r.purchase_refund_rows!==1||facts.available_cents!==0||facts.reserved_cents!==0||service?.commission_base_cents!==8000))
        throw new Error('Service restoration and original deposit refund do not conserve value');
    }
  }
  const report={at:new Date().toISOString(),liveMode:false,accountId:payment.stripe_account_id,orderId:h.order_id,holdId:h.id,appointmentId:h.appointment_id,
    stripeVerified:true,sessionStatus:session.status,paymentStatus:session.payment_status,checkoutPaid:paid,bookingConfirmed:confirmed,facts,
    serviceConsumptionVerified:consumed,service:service??null,refundVerified,refundFacts,goalComplete:false};
  const artifact=refundVerified?'stripe-deposit-refunded.json':consumed?'stripe-deposit-service.json':paid?'stripe-deposit-confirmed.json':'stripe-deposit-pending.json';
  await writeFile(`artifacts/customer-commerce/${artifact}`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await closeDb();}
