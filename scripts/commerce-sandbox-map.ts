// Map only a real, mode-checked sandbox merchant into the disposable QA database.
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_DATABASE_URL;
for(const name of ['DATABASE_URL','MIGRATION_DATABASE_URL'] as const){
  const url=new URL(process.env[name]!);if(url.port!=='58332')throw new Error('Dedicated commerce QA DB required');
  url.pathname='/gf_commerce_ci';process.env[name]=url.href;
}
assertRegressionTarget(process.env);
process.env.COMMERCE_STRIPE_MODE='test';
const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
const {saveVerifiedV2Account,accountIncludes}=await import('../apps/api/src/commerce/accounts');
const {workerContext}=await import('../apps/api/src/commerce/worker');
const {closeDb}=await import('../packages/db/src/index');
await import('../apps/api/src/handlers/commerce');
const ctx=workerContext('22222222-2222-4222-8222-222222222222','bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
try{
  const id=process.env.COMMERCE_TEST_ACCOUNT_ID;if(!id?.startsWith('acct_'))throw new Error('Run the test-only sandbox account setup first');
  const account=await commerceStripeClient().v2.core.accounts.retrieve(id,{include:accountIncludes});
  if(account.livemode||account.metadata?.gf_domain!=='customer_commerce'||account.metadata.gf_org_id!==ctx.orgId||account.metadata.gf_location_id!==ctx.locationId)
    throw new Error('Sandbox account must match this QA tenant');
  await saveVerifiedV2Account(ctx,account,false,crypto.randomUUID());
  console.log(JSON.stringify({mapped:true,liveMode:false,cardPayments:account.configuration?.merchant?.capabilities?.card_payments?.status??null}));
}finally{await closeDb();}
