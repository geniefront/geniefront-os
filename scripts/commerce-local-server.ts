import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_DATABASE_URL;
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL'] as const){const url=new URL(process.env[key]!);url.pathname='/gf_commerce_ci';process.env[key]=url.href;}
process.env.DATABASE_TEST_TARGET='isolated';process.env.NODE_ENV='test';
process.env.COMMUNICATION_DELIVERY_MODE='capture';
assertRegressionTarget(process.env);
if(new URL(process.env.DATABASE_URL!).port!=='58332')throw new Error('Commerce preview requires the dedicated QA container');
// Authentication stays on the real local Supabase Auth issuer. Financial writes use only the isolated DB.
const {buildServer}=await import('../apps/api/src/server');
const {startCommerceWorker}=await import('../apps/api/src/commerce/worker');
const {startOutboxSweepJob}=await import('../apps/api/src/ops/outboxSweep');
const app=buildServer();
// Test-only diagnostics expose signature structure and clock skew, never payloads, MACs or signing keys.
app.addHook('onResponse',async(req,reply)=>{
  if(req.url==='/v1/stripe/commerce-account-webhook'&&reply.statusCode>=400){
    const header=typeof req.headers['stripe-signature']==='string'?req.headers['stripe-signature']:'';
    const fields=header.split(',').map(v=>v.split('=')[0]);const time=header.match(/(?:^|,)t=(\d+)/)?.[1];
    app.log.warn({status:reply.statusCode,signatureHeaders:Object.keys(req.headers).filter(k=>k.includes('stripe')),
      schemes:fields.filter(v=>v!=='t'),clockSkewSeconds:time?Math.abs(Date.now()/1000-Number(time)):null,
      signingKeyLength:process.env.STRIPE_COMMERCE_ACCOUNT_WEBHOOK_SECRET?.length??0},'commerce account webhook QA diagnostic');
  }
});
process.env.OUTBOX_SWEEP_MIN_AGE_SEC='0';
process.env.OUTBOX_SWEEP_INTERVAL_MS='10000';
startCommerceWorker(app);startOutboxSweepJob(app);
await app.listen({host:'127.0.0.1',port:3087});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close().then(()=>process.exit(0)));
