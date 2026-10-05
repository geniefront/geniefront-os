// Real test-only Connect setup. No identity attestations, terms acceptance, live mode, or database writes.
// node --env-file=.env.local --import tsx scripts/commerce-sandbox-account.ts
import {writeFile,readFile} from 'node:fs/promises';
import {commerceStripeClient} from '../apps/api/src/commerce/client';
import {newMerchantParams,accountIncludes} from '../apps/api/src/commerce/accounts';
import type {Ctx} from '../apps/api/src/commerce/model';

const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(!key.startsWith('sk_test_')||process.env.COMMERCE_STRIPE_MODE==='live')throw new Error('Requires an explicitly test-only Stripe credential');
process.env.COMMERCE_STRIPE_MODE='test';
const ctx={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'} as Ctx;
const stripe=commerceStripeClient();
try {
  const root=await stripe.accounts.retrieve();
  const account=await stripe.v2.core.accounts.create(newMerchantParams(ctx),
    {idempotencyKey:`gf-commerce-account-v2:${ctx.locationId}:false`});
  if(account.livemode)throw new Error('Unexpected live account');
  const current=await stripe.v2.core.accounts.retrieve(account.id,{include:accountIncludes});
  const report={at:new Date().toISOString(),stripeVerified:true,liveMode:current.livemode,apiVersion:'v2',platformAccountId:root.id,
    connectedAccountId:current.id,closed:current.closed??false,cardPayments:current.configuration?.merchant?.capabilities?.card_payments?.status??null,
    payouts:current.configuration?.merchant?.capabilities?.stripe_balance?.payouts?.status??null,
    requirementStatus:current.requirements?.summary?.minimum_deadline?.status??null};
  await writeFile('artifacts/customer-commerce/stripe-account-v2.json',JSON.stringify(report,null,2)+'\n');
  // Preserve any previously configured webhook credentials, and never print credentials or onboarding links.
  let local='';try{local=await readFile('.env.commerce-sandbox','utf8');}catch{}
  if(!local.includes('COMMERCE_STRIPE_MODE='))local+='COMMERCE_STRIPE_MODE=test\n';
  if(!local.includes('GF_CUSTOMER_COMMERCE_ENABLED='))local+='GF_CUSTOMER_COMMERCE_ENABLED=1\n';
  if(!local.includes('COMMERCE_TEST_ACCOUNT_ID='))local+=`COMMERCE_TEST_ACCOUNT_ID=${current.id}\n`;
  await writeFile('.env.commerce-sandbox',local,{mode:0o600});
  console.log(JSON.stringify(report));
}catch(error){
  const e=error as {type?:string;code?:string;statusCode?:number;message?:string};
  const report={at:new Date().toISOString(),stripeVerified:false,liveMode:false,apiVersion:'v2',errorType:e.type??'Error',code:e.code??null,
    statusCode:e.statusCode??null,message:(e.message??'Account setup failed').replace(/(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+/g,'[redacted]')};
  await writeFile('artifacts/customer-commerce/stripe-account-v2.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));process.exitCode=1;
}
