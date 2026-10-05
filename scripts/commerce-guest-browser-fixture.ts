// Actual local command/browser story; staff-recorded QA cash only. Never resets financial history.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const u=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='58332')throw new Error('Dedicated QA database required');
  u.pathname='/gf_commerce_ci';process.env[target]=u.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local QA only');
const mode=process.argv[2];if(!['prepare','verify'].includes(mode??''))throw new Error('Expected prepare|verify');
const scenario=process.argv[3]??'staff';if(!['staff','customer'].includes(scenario))throw new Error('Expected staff|customer browser scenario');
const path=scenario==='customer'?'/tmp/commerce-guest-customer-browser-private.json':'/tmp/commerce-guest-browser-private.json',tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
type State={businessKey:string;manageToken:string;serviceId?:string;otherServiceId?:string;input?:unknown;holdId?:string;appointmentId?:string;paymentId?:string};
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  state={businessKey:crypto.randomUUID(),manageToken:`mt_${crypto.randomUUID()}`};}
const save=async()=>{await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);};
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  if(mode==='prepare'){
    const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
      body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
    if(!auth.ok)throw new Error(`QA login failed ${auth.status}`);const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
    const [m]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${login.user.id} and status='active'`);
    if(!m)throw new Error('QA owner membership missing');
    const command=async<T>(name:string,input:unknown,label=name):Promise<T>=>{
      const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${login.access_token}`,'x-membership-id':m.id},
        body:JSON.stringify({input,idempotencyKey:`guest-browser:${state.businessKey}:${label}`})});
      const result=await response.json() as {result:T;code?:string;details?:{reason:string}};
      if(!response.ok)throw new Error(`${name}: ${response.status} ${result.code??''} ${result.details?.reason??''}`);return result.result;
    };
    const deposit=JSON.parse(await readFile('/tmp/commerce-deposit-sandbox-private.json','utf8')) as {serviceId:string};state.serviceId=deposit.serviceId;
    const other=await command<{serviceId:string}>('catalog.saveService',{name:{en:'Guest B cancellation browser QA','zh-Hans':'客人二部分取消验收'},durationMin:30,basePriceCents:7000,taxable:false,onlineBookable:true});
    state.otherServiceId=other.serviceId;await save();
    if(!state.input){
      await command('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'fixed',depositAmountCents:2000,
        cancelCutoffHours:4,retainDepositAfterCutoff:false,cancellationPolicyNotice:'QA unused guest deposits are refundable before the original cancellation deadline.'},'fixed-policy');
      const shopResponse=await fetch('http://127.0.0.1:3087/public/v1/hosted/shops/golden-foot?locale=en');if(!shopResponse.ok)throw new Error('QA shop missing');
      const shop=await shopResponse.json() as {publicKey:string;timezone:string;onlineBooking:{depositPolicyVersion:string}};
      const date=new Intl.DateTimeFormat('en-CA',{timeZone:shop.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000));
      const selections=[{guestIndex:0,serviceId:state.serviceId,addonIds:[],staffId:null},{guestIndex:1,serviceId:state.otherServiceId,addonIds:[],staffId:null}];
      const availability=await fetch('http://127.0.0.1:3087/public/v1/party-availability',{method:'POST',headers:{'content-type':'application/json','x-gf-public-key':shop.publicKey,origin:'http://localhost:5296'},
        body:JSON.stringify({date,items:selections})});
      if(!availability.ok)throw new Error(`Real party availability failed ${availability.status}`);
      const plans=await availability.json() as {plans:Array<{startsAt:string;items:Array<{guestIndex:number;serviceId:string;startsAt:string;staffId:string|null}>}>};
      const plan=plans.plans.find(p=>Date.parse(p.startsAt)>Date.now());if(!plan)throw new Error('No real available two-guest plan; do not bypass capacity');
      state.input={businessKey:state.businessKey,depositConsent:{accepted:true,policyVersion:shop.onlineBooking.depositPolicyVersion,serviceTotalCents:17000,amountCents:2000},
        appointment:{source:'web',partySize:2,customerId:null,items:plan.items.map(i=>({serviceId:i.serviceId,startsAt:i.startsAt,membershipId:i.staffId,
          details:{publicGuestIndex:i.guestIndex}})),guest:{manageToken:state.manageToken,bookingSmsConsent:false,
          customer:{name:scenario==='customer'?'Customer guest cancellation browser QA':'Guest cancellation browser QA',
            email:scenario==='customer'?'guest-self-cancel-browser-qa@example.test':'guest-cancel-browser-qa@example.test',phoneE164:scenario==='customer'?'+12025550131':'+12025550130'}}}};
      await save();
    }
    const h=await command<{holdId:string;appointmentId:string}>('commerce.holdAppointment',state.input,'hold');Object.assign(state,h);await save();
    const paid=await command<{paymentId:string}>('commerce.recordOfflineDeposit',{holdId:state.holdId,amountCents:2000,method:'cash',reference:'Two-guest browser QA cash receipt'},'cash');
    state.paymentId=paid.paymentId;await save();
    // Restore this QA shop's previous mode for future stories; the purchased fixed policy remains immutable.
    await command('location.saveOnlineBooking',{enabled:true,minMinutesAhead:0,maxDaysAhead:60,depositRequired:true,depositMethod:'percentage',depositPercentBps:2000,
      cancelCutoffHours:4,retainDepositAfterCutoff:false,cancellationPolicyNotice:'Sandbox QA: unused deposit is refundable before the original cancellation deadline.'},'restore-policy');
    const authPath='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(authPath,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
    const origin=browser.origins.find(o=>o.origin==='http://localhost:5297'),entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
    if(!origin||!entry)throw new Error('Owned desk auth state missing');entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
    await writeFile(authPath,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(authPath,0o600);
    console.log(JSON.stringify({prepared:true,appointmentId:state.appointmentId,holdId:state.holdId,serviceCents:17000,cashRecordedCents:2000,guestRefundExpectedCents:1176,
      remainingServiceCents:7000,remainingDepositExpectedCents:824,stripeVerified:false,privateStatePath:path}));
  }else{
    if(!state.holdId||!state.appointmentId||!state.paymentId)throw new Error('Original prepared story required');
    const [facts]=await withTenant(tenant,tx=>tx`select a.status,a.party_size,a.deposit_status,h.amount_cents,h.service_total_cents,h.policy_snapshot,h.reserved_cents,
      (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as balance,
      (select sum(price_cents_snapshot)::int from appointment_items where appointment_id=a.id and status<>'cancelled') as active_service_cents,
      (select count(*)::int from appointment_guest_cancellations where appointment_id=a.id and guest_index=0) as cancellation_rows,
      (select actor_source from appointment_guest_cancellations where appointment_id=a.id and guest_index=0) as actor_source,
      (select created_by is null from appointment_guest_cancellations where appointment_id=a.id and guest_index=0) as customer_has_no_employee_actor,
      (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collection_rows
      from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${state.holdId} and a.id=${state.appointmentId}`);
    const refunds=await withTenant(tenant,tx=>tx`select status,amount_cents,deposit_guest_allocation,external_reference from commerce_refunds where payment_id=${state.paymentId}`);
    if(!facts||facts.status!=='booked'||facts.party_size!==1||facts.active_service_cents!==7000||facts.cancellation_rows!==1||facts.collection_rows!==1
      ||facts.actor_source!==scenario||facts.customer_has_no_employee_actor!==(scenario==='customer')
      ||facts.balance!==824||facts.reserved_cents!==0||refunds.length!==1||refunds[0]!.status!=='succeeded'||refunds[0]!.amount_cents!==1176)throw new Error('Browser partial cancellation invariants failed');
    const response=await fetch('http://127.0.0.1:3087/public/v1/hosted/manage',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:5296'},
      body:JSON.stringify({slug:'golden-foot',manageToken:state.manageToken,locale:'zh-Hans'})});
    const detail=await response.json() as {booking:{priceCents:number;originalPriceCents:number;deposit:{availableCents:number;serviceRemainingCents:number}}};
    if(!response.ok||detail.booking.priceCents!==7000||detail.booking.originalPriceCents!==17000||detail.booking.deposit.availableCents!==824||detail.booking.deposit.serviceRemainingCents!==6176)
      throw new Error('Customer partial cancellation summary mismatch');
    const report={at:new Date().toISOString(),browserPartialCancellationVerified:true,scenario,actualApi:true,appointmentId:state.appointmentId,holdId:state.holdId,
      facts,refunds,customerSummary:{activeServiceCents:detail.booking.priceCents,originalServiceCents:detail.booking.originalPriceCents,
        availableDepositCents:detail.booking.deposit.availableCents,remainingServiceCents:detail.booking.deposit.serviceRemainingCents},
      cashEvidence:'Staff-recorded QA collection and cash return',stripeVerified:false,serviceConsumedInThisBrowserStory:false,goalComplete:false};
    await writeFile(scenario==='customer'?'artifacts/customer-commerce/browser-guest-self-cancellation.json':'artifacts/customer-commerce/browser-guest-cancellation.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }
}finally{await closeDb();}
