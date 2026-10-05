// Create and complete the isolated test service through normal APIs, then leave the actual frontdesk checkout for browser verification.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
import {businessDateOf} from '../packages/scheduling/src/index';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!process.env.COMMERCE_TEST_ACCOUNT_ID
  ||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local QA and sandbox required');
const path='/tmp/commerce-deposit-sandbox-private.json';
const state=JSON.parse(await readFile(path,'utf8')) as {businessKey:string;orderId:string;holdId:string;appointmentId:string;ticketId?:string;ticketItemIds?:string[]};
if(!state.orderId||!state.businessKey)throw new Error('Verify the original browser-created deposit first');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  const [source]=await withTenant(tenant,tx=>tx`select h.status,h.commerce_frozen,a.customer_id,a.business_date::text,
    loc.timezone,loc.business_day_cutoff::text as cutoff,p.status as payment_status,p.stripe_account_id,p.livemode
    from commerce_appointment_holds h join appointments a on a.id=h.appointment_id join locations loc on loc.id=h.location_id
    join commerce_payments p on p.order_id=h.order_id where h.id=${state.holdId} and h.order_id=${state.orderId} and a.id=${state.appointmentId}`);
  if(!source||source.status!=='paid'||source.commerce_frozen||source.payment_status!=='paid'||source.livemode||source.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Confirmed original test deposit required');
  if(source.business_date!==businessDateOf(new Date(),source.timezone,source.cutoff))throw new Error('appointment_business_date_mismatch: keep the real booking time and continue independent work');
  const items=await withTenant(tenant,tx=>tx`select service_id,coalesce(membership_id,reserved_membership_id) as membership_id
    from appointment_items where appointment_id=${state.appointmentId} and status<>'cancelled' order by seq`);
  if(items.length!==1||items.some(i=>!i.membership_id))throw new Error('QA arrival requires an explicit valid staff assignment');
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
    body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error(`QA login failed (${auth.status})`);const login=await auth.json() as {access_token:string;user:{id:string}};
  const [membership]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${login.user.id} and status='active'`);
  if(!membership)throw new Error('QA owner membership missing');
  const headers={'content-type':'application/json',authorization:`Bearer ${login.access_token}`,'x-membership-id':membership.id};
  const command=async<T>(name:string,input:unknown):Promise<T>=>{
    const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,
      body:JSON.stringify({input,idempotencyKey:`sandbox-deposit-service:${state.businessKey}:${name}`})});
    const body=await response.json() as {result:T;code?:string;details?:{reason?:string}};
    if(!response.ok)throw new Error(`${name}: ${response.status} ${body.code??'error'} ${body.details?.reason??''}`);return body.result;
  };
  const ticket=await command<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{customerId:source.customer_id,appointmentId:state.appointmentId,
    items:items.map(i=>({serviceId:i.service_id,membershipId:i.membership_id}))});
  Object.assign(state,{ticketId:ticket.ticketId,ticketItemIds:ticket.ticketItemIds});
  await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);
  await command('ticket.startItem',{ticketItemId:ticket.ticketItemIds[0],membershipId:items[0]!.membership_id});
  await command('ticket.finishItem',{ticketItemId:ticket.ticketItemIds[0],membershipId:items[0]!.membership_id});
  console.log(JSON.stringify({prepared:true,liveMode:false,ticketId:ticket.ticketId,businessDate:source.business_date,timezone:source.timezone,
    serviceCents:10000,depositCents:2000,frontdeskNewPaymentExpectedCents:8000,checkoutVerified:false}));
}finally{await closeDb();}
