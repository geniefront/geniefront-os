// Native merge of the original sandbox member; no replacement purchases or financial backfills.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {customerMergeInput} from '../packages/contracts/src/index';
import {commerceFingerprint} from '../packages/payroll/src/index';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332')throw new Error('Preserved local QA required');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local test Auth required');
const mode=process.argv[2],session='commerce-merge-native',file='/tmp/commerce-merge-private.json',attemptFile='/tmp/commerce-merge-attempt-private.json';
if(!['prepare-target','open-desk','install-loss','capture-loss','observe-replay','verify-merge','prepare-service','verify-use','verify-return'].includes(mode??''))throw new Error('Unknown merge fixture mode');
const purchase=JSON.parse(await readFile('/tmp/commerce-membership-browser-private.json','utf8')) as {membershipId:string;orderId:string};
type State={key:string;sourceId?:string;targetId?:string;before?:unknown;ticketId?:string;itemId?:string;staffId?:string;cycleId?:string};let state:State;
try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
async function save(){await writeFile(file,JSON.stringify(state),{mode:0o600});await chmod(file,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
function browser(args:string[],input?:string){const r=spawnSync(process.execPath,[cli,'--session',session,...args],{encoding:'utf8',...(input?{input}:{})});if(r.status!==0)throw new Error('Owned browser operation failed');return r.stdout.trim();}
function evaluate(code:string){return JSON.parse(browser(['eval','--stdin'],code));}
async function financialSnapshot(){return withTenant(tenant,async tx=>{
 const result:Record<string,unknown>={};
 for(const table of ['commerce_payments','commerce_refunds','commerce_orders','customer_paid_memberships','customer_membership_invoices','customer_membership_cycles','customer_credit_ledger','customer_package_ledger','customer_membership_ledger','customer_packages','gift_cards','appointments','tickets','payments','ticket_refunds','earnings','tip_allocations']){
  const [row]=await tx.unsafe(`select count(*)::int as count,md5(string_agg(row_to_json(x)::text,'|' order by id)) as hash from ${table} x`);result[table]=row;
 }return result;
});}
async function report(name:string,data:unknown){await writeFile(`artifacts/customer-commerce/p5-merge-${name}.json`,JSON.stringify({at:new Date().toISOString(),membershipId:purchase.membershipId,sourceCustomerId:state.sourceId,targetCustomerId:state.targetId,newStripePayment:false,productionChanged:false,data},null,2)+'\n');}
try{
 const [member]=await withTenant(tenant,tx=>tx<{customer_id:string;merged_into_id:string|null;display_name:string;phone_e164:string|null;email:string|null;snapshot:{terms:{serviceIds:string[]}}}[]>`select m.customer_id,m.snapshot,c.merged_into_id,c.display_name,c.phone_e164,c.email from customer_paid_memberships m join customers c on c.id=m.customer_id where m.id=${purchase.membershipId}`);
 if(!member)throw new Error('Original paid membership required');
 async function authenticated(){
  const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});if(!response.ok)throw new Error('Existing local owner login failed');
  const login=await response.json() as {access_token:string;expires_in:number;user:{id:string}};
  const [owner]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!owner)throw new Error('Existing QA owner required');
  return {login,headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':owner.id,'content-type':'application/json'}};
 }
 if(mode==='prepare-target'||mode==='prepare-service'){
  const {headers}=await authenticated();
  async function command<T>(name:string,input:unknown,suffix:string){const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,body:JSON.stringify({input,idempotencyKey:`native-merge:${state.key}:${suffix}`})});const out=await response.json() as {result:T;code?:string};if(!response.ok)throw new Error(`QA ${name}: ${response.status} ${out.code??''}`);return out.result;}
  if(mode==='prepare-target'){
   if(member.merged_into_id)throw new Error('Original identity already merged; verify before continuing');state.sourceId=member.customer_id;await save();
   if(!state.targetId){const created=await command<{customerId:string}>('customer.saveProfile',{name:'QA Merged Monthly Member',phoneE164:member.phone_e164,email:member.email},'target');state.targetId=created.customerId;await save();}
   if(!state.before){state.before=await financialSnapshot();await save();}
   console.log(JSON.stringify({prepared:true,sourceId:state.sourceId,targetId:state.targetId,sourceName:member.display_name,noFinancialWrite:true}));
  }else{
   if(!state.targetId||member.merged_into_id!==state.targetId)throw new Error('Native merge must be verified first');
   if(!state.ticketId){
    const [cycle]=await withTenant(tenant,tx=>tx`select id from customer_membership_cycles where membership_id=${purchase.membershipId} and status='issued' and starts_at<=now() and ends_at>now() and available_units='{[0,1)}'::int4multirange`);if(!cycle)throw new Error('Original available unit required');state.cycleId=cycle.id;
    const serviceId=member.snapshot.terms.serviceIds[0]!;
    const [staff]=await withTenant(tenant,tx=>tx`select sp.membership_id from staff_profiles sp join memberships m on m.id=sp.membership_id where sp.location_id=${tenant.locationId} and sp.is_bookable and m.status='active' and not exists(select 1 from service_skill_requirements r where r.location_id=${tenant.locationId} and r.service_id=${serviceId} and not exists(select 1 from staff_skills s where s.membership_id=m.id and s.skill_id=r.skill_id)) order by sp.membership_id limit 1`);if(!staff)throw new Error('Existing qualified staff required');state.staffId=staff.membership_id;await save();
    const ticket=await command<{ticketId:string;ticketItemIds:string[]}>('ticket.open',{customerId:state.targetId,items:[{serviceId,membershipId:state.staffId,priceCentsOverride:10000}]},'open');state.ticketId=ticket.ticketId;state.itemId=ticket.ticketItemIds[0]!;await save();
   }
   await command('ticket.startItem',{ticketItemId:state.itemId,membershipId:state.staffId},'start');await command('ticket.finishItem',{ticketItemId:state.itemId,membershipId:state.staffId},'finish');
   console.log(JSON.stringify({prepared:true,ticketId:state.ticketId,cycleId:state.cycleId,targetIdentity:true}));
  }
 }else if(mode==='open-desk'){
  const {login}=await authenticated(),saved=JSON.parse(await readFile('/tmp/commerce-day-final-auth.json','utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
  const origin=saved.origins.find(o=>o.origin==='http://localhost:5297'),token=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));if(!origin||!token)throw new Error('Existing owned auth state required');token.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
  const authPath='/tmp/commerce-merge-auth.json';await writeFile(authPath,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(authPath,0o600);browser(['state','load',authPath]);browser(['open',`http://localhost:5297/${state.ticketId?`checkout?ticketId=${state.ticketId}`:'customers'}`]);console.log(JSON.stringify({opened:true,credentialsPrinted:false}));
 }else if(mode==='install-loss'){
  if(!state.targetId||!state.sourceId)throw new Error('Prepare original and target first');
  console.log(JSON.stringify(evaluate(`(()=>{if(location.origin!=='http://localhost:5297')throw new Error('Local QA page required');const original=window.fetch.bind(window);let lost=false;window.fetch=async(...args)=>{const response=await original(...args);let request;try{request=JSON.parse(args[1]?.body??'null');}catch{}if(!lost&&String(args[0]).endsWith('/v1/commands/customer.merge')&&request?.input?.sourceCustomerId===${JSON.stringify(state.sourceId)}&&request?.input?.targetCustomerId===${JSON.stringify(state.targetId)}&&response.ok){lost=true;window.__mergeLoss={key:new Headers(args[1]?.headers).get('Idempotency-Key'),requestInput:request.input,originalHttpStatus:response.status};throw new Error('QA response lost after committed merge');}return response;};return {installed:true};})()`)));
 }else if(mode==='capture-loss'){
  const data=evaluate(`(()=>{const loss=window.__mergeLoss,pending=Object.keys(sessionStorage).filter(k=>k.startsWith('gf-customer-merge:')).map(k=>JSON.parse(sessionStorage.getItem(k))).find(p=>p.input?.targetCustomerId===${JSON.stringify(state.targetId)});if(!loss||!pending||loss.key!==pending.key||loss.originalHttpStatus!==201)throw new Error('Actual 201 and saved request required');return {...loss,saved:pending};})()`);await writeFile(attemptFile,JSON.stringify(data),{mode:0o600});await chmod(attemptFile,0o600);console.log(JSON.stringify({actual201Captured:true,originalRequestSaved:true}));
 }else if(mode==='observe-replay'){
  const attempt=JSON.parse(await readFile(attemptFile,'utf8'));console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/v1/commands/customer.merge')){const data=await response.clone().json();window.__mergeReplay={httpStatus:response.status,replayed:data.replayed,sameKey:new Headers(args[1]?.headers).get('Idempotency-Key')===${JSON.stringify(attempt.key)}};}return response;};return {observing:true};})()`)));
 }else if(mode==='verify-merge'){
  const replay=evaluate('window.__mergeReplay'),attempt=JSON.parse(await readFile(attemptFile,'utf8'));if(replay?.httpStatus!==200||!replay.replayed||!replay.sameKey||member.merged_into_id!==state.targetId||member.customer_id!==state.sourceId)throw new Error('Actual original merge replay required');
  const fingerprint=createHash('sha256').update(commerceFingerprint(customerMergeInput.parse(attempt.requestInput))).digest('hex');
  const [receipt]=await withTenant(tenant,tx=>tx`select input_fingerprint from command_idempotency where location_id=${tenant.locationId} and key=${attempt.key} and command='customer.merge'`);
  const [counts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from audit_log where command='customer.merge' and entity_id=${state.targetId!} and before->>'sourceCustomerId'=${state.sourceId!}) as merge_audits,(select count(*)::int from customer_membership_invoices where membership_id=${purchase.membershipId}) as invoices`);
  const after=await financialSnapshot();if(JSON.stringify(after)!==JSON.stringify(state.before)||receipt?.input_fingerprint!==fingerprint||counts?.merge_audits!==1||counts.invoices!==3)throw new Error('Merge changed original financial records or duplicated audit');
  await report('native-replay',{...replay,originalHttpStatus:201,refreshedRetry:true,originalFinancialRowsUnchanged:true,counts,facts:after});console.log(JSON.stringify({verified:true,...replay,originalFinancialRowsUnchanged:true,counts}));
 }else{
  if(!state.ticketId||!state.cycleId)throw new Error('Prepare service first');const returned=mode==='verify-return';
  const [facts]=await withTenant(tenant,tx=>tx`select t.customer_id,t.status,t.total_cents,t.refund_cents,
   (select available_units::text from customer_membership_cycles where id=${state.cycleId!}) as units,
   (select count(*)::int from customer_membership_ledger where ticket_id=t.id and entry='redeem') as uses,
   (select count(*)::int from customer_membership_ledger where ticket_id=t.id and entry='restore') as restores,
   (select coalesce(sum(amount_cents),0)::int from payments where ticket_id=t.id) as new_money,
   (select coalesce(sum(membership_cents),0)::int from ticket_refunds where ticket_id=t.id) as member_return,
   (select coalesce(sum(base_cents),0)::int from earnings where ticket_id=t.id and kind='commission') as commission_base,
   (select count(*)::int from customer_membership_invoices where membership_id=${purchase.membershipId}) as invoices,
   (select count(*)::int from customer_membership_cycles where membership_id=${purchase.membershipId} and status='planned') as future_cycles
   from tickets t where t.id=${state.ticketId}`);
  if(!facts||facts.customer_id!==state.targetId||facts.total_cents!==10000||facts.refund_cents!==(returned?10000:0)||facts.units!==(returned?'{[0,1)}':'{}')||facts.uses!==1||facts.restores!==(returned?1:0)||facts.new_money!==0||facts.member_return!==(returned?10000:0)||facts.commission_base!==(returned?0:9900)||facts.invoices!==3||facts.future_cycles!==2||member.customer_id!==state.sourceId)throw new Error('Original membership service conservation mismatch');
  await report(mode,{ticketId:state.ticketId,originalContractOwnerPreserved:true,facts});console.log(JSON.stringify({verified:true,mode,facts}));
 }
}finally{await closeDb();}
