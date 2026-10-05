import {randomUUID} from 'node:crypto';
import type Stripe from 'stripe';
import {withTenant} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {dispatch} from '../bus';
import {commerceStripeClient as stripeClient} from './client';
import {commerceLiveMode} from './config';
import {applyPaidCheckout,processCommerceEvent} from './webhook';
import type {Ctx} from './model';
const idOf=(v:string|{id:string}|null)=>typeof v==='string'?v:v?.id??null;
/** All SDK calls occur outside a database transaction, in the server-selected connected account. */
export async function reconcileCommerceOrder(ctx:Ctx,orderId:string):Promise<number|undefined> {
  const [order]=await withTenant(ctx,tx=>tx<{kind:string}[]>`select kind from commerce_orders where id=${orderId}`);
  if(order?.kind==='customer_membership')return (await import('./customerMembership')).reconcileMembership(ctx,orderId);
  const [p]=await withTenant(ctx,tx=>tx<{id:string;status:string;checkout_session_id:string|null;stripe_account_id:string;livemode:boolean;amount_cents:number;currency:string}[]>`
    select * from commerce_payments where order_id=${orderId} and provider='stripe'`);
  if(!p)return;
  if(p.livemode!==commerceLiveMode()||!p.stripe_account_id)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  if(!p.checkout_session_id)return 15;
  const stripe=stripeClient(),options={stripeAccount:p.stripe_account_id};
  const session=await stripe.checkout.sessions.retrieve(p.checkout_session_id,{},options);
  if(session.livemode!==p.livemode||session.metadata?.gf_domain!=='customer_commerce'||session.metadata.gf_org_id!==ctx.orgId
    ||session.metadata.gf_location_id!==ctx.locationId||session.metadata.gf_order_id!==orderId||session.client_reference_id!==orderId)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'checkout_context_mismatch'}});
  if(session.status==='expired'&&session.payment_status!=='paid') {
    await dispatch('commerce.expireOrder',{orderId,sessionId:session.id,stripeAccountId:p.stripe_account_id,livemode:p.livemode},ctx,
      {systemOrigin:'commerce_retrieved_expired_checkout',idempotencyKey:`commerce-expired:${session.id}`});
    return;
  }
  const intentId=idOf(session.payment_intent);if(session.payment_status!=='paid'||!intentId)return 30;
  const intent=await stripe.paymentIntents.retrieve(intentId,{expand:['latest_charge.balance_transaction']},options);
  if(intent.livemode!==p.livemode||intent.status!=='succeeded'||intent.amount_received!==p.amount_cents||intent.currency!==p.currency
    ||intent.metadata.gf_domain!=='customer_commerce'||intent.metadata.gf_order_id!==orderId||intent.metadata.gf_org_id!==ctx.orgId||intent.metadata.gf_location_id!==ctx.locationId)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'intent_context_mismatch'}});
  const runId=randomUUID(),observedAt=Math.floor(Date.now()/1000);
  // Inspect already-refunded/disputed funds before allowing a missed paid webhook to issue an asset.
  let pendingSettlement=false;
  for await(const refund of stripe.refunds.list({payment_intent:intentId,limit:100},options)) {
    await processCommerceEvent({id:`reconcile:${runId}:${refund.id}`,created:observedAt,account:p.stripe_account_id,livemode:p.livemode,
      type:'refund.updated',data:{object:refund}} as Stripe.Event,'sdk_reconciliation');
    const [known]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_refunds where payment_id=${p.id} and stripe_refund_id=${refund.id} and status='succeeded'`);
    if(known&&refund.status==='succeeded') {
      const bt=refund.balance_transaction?typeof refund.balance_transaction==='string'
        ?await stripe.balanceTransactions.retrieve(refund.balance_transaction,{},options):refund.balance_transaction:null;
      if(bt)await recordSettlement(ctx,p,'refund',known.id,refund.id,refund.amount,bt,bt.created);
      else pendingSettlement=true;
    }
  }
  for await(const dispute of stripe.disputes.list({payment_intent:intentId,limit:100},options)) {
    await processCommerceEvent({id:`reconcile:${runId}:${dispute.id}`,created:observedAt,account:p.stripe_account_id,livemode:p.livemode,
      type:'charge.dispute.updated',data:{object:dispute}} as Stripe.Event,'sdk_reconciliation');
  }
  await applyPaidCheckout(ctx,session,p.stripe_account_id,p.livemode,`reconcile:${session.id}:paid`,'reconcile.checkout');
  const charge=intent.latest_charge?typeof intent.latest_charge==='string'?await stripe.charges.retrieve(intent.latest_charge,{expand:['balance_transaction']},options):intent.latest_charge:null;
  if(!charge||charge.livemode!==p.livemode||idOf(charge.payment_intent)!==intentId||charge.amount!==p.amount_cents)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'charge_context_mismatch'}});
  const balance=charge.balance_transaction?typeof charge.balance_transaction==='string'
    ?await stripe.balanceTransactions.retrieve(charge.balance_transaction,{},options):charge.balance_transaction:null;
  if(balance)await recordSettlement(ctx,p,'payment',p.id,charge.id,charge.amount,balance,charge.created);
  else pendingSettlement=true;
  const [current]=await withTenant(ctx,tx=>tx<{status:string}[]>`select status from commerce_payments where id=${p.id}`);
  return pendingSettlement?60:current?.status==='refunded'?undefined:3600;
}
export async function recordSettlement(ctx:Ctx,p:{stripe_account_id:string;livemode:boolean},target:'payment'|'refund',id:string,providerId:string,
  originalAmountCents:number,balance:Stripe.BalanceTransaction,occurredAt:number) {
  await dispatch('commerce.recordSettlement',{target,id,providerId,originalAmountCents,stripeAccountId:p.stripe_account_id,livemode:p.livemode,
    balanceTransactionId:balance.id,currency:balance.currency,grossCents:balance.amount,feeCents:balance.fee,netCents:balance.net,
    occurredAt:new Date(occurredAt*1000).toISOString(),availableOn:new Date(balance.available_on*1000).toISOString()},ctx,
    {systemOrigin:'commerce_retrieved_balance_transaction',idempotencyKey:`commerce-settlement:${balance.id}`});
}
/** Membership invoice payments have no one-off Checkout reconciliation path; retain the same verified refund adapter. */
export async function reconcileMembershipPaymentRefunds(ctx:Ctx,paymentId:string):Promise<boolean>{
 const [p]=await withTenant(ctx,tx=>tx<{stripe_account_id:string;livemode:boolean;payment_intent_id:string;currency:string}[]>`select stripe_account_id,livemode,payment_intent_id,currency
  from commerce_payments where id=${paymentId} and provider='stripe'`);
 if(!p?.payment_intent_id)return false;
 if(p.livemode!==commerceLiveMode()||!p.stripe_account_id)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
 const stripe=stripeClient(),options={stripeAccount:p.stripe_account_id},runId=randomUUID(),observedAt=Math.floor(Date.now()/1000);let pending=false;
 for await(const refund of stripe.refunds.list({payment_intent:p.payment_intent_id,limit:100},options)){
  if(refund.currency!==p.currency||idOf(refund.payment_intent)!==p.payment_intent_id)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'refund_provider_context_mismatch'}});
  await processCommerceEvent({id:`reconcile:${runId}:${refund.id}`,created:observedAt,account:p.stripe_account_id,livemode:p.livemode,
   type:'refund.updated',data:{object:refund}} as Stripe.Event,'sdk_reconciliation');
  const [r]=await withTenant(ctx,tx=>tx<{id:string;status:string}[]>`select id,status from commerce_refunds where payment_id=${paymentId} and stripe_refund_id=${refund.id}`);
  if(r?.status==='pending')pending=true;
  if(r?.status==='succeeded'){
   const balance=refund.balance_transaction?typeof refund.balance_transaction==='string'?await stripe.balanceTransactions.retrieve(refund.balance_transaction,{},options):refund.balance_transaction:null;
   if(balance)await recordSettlement(ctx,p,'refund',r.id,refund.id,refund.amount,balance,balance.created);else pending=true;
  }
 }
 const [outstanding]=await withTenant(ctx,tx=>tx<{pending:boolean}[]>`select exists(select 1 from commerce_refunds r where r.payment_id=${paymentId}
  and (r.status in('pending','review') or(r.status='succeeded' and r.balance_transaction_id is null))) as pending`);
 return pending||outstanding!.pending;
}
