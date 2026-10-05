// Verify original sandbox-funded service returns without creating another payment or rewriting history.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {TicketRefund} from '../packages/contracts/src/index';
import {commerceFingerprint} from '../packages/payroll/src/commerce';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332')throw new Error('Dedicated preserved QA database required');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!(process.env.COMMERCE_STRIPE_SECRET_KEY||process.env.STRIPE_SECRET_KEY||'').startsWith('sk_test_'))throw new Error('Explicit Stripe sandbox required');
const mode=process.argv[2];if(!['verify-unknown','verify-replayed'].includes(mode??''))throw new Error('Expected unknown or replay verification');
const original=JSON.parse(await readFile('/tmp/commerce-stripe-consume-refund-private.json','utf8')) as {orderId:string;ticketId:string};
const attempt=JSON.parse(await readFile('/tmp/commerce-gift-service-return-attempt.json','utf8')) as {key:string;requestInput:unknown;input:{ticketId:string;amountCents:number;refundTipCents:number;method:string;reason:string;notes?:string;reviewHash?:string};originalHttpStatus:number;responseLossInjected:boolean;replayHttpStatus?:number;replayed?:boolean};
if(attempt.input.ticketId!==original.ticketId||attempt.input.amountCents!==3000||attempt.originalHttpStatus!==201||!attempt.responseLossInjected)throw new Error('Actual committed original gift service response loss required');
const {withTenant,closeDb}=await import('../packages/db/src/index');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
try{
 const originalInput=TicketRefund.input.parse(attempt.requestInput),savedInput=TicketRefund.input.parse({ticketId:attempt.input.ticketId,refundAmountCents:attempt.input.amountCents,refundTipCents:attempt.input.refundTipCents,refundMethod:attempt.input.method,reason:attempt.input.reason,notes:attempt.input.notes,reviewHash:attempt.input.reviewHash});
 const expectedFingerprint=createHash('sha256').update(commerceFingerprint(originalInput)).digest('hex');
 const [receipt]=await withTenant(tenant,tx=>tx`select input_fingerprint from command_idempotency where location_id=${tenant.locationId} and key=${attempt.key} and command='ticket.refund'`);
 if(commerceFingerprint(originalInput)!==commerceFingerprint(savedInput)||receipt?.input_fingerprint!==expectedFingerprint)throw new Error('Saved financial intent differs from the immutable original command receipt');
 const [facts]=await withTenant(tenant,tx=>tx`select t.status,t.refund_cents,g.balance_cents,g.reserved_cents,g.status as gift_status,
  p.amount_cents as original_paid_cents,(select sum(amount_cents)::int from commerce_refunds where payment_id=p.id and status='succeeded') as original_purchase_refund,
  (select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as net_commission,
  (select count(*)::int from ticket_refunds where ticket_id=t.id) as service_refund_rows,
  (select sum(cash_cents+card_cents+customer_credit_cents)::int from ticket_refunds where ticket_id=t.id) as new_money,
  (select count(*)::int from customer_credit_ledger where ticket_id=t.id and kind='gift_card' and entry='refund' and meta->>'ticketRefund'='true') as gift_restore_rows,
  (select count(*)::int from command_idempotency where location_id=${tenant.locationId} and command='ticket.refund' and key=${attempt.key}) as idempotency_rows,
  (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_type='checkout.session.completed' and left(event_id,4)='evt_') as signed_original_payment
  from commerce_orders o join commerce_payments p on p.order_id=o.id join gift_cards g on g.id=o.asset_id join tickets t on t.id=${original.ticketId} where o.id=${original.orderId}`);
 const sources=await withTenant(tenant,tx=>tx`select s.kind,s.amount_cents,(select sum(amount_cents)::int from ticket_source_refunds where source_id=s.id) as returned from ticket_settlement_sources s where ticket_id=${original.ticketId}`);
 if(!facts||facts.status!=='refunded'||facts.refund_cents!==3000||facts.balance_cents!==3000||facts.reserved_cents!==0||facts.gift_status!=='active'||facts.original_paid_cents!==8000||facts.original_purchase_refund!==5600
  ||facts.net_commission!==0||facts.service_refund_rows!==1||facts.new_money!==0||facts.gift_restore_rows!==1||facts.idempotency_rows!==1||facts.signed_original_payment!==1
  ||sources.length!==1||sources[0]!.kind!=='gift_card'||sources[0]!.amount_cents!==3000||sources[0]!.returned!==3000)throw new Error('Original gift funding or exactly-once service return mismatch');
 if(mode==='verify-replayed'&&(attempt.replayHttpStatus!==200||attempt.replayed!==true))throw new Error('Actual saved-request HTTP replay required');
 const report={at:new Date().toISOString(),scope:mode==='verify-replayed'?'Original gift service response loss, page reload and real cached command replay':'Original gift service committed once with the HTTP response intentionally lost',actualSandboxPurchaseReused:true,nativeCashier:true,responseLossAfterActualHttpSuccess:true,sameCanonicalInputFingerprint:true,originalHttpStatus:attempt.originalHttpStatus,replayHttpStatus:attempt.replayHttpStatus??null,refreshedSavedRequestReplayed:mode==='verify-replayed',productionChanged:false,ticketId:original.ticketId,facts,sources};
 await writeFile(`artifacts/customer-commerce/p5-gift-service-${mode==='verify-replayed'?'replayed':'unknown'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await closeDb();}
