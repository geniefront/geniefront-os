import type Stripe from 'stripe';
import { z } from 'zod';
import { AppError,ERROR_CODES } from '@gf/contracts';
import { withTenant,sql } from '@gf/db';
import { dispatch } from '../bus';
import { commerceLiveMode } from './config';
import { workerContext } from './worker';
import {commerceStripeClient as stripeClient} from './client';
import type { Ctx } from './model';
import {accountIncludes,saveVerifiedAccount,saveVerifiedV2Account} from './accounts';
const metadataSchema=z.object({gf_domain:z.literal('customer_commerce'),gf_org_id:z.string().uuid(),gf_location_id:z.string().uuid(),gf_order_id:z.string().uuid().optional()});
const idOf=(value:unknown):string|null=>typeof value==='string'?value:value&&typeof value==='object'&&'id' in value?String(value.id):null;
type CommerceEventSource='signed_webhook'|'sdk_reconciliation';
async function processRiskEvent(event:Stripe.Event,source:CommerceEventSource):Promise<string> {
  const account=event.account!;
  const tenants=await sql<{org_id:string;location_id:string}[]>`select * from commerce_internal.account_tenants(${account},${event.livemode})`;
  if(!tenants.length)return 'ignored_unmapped_account';
  const object=event.data.object as Stripe.Dispute|Stripe.Refund;
  if(object.object==='dispute'&&object.livemode!==event.livemode)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'risk_mode_mismatch'}});
  let intent=idOf(object.payment_intent);
  if(!intent&&object.charge) {
    const charge=await stripeClient().charges.retrieve(idOf(object.charge)!,{}, {stripeAccount:account});
    if(charge.livemode!==event.livemode)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    intent=idOf(charge.payment_intent);
  }
  if(!intent)return 'ignored_unmapped_payment';
  let located: {ctx:Ctx;paymentId:string;orderId?:string}|undefined;
  for(const tenant of tenants) {
    const ctx=workerContext(tenant.org_id,tenant.location_id);
    const [payment]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_payments
      where stripe_account_id=${account} and livemode=${event.livemode} and payment_intent_id=${intent!}`);
    if(payment){located={ctx,paymentId:payment.id};break;}
  }
  if(!located) {
    // A risk fact can arrive before the Checkout webhook; retrieve the actual intent in its connected account.
    const paymentIntent=await stripeClient().paymentIntents.retrieve(intent,{}, {stripeAccount:account});
    const meta=metadataSchema.safeParse(paymentIntent.metadata);
    if(paymentIntent.livemode!==event.livemode||!meta.success||!meta.data.gf_order_id)return 'ignored_other_domain';
    const tenant=tenants.find(t=>t.org_id===meta.data.gf_org_id&&t.location_id===meta.data.gf_location_id);
    if(!tenant)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    const ctx=workerContext(tenant.org_id,tenant.location_id);
    const [payment]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_payments where order_id=${meta.data.gf_order_id!}
      and stripe_account_id=${account} and livemode=${event.livemode} and payment_intent_id is null`);
    if(!payment)return 'ignored_unmapped_payment';located={ctx,paymentId:payment.id,orderId:meta.data.gf_order_id};
  }
  const {ctx}=located;
  if(object.object==='refund') {
    const metaId=z.string().uuid().safeParse(object.metadata?.gf_refund_id);
    const [known]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_refunds where payment_id=${located!.paymentId}
      and (stripe_refund_id=${object.id} or id=${metaId.success?metaId.data:null}::uuid)`);
    if(known) {
      const status=object.status==='succeeded'?'succeeded':['failed','canceled'].includes(object.status??'')?'failed':'pending';
      await dispatch('commerce.completeRefund',{refundId:known.id,stripeRefundId:object.id,status,stripeAccountId:account,livemode:event.livemode,amountCents:object.amount,
        event:{id:event.id,type:event.type as 'refund.created'|'refund.updated'|'refund.failed'}},ctx,
        {systemOrigin:source==='signed_webhook'?'commerce_signed_webhook':'commerce_sdk_reconciliation',idempotencyKey:`commerce-event:${account}:${event.id}`});
      return 'refund_recorded';
    }
  }
  await dispatch('commerce.recordRisk',{paymentIntentId:intent,orderId:located.orderId,stripeAccountId:account,livemode:event.livemode,
    kind:object.object==='dispute'?'dispute':'external_refund',externalId:object.id,amountCents:object.amount,currency:object.currency,
    providerStatus:object.status??'pending',eventId:event.id,eventType:event.type,eventCreated:event.created},ctx,
    {systemOrigin:source==='signed_webhook'?'commerce_signed_payment_risk':'commerce_sdk_reconciliation_risk',idempotencyKey:`commerce-event:${account}:${event.id}`});
  return 'payment_risk_recorded';
}
export async function applyPaidCheckout(ctx:Ctx,session:Stripe.Checkout.Session,account:string,livemode:boolean,eventId:string,eventType:string) {
  const meta=metadataSchema.safeParse(session.metadata);
  if(!meta.success||!meta.data.gf_order_id||meta.data.gf_org_id!==ctx.orgId||meta.data.gf_location_id!==ctx.locationId
    ||session.livemode!==livemode||session.client_reference_id!==meta.data.gf_order_id)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'checkout_metadata_mismatch'}});
  if(session.mode!=='payment'||session.payment_status!=='paid')return 'awaiting_payment';
  const intent=idOf(session.payment_intent);
  if(!intent||!session.amount_total||!session.currency)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'paid_checkout_missing_fact'}});
  await dispatch('commerce.recordPayment',{orderId:meta.data.gf_order_id,stripeAccountId:account,livemode,eventId,eventType,sessionId:session.id,
    paymentIntentId:intent,amountCents:session.amount_total,currency:session.currency},ctx,
    {systemOrigin:'commerce_verified_stripe_fact',idempotencyKey:`commerce-event:${account}:${eventId}`});
  return 'payment_recorded';
}
/** SDK observation envelopes use the same validation, but never claim a webhook signature. */
export async function processCommerceEvent(event:Stripe.Event,source:CommerceEventSource='signed_webhook'):Promise<string> {
  if(!event.account)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'connected_account_event_required'}});
  if(event.livemode!==commerceLiveMode())throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'commerce_event_wrong_mode'}});
  if(['payout.created','payout.updated','payout.paid','payout.failed','payout.canceled','payout.reconciliation_completed'].includes(event.type)){
    const payout=event.data.object as Stripe.Payout;
    if(payout.object!=='payout'||payout.livemode!==event.livemode)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'payout_event_context_mismatch'}});
    const result=await (await import('./payouts')).reconcilePayout(event.account,event.livemode,payout.id,{id:event.id,type:event.type});
    return typeof result==='string'?result:'payout_recorded';
  }
  if(event.type.startsWith('invoice.')||event.type.startsWith('customer.subscription.')
    ||((event.data.object as {metadata?:Record<string,string>}).metadata?.gf_membership_id&&event.type.startsWith('checkout.session.'))){
    const tenants=await sql`select * from commerce_internal.account_tenants(${event.account},${event.livemode})`;
    if(!tenants.length)return 'ignored_unmapped_account';
    return (await import('./customerMembership')).processMembershipEvent(event);
  }
  if(['refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.updated','charge.dispute.closed'].includes(event.type))return processRiskEvent(event,source);
  if(event.type==='account.application.deauthorized'||event.type==='account.updated') {
    const tenants=await sql<{org_id:string;location_id:string}[]>`select * from commerce_internal.account_tenants(${event.account},${event.livemode})`;
    for(const tenant of tenants) {
      const ctx=workerContext(tenant.org_id,tenant.location_id);
      if(event.type==='account.application.deauthorized')await dispatch('commerce.disconnectAccount',
        {stripeAccountId:event.account,livemode:event.livemode,eventId:event.id},ctx,
        {systemOrigin:'commerce_signed_connect_event',idempotencyKey:`commerce-disconnect:${event.id}`});
      else {
        const account=event.data.object as Stripe.Account;if(account.id!==event.account)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
        const [mapping]=await withTenant(ctx,tx=>tx<{api_version:string}[]>`select api_version from commerce_accounts where location_id=${ctx.locationId} and stripe_account_id=${event.account!} and livemode=${event.livemode}`);
        if(mapping?.api_version==='v2')await saveVerifiedV2Account(ctx,await stripeClient().v2.core.accounts.retrieve(account.id,{include:accountIncludes}),
          event.livemode,event.id,{id:event.id,type:event.type});
        else await saveVerifiedAccount(ctx,await stripeClient().accounts.retrieve(account.id),event.livemode,event.id,{id:event.id,type:event.type});
      }
    }
    return tenants.length?'account_updated':'ignored_unmapped_account';
  }
  const object=event.data.object as unknown as {id:string;metadata?:Record<string,string>};
  if(object.metadata?.gf_domain!=='customer_commerce')return 'ignored_other_domain';
  const metadata=metadataSchema.parse(object.metadata);
  const ctx=workerContext(metadata.gf_org_id,metadata.gf_location_id);
  const [account]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_accounts
    where location_id=${ctx.locationId} and stripe_account_id=${event.account!} and livemode=${event.livemode}`);
  if(!account)throw new AppError(ERROR_CODES.PERMISSION_DENIED,{details:{reason:'commerce_event_wrong_account'}});
  if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))
    return applyPaidCheckout(ctx,event.data.object as Stripe.Checkout.Session,event.account,event.livemode,event.id,event.type);
  return 'ignored_type';
}
const accountEvent=z.object({id:z.string().min(1).max(200),object:z.literal('v2.core.event'),livemode:z.boolean(),type:z.string(),
  related_object:z.object({id:z.string().regex(/^acct_[A-Za-z0-9]+$/),type:z.literal('v2.core.account')})});
const accountEventTypes=new Set(['v2.core.account.updated','v2.core.account.closed',
  'v2.core.account[configuration.merchant].capability_status_updated','v2.core.account[configuration.merchant].updated',
  'v2.core.account[requirements].updated','v2.core.account[identity].updated','v2.core.account[defaults].updated']);
/** Thin account events carry references; always retrieve capabilities rather than treating their payload as a financial fact. */
export async function processCommerceAccountEvent(raw:unknown):Promise<string> {
  const type=z.object({type:z.string(),livemode:z.boolean()}).parse(raw);
  if(type.livemode!==commerceLiveMode())throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'commerce_event_wrong_mode'}});
  if(!accountEventTypes.has(type.type))return 'ignored_type';
  const event=accountEvent.parse(raw),id=event.related_object.id;
  const tenants=await sql<{org_id:string;location_id:string}[]>`select * from commerce_internal.account_tenants(${id},${event.livemode})`;
  if(!tenants.length)return 'ignored_unmapped_account';
  const account=await stripeClient().v2.core.accounts.retrieve(id,{include:accountIncludes});
  if(account.id!==id||account.livemode!==event.livemode)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  for(const tenant of tenants){
    const ctx=workerContext(tenant.org_id,tenant.location_id);
    const [mapping]=await withTenant(ctx,tx=>tx<{api_version:string}[]>`select api_version from commerce_accounts where location_id=${ctx.locationId} and stripe_account_id=${id} and livemode=${event.livemode}`);
    if(mapping?.api_version!=='v2')continue;
    await saveVerifiedV2Account(ctx,account,event.livemode,event.id,{id:event.id,type:event.type});
  }
  return 'account_updated';
}
export async function reconcileCheckout(ctx:Ctx,orderId:string):Promise<string> {
  const {reconcileCommerceOrder}=await import('./reconciliation');
  await reconcileCommerceOrder(ctx,orderId);
  return 'reconciled';
}
