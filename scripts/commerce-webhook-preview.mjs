// Own local test-only Stripe listener. Secrets stay in the ignored 0600 commerce overlay; raw CLI output never enters artifacts.
import {spawn} from 'node:child_process';
import {readFile,writeFile,chmod} from 'node:fs/promises';
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(!key.startsWith('sk_test_')||process.env.COMMERCE_STRIPE_MODE==='live')throw new Error('Commerce webhook preview requires a test key');
const kind=process.argv[2];
if(!['payments','accounts'].includes(kind))throw new Error('Expected payments|accounts');
const endpoint=kind==='payments'?'http://127.0.0.1:3087/v1/stripe/commerce-webhook':'http://127.0.0.1:3087/v1/stripe/commerce-account-webhook';
const events=kind==='payments'?['checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','invoice.payment_action_required','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','account.updated','account.application.deauthorized','payout.created','payout.updated','payout.paid','payout.failed','payout.canceled','payout.reconciliation_completed']:
  ['v2.core.account.updated','v2.core.account.closed','v2.core.account[configuration.merchant].capability_status_updated','v2.core.account[configuration.merchant].updated','v2.core.account[requirements].updated','v2.core.account[identity].updated','v2.core.account[defaults].updated'];
const args=['listen','--skip-update','--device-name',`gf-commerce-${kind}`,...(kind==='payments'?['--events',events.join(','),'--forward-connect-to',endpoint]:
  ['--thin-events',events.join(','),'--forward-thin-to',endpoint,'--forward-thin-connect-to',endpoint])];
const child=spawn('stripe',args,{env:{...process.env,STRIPE_API_KEY:key},stdio:['ignore','pipe','pipe']});
let secretSaved=false,buffer='',queue=Promise.resolve();
function consume(chunk){
  const raw=chunk.toString();buffer=(buffer+raw).slice(-4096);
  const secret=buffer.match(/whsec_[A-Za-z0-9_-]+/)?.[0];
  if(secret&&!secretSaved){secretSaved=true;queue=queue.then(async()=>{
    const name=kind==='payments'?'STRIPE_COMMERCE_WEBHOOK_SECRET':'STRIPE_COMMERCE_ACCOUNT_WEBHOOK_SECRET';
    let file='';try{file=await readFile('.env.commerce-sandbox','utf8');}catch{}
    const row=new RegExp(`^${name}=.*$`,'m');file=row.test(file)?file.replace(row,`${name}=${secret}`):file+`\n${name}=${secret}\n`;
    await writeFile('.env.commerce-sandbox',file,{mode:0o600});await chmod('.env.commerce-sandbox',0o600);
    console.log(JSON.stringify({ready:true,kind,endpoint,secretStored:true}));
  }).catch(()=>{console.error('commerce_listener_secret_store_failed');process.exitCode=1;child.kill();});}
  // CLI summaries expose only event types, IDs and HTTP responses. Do not print a raw signing secret or arbitrary provider response.
  for(const line of raw.split('\n')){
    if(!line.includes('whsec_')&&/--> |<-- /.test(line))console.log(line.replace(/(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+/g,'[redacted]'));
  }
}
child.stdout.on('data',consume);child.stderr.on('data',consume);
child.on('error',()=>{console.error('commerce_listener_start_failed');process.exitCode=1;});
child.on('exit',async code=>{await queue;if(!secretSaved)console.error('commerce_listener_not_ready');process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
