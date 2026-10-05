// Read-only audit of the native deposit adjustment, service return and Stripe sandbox refunds.
import {readFile,writeFile} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332'||process.env.DATABASE_TEST_TARGET!=='isolated')throw new Error('Dedicated QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
assertRegressionTarget(process.env);if(process.env.COMMERCE_STRIPE_MODE!=='test')throw new Error('Stripe sandbox required');
const state=JSON.parse(await readFile('/tmp/commerce-adjustment-private.json','utf8')),previous=JSON.parse(await readFile('/tmp/commerce-pending-reschedule-private.json','utf8'));
const {withTenant,closeDb}=await import('../packages/db/src/index');const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
try{
 const [old17]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash from commerce_payments p where id=any(${previous.before.ids}::uuid[])`);
 if(old17!.count!==17||old17!.hash!==previous.before.hash)throw new Error('Unrelated payment history changed');
 const [current]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash from commerce_payments p`);
 if(current!.count!==19)throw new Error('Unexpected payments');
 const [contract]=await withTenant(tenant,tx=>tx`select h.amount_cents,h.service_total_cents,h.policy_snapshot,h.expires_at::text,h.order_id,o.snapshot from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id where h.id=${state.holdId}`);
 if(JSON.stringify(contract)!==JSON.stringify(previous.original))throw new Error('Original contract changed');
 const sources=await withTenant(tenant,tx=>tx`select r.purpose,p.id,p.status,p.amount_cents,p.payment_intent_id,p.stripe_account_id,
  (select sum(amount_cents)::int from commerce_deposit_ledger where payment_id=p.id) as balance,
  (select count(*)::int from commerce_deposit_ledger where payment_id=p.id and entry='collected') as collections
  from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id where r.hold_id=${state.holdId} order by r.created_at`);
 if(sources.length!==2||sources.some(s=>s.status!=='refunded'||s.balance!==0||s.collections!==1)||sources.reduce((n,s)=>n+s.amount_cents,0)!==3800)throw new Error('Original sources did not close exactly');
 const refunds=await withTenant(tenant,tx=>tx`select id,payment_id,amount_cents,status,stripe_refund_id from commerce_refunds where payment_id=any(${sources.map(s=>s.id)}::uuid[]) order by created_at`);
 if(refunds.length!==3||refunds.some(r=>r.status!=='succeeded')||refunds.reduce((n,r)=>n+r.amount_cents,0)!==3800)throw new Error('Expected three exact original-source refunds');
 const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const stripe=commerceStripeClient();
 const provider=[];for(const r of refunds){const s=sources.find(s=>s.id===r.payment_id)!;const external=await stripe.refunds.retrieve(r.stripe_refund_id,{}, {stripeAccount:s.stripe_account_id});
  if(external.status!=='succeeded'||external.amount!==r.amount_cents||external.payment_intent!==s.payment_intent_id||external.currency!=='usd')throw new Error('Provider original refund mismatch');
  provider.push({refundId:r.id,paymentId:r.payment_id,amountCents:external.amount,status:external.status,originalPaymentIntentVerified:true});}
 const [hold]=await withTenant(tenant,tx=>tx`select status,reserved_cents,commerce_frozen from commerce_appointment_holds where id=${state.holdId}`);
 if(hold!.status!=='refunded'||hold!.reserved_cents!==0||hold!.commerce_frozen)throw new Error('Deposit liability not closed');
 const [ticket]=await withTenant(tenant,tx=>tx`select id,status,total_cents,refund_cents from tickets where appointment_id=${state.appointmentId} and status='refunded'`);
 if(!ticket||ticket.total_cents!==10000||ticket.refund_cents!==10000)throw new Error('Native service return required');
 const [earnings]=await withTenant(tenant,tx=>tx`select sum(base_cents)::int as base,sum(amount_cents)::int as amount from earnings where ticket_id=${ticket.id}`);
 if(earnings!.base!==0||earnings!.amount!==0)throw new Error('Commission return incomplete');
 const report={at:new Date().toISOString(),appointmentId:state.appointmentId,holdId:state.holdId,ticket,hold,originalContractUnchanged:true,unrelated17PaymentsUnchanged:old17,currentPayments:current,
  sources:sources.map(s=>({paymentId:s.id,purpose:s.purpose,status:s.status,amountCents:s.amount_cents,balance:s.balance,collections:s.collections})),refunds:provider,earnings,
  actualStripeTestRefundsVerified:true,nativeFrontDeskFlow:true,physicalCashTransferred:false,notificationDelivery:'capture',productionPublished:false,goalComplete:false};
 await writeFile('artifacts/customer-commerce/p3-adjustments-final-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await closeDb();}
