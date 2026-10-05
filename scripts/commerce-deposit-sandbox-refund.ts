// Restore the original deposit allocation through a service refund, then request its unused amount back through the original Stripe payment.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!process.env.COMMERCE_TEST_ACCOUNT_ID
  ||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local QA and sandbox required');
const path='/tmp/commerce-deposit-sandbox-private.json';
const state=JSON.parse(await readFile(path,'utf8')) as {businessKey:string;orderId:string;holdId:string;appointmentId:string;ticketId:string;purchaseRefundId?:string};
if(!state.ticketId||!state.businessKey)throw new Error('Original browser checkout required');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  const [source]=await withTenant(tenant,tx=>tx`select p.id,p.stripe_account_id,p.livemode,p.amount_cents,t.status
    from commerce_payments p join tickets t on t.appointment_id=${state.appointmentId} where p.order_id=${state.orderId} and t.id=${state.ticketId}`);
  if(!source||source.status!=='closed'||source.livemode||source.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID||source.amount_cents!==2000)throw new Error('Original completed QA checkout required');
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
    body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error(`QA login failed (${auth.status})`);const login=await auth.json() as {access_token:string;user:{id:string}};
  const [membership]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${login.user.id} and status='active'`);
  if(!membership)throw new Error('QA owner missing');
  const headers={'content-type':'application/json',authorization:`Bearer ${login.access_token}`,'x-membership-id':membership.id};
  const command=async<T>(name:string,input:unknown):Promise<T>=>{
    const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,
      body:JSON.stringify({input,idempotencyKey:`sandbox-deposit-refund:${state.businessKey}:${name}`})});
    const body=await response.json() as {result:T;code?:string;details?:{reason?:string}};
    if(!response.ok)throw new Error(`${name}: ${response.status} ${body.code??'error'} ${body.details?.reason??''}`);return body.result;
  };
  await command('ticket.refund',{ticketId:state.ticketId,refundAmountCents:2000,refundTipCents:0,refundMethod:'original_payment',reason:'other',
    notes:'Sandbox acceptance: restore the original deposit share of a partial service refund'});
  const [restoration]=await withTenant(tenant,tx=>tx`select r.amount_cents as refund_amount_cents,r.cash_cents,r.deposit_cents,
    (select count(*)::int from ticket_refunds where ticket_id=${state.ticketId}) as refund_rows,
    (select count(*)::int from commerce_deposit_ledger where hold_id=${state.holdId} and entry='restored') as restoration_rows,
    (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=${state.holdId} and entry='restored') as restored_cents
    from ticket_refunds r where ticket_id=${state.ticketId}`);
  if(restoration?.refund_amount_cents!==2000||restoration.cash_cents!==1600||restoration.deposit_cents!==400
    ||restoration.refund_rows!==1||restoration.restoration_rows!==1||restoration.restored_cents!==400)throw new Error('Original service refund allocation mismatch');
  const refund=await command<{refundId:string}>('commerce.requestRefund',{paymentId:source.id,amountCents:400,
    reason:'Sandbox acceptance: return the unused deposit restored by the original service refund'});
  state.purchaseRefundId=refund.refundId;await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);
  const reconciliation=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${state.orderId}/reconcile`,{method:'POST',headers});
  if(!reconciliation.ok)throw new Error(`Original Stripe reconciliation failed (${reconciliation.status})`);
  const result={at:new Date().toISOString(),liveMode:false,orderId:state.orderId,ticketId:state.ticketId,purchaseRefundId:refund.refundId,
    serviceRefund:restoration,originalStripeRefundRequestedCents:400,refundVerified:false,goalComplete:false};
  await writeFile('artifacts/customer-commerce/stripe-deposit-refund-request.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await closeDb();}
