// Configure an isolated fake store through actual APIs before browser/sandbox verification. Never resets its financial history.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated commerce QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!process.env.COMMERCE_TEST_ACCOUNT_ID
  ||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Existing sandbox and local QA Auth required');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const statePath='/tmp/commerce-deposit-sandbox-private.json';
type State={businessKey:string;serviceId?:string;preparedAt?:string;orderId?:string;appointmentId?:string;holdId?:string;ticketId?:string;ticketItemIds?:string[]};
let state:State;
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={businessKey:crypto.randomUUID()};}
const save=async()=>{await writeFile(statePath,JSON.stringify(state),{mode:0o600});await chmod(statePath,0o600);};await save();
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  const [account]=await withTenant(tenant,tx=>tx`select stripe_account_id,livemode,charges_enabled from commerce_accounts where location_id=${tenant.locationId} and not livemode`);
  if(!account||account.livemode||!account.charges_enabled||account.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Mapped test merchant not ready');
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
    body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error(`QA login failed (${auth.status})`);
  const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
  const [membership]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${login.user.id} and status='active'`);
  if(!membership)throw new Error('QA operator membership missing');
  const headers={'content-type':'application/json',authorization:`Bearer ${login.access_token}`,'x-membership-id':membership.id};
  const command=async<T>(name:string,input:unknown):Promise<T>=>{
    const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,
      body:JSON.stringify({input,idempotencyKey:`sandbox-deposit-prepare:${state.businessKey}:${name}`})});
    const body=await response.json() as {result:T;code?:string;details?:{reason?:string}};
    if(!response.ok)throw new Error(`${name}: ${response.status} ${body.code??'error'} ${body.details?.reason??''}`);return body.result;
  };
  await command('commerce.saveSettings',{salesEnabled:true,depositsEnabled:true,membershipsEnabled:false});
  const service=await command<{serviceId:string}>('catalog.saveService',{name:{en:'Appointment deposit sandbox QA','zh-Hans':'预约定金沙盒验收'},durationMin:30,
    basePriceCents:10000,taxable:false,onlineBookable:true});state.serviceId=service.serviceId;
  await command('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000,
    cancelCutoffHours:4,retainDepositAfterCutoff:false,cancellationPolicyNotice:'Sandbox QA: unused deposit is refundable before the original cancellation deadline.'});
  state.preparedAt??=new Date().toISOString();await save();
  // Refresh only our owned localhost browser state; no tokens or customer data enter stdout or artifacts.
  const authPath='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(authPath,'utf8')) as {cookies:unknown[];origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
  const origin=browser.origins.find(o=>o.origin==='http://localhost:5297');
  const entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
  if(!origin||!entry)throw new Error('Owned localhost desk auth state missing');
  entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
  await writeFile(authPath,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(authPath,0o600);
  console.log(JSON.stringify({prepared:true,liveMode:false,serviceId:state.serviceId,serviceTotalCents:10000,percentageBps:2000,expectedDepositCents:2000,
    privateStatePath:statePath,deskAuthRefreshed:true}));
}finally{await closeDb();}
