import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { AppError,ERROR_CODES } from '@gf/contracts';
import { dispatch } from '../bus';
import { commerceStripeClient } from './client';
import type { Ctx } from './model';

export const accountIncludes:Stripe.V2.Core.AccountRetrieveParams.Include[]=['configuration.merchant','requirements'];
export type CommerceAccountMapping={stripe_account_id:string;api_version:'v1'|'v2'};

/** New merchants use Accounts v2; this never accepts terms or supplies identity attestations. */
export function newMerchantParams(ctx:Ctx):Stripe.V2.Core.AccountCreateParams {
  const country=(process.env.COMMERCE_CONNECT_COUNTRY||'US').toLowerCase();
  if(!/^[a-z]{2}$/.test(country))throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'invalid_connect_country'}});
  return {identity:{country},configuration:{merchant:{capabilities:{card_payments:{requested:true}}}},
    defaults:{responsibilities:{fees_collector:'stripe',losses_collector:'stripe'}},dashboard:'full',include:accountIncludes,
    metadata:{gf_domain:'customer_commerce',gf_org_id:ctx.orgId,gf_location_id:ctx.locationId}};
}
export async function saveVerifiedAccount(ctx:Ctx,account:Stripe.Account,livemode:boolean,requestKey:string,sourceEvent?:{id:string;type:string}) {
  // Accounts v1 do not expose livemode. Their retrieval uses the already mode-checked commerce key.
  return dispatch('commerce.saveAccount',{stripeAccountId:account.id,livemode,chargesEnabled:account.charges_enabled,
    payoutsEnabled:account.payouts_enabled,detailsSubmitted:account.details_submitted,apiVersion:'v1',
    capabilities:account.capabilities??{},requirements:account.requirements??{},disconnected:false,sourceEvent},ctx,
    {systemOrigin:'commerce_stripe_account_retrieved',idempotencyKey:`commerce-account:${sourceEvent?randomUUID():requestKey}`});
}
export async function saveVerifiedV2Account(ctx:Ctx,account:Stripe.V2.Core.Account,livemode:boolean,requestKey:string,sourceEvent?:{id:string;type:string}) {
  if(account.livemode!==livemode)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'commerce_account_wrong_mode'}});
  const merchant=account.configuration?.merchant;
  const card=merchant?.capabilities?.card_payments?.status??'unrequested';
  const merchantActive=merchant?.applied!==false;
  const payouts=merchant?.capabilities?.stripe_balance?.payouts?.status??'unrequested';
  const due=account.requirements?.entries?.filter(e=>e.awaiting_action_from==='user'&&e.minimum_deadline.status!=='eventually_due')??[];
  return dispatch('commerce.saveAccount',{stripeAccountId:account.id,livemode,apiVersion:'v2',disconnected:account.closed===true,
    chargesEnabled:!account.closed&&merchantActive&&card==='active',payoutsEnabled:!account.closed&&merchantActive&&payouts==='active',sourceEvent,
    // v2 has no details_submitted field: this projection means usable merchant capability, never inferred from missing requirements.
    detailsSubmitted:!account.closed&&merchantActive&&card==='active'&&due.length===0,
    capabilities:{card_payments:card,payouts},requirements:account.requirements??{}},ctx,
    {systemOrigin:'commerce_stripe_account_retrieved',idempotencyKey:`commerce-account:${sourceEvent?randomUUID():requestKey}`});
}
export async function refreshCommerceAccount(ctx:Ctx,mapping:CommerceAccountMapping,livemode:boolean,key:string) {
  const stripe=commerceStripeClient();
  if(mapping.api_version==='v2')return saveVerifiedV2Account(ctx,await stripe.v2.core.accounts.retrieve(mapping.stripe_account_id,{include:accountIncludes}),livemode,key);
  return saveVerifiedAccount(ctx,await stripe.accounts.retrieve(mapping.stripe_account_id),livemode,key);
}
export async function merchantOnboardingLink(mapping:CommerceAccountMapping,returnUrl:string,refreshUrl:string) {
  const stripe=commerceStripeClient();
  if(mapping.api_version==='v2')return stripe.v2.core.accountLinks.create({account:mapping.stripe_account_id,
    use_case:{type:'account_onboarding',account_onboarding:{configurations:['merchant'],return_url:returnUrl,refresh_url:refreshUrl}}});
  return stripe.accountLinks.create({account:mapping.stripe_account_id,type:'account_onboarding',return_url:returnUrl,refresh_url:refreshUrl});
}
