// Read only: refresh capability evidence for the existing tenant-mapped test merchant. Never create or attest identity.
import {writeFile} from 'node:fs/promises';
import {commerceStripeClient} from '../apps/api/src/commerce/client';
import {accountIncludes} from '../apps/api/src/commerce/accounts';
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(!key.startsWith('sk_test_')||process.env.COMMERCE_STRIPE_MODE==='live')throw new Error('Test-only Stripe credentials required');
process.env.COMMERCE_STRIPE_MODE='test';
const id=process.env.COMMERCE_TEST_ACCOUNT_ID;if(!id?.startsWith('acct_'))throw new Error('Existing test merchant required');
const account=await commerceStripeClient().v2.core.accounts.retrieve(id,{include:accountIncludes});
if(account.livemode||account.metadata?.gf_domain!=='customer_commerce'||account.metadata.gf_location_id!=='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
  throw new Error('Test merchant context mismatch');
const report={at:new Date().toISOString(),stripeVerified:true,operation:'retrieve_existing_account',liveMode:false,apiVersion:'v2',
  connectedAccountId:account.id,closed:account.closed??false,merchantApplied:account.configuration?.merchant?.applied??false,
  cardPayments:account.configuration?.merchant?.capabilities?.card_payments?.status??null,
  payouts:account.configuration?.merchant?.capabilities?.stripe_balance?.payouts?.status??null,
  requirementStatus:account.requirements?.summary?.minimum_deadline?.status??null,checkoutVerified:false};
await writeFile('artifacts/customer-commerce/stripe-account-status.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
