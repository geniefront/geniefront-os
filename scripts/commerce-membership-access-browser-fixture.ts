// Native operator access replacement on the original ended sandbox member. Delivery stays captured; no new purchase.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332'||process.env.DATABASE_TEST_TARGET!=='isolated')throw new Error('Preserved QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
const mode=process.argv[2],path='/tmp/commerce-membership-access-private.json',session='commerce-access-desk',customerSession='commerce-access-customer',purchase=JSON.parse(await readFile('/tmp/commerce-membership-browser-private.json','utf8'));
let state:any;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID()};}
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index'),{unwrapManageToken}=await import('../apps/api/src/public/bookingToken');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
function browser(args:string[],input?:string,chosen=session){const r=spawnSync(process.execPath,['/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js','--session',chosen,...args],{encoding:'utf8',...(input?{input}:{})});if(r.status!==0)throw new Error('Native browser failed');return r.stdout.trim();}
function evaluate(code:string){return JSON.parse(browser(['eval','--stdin'],code));}
async function facts(){return withTenant(tenant,async tx=>{const out:Record<string,unknown>={};for(const table of ['commerce_payments','commerce_refunds','customer_membership_invoices','customer_membership_cycles','customer_membership_ledger']){const [r]=await tx.unsafe(`select count(*)::int as count,md5(string_agg(to_jsonb(x)::text,'|' order by id)) as hash from ${table} x`);out[table]=r;}return out;});}
try{
 const [m]=await withTenant(tenant,tx=>tx`select m.*,l.slug from customer_paid_memberships m join locations l on l.id=m.location_id where m.id=${purchase.membershipId}`);
 if(!m||m.livemode||m.original_order_id!==purchase.orderId||m.provider_status!=='canceled')throw new Error('Original ended membership required');
 const token=unwrapManageToken(m.manage_token_wrapped,m.manage_token_hash);if(!token)throw new Error('Wrapped credential required');
 if(mode==='prepare'){
  if(!state.before){state.before=await facts();state.oldToken=token;state.oldVersion=m.manage_access_version;state.extendedExpiry=m.manage_token_expires_at;state.memberId=m.id;state.slug=m.slug;await save();}
  console.log(JSON.stringify({prepared:true,extendedExpiry:m.manage_token_expires_at,originalVersion:state.oldVersion,tokenPrinted:false}));
 }else if(mode==='install-loss'){
  console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);let lost=false;window.fetch=async(...args)=>{const response=await original(...args);if(!lost&&String(args[0]).endsWith('/commerce.manageMembershipAccess')&&response.ok){lost=true;window.__accessLoss={key:new Headers(args[1]?.headers).get('Idempotency-Key'),status:response.status,result:await response.clone().json()};throw new Error('QA lost real access management response');}return response;};return {installed:true};})()`)));
 }else if(mode==='capture-loss'){state.loss=evaluate('window.__accessLoss');if(state.loss?.status!==200&&state.loss?.status!==201||!state.loss?.key)throw new Error('Actual successful mutation loss required');await save();console.log(JSON.stringify({captured:true,status:state.loss.status}));
 }else if(mode==='observe-replay'){
  console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/commerce.manageMembershipAccess'))window.__accessReplay={status:response.status,result:await response.clone().json(),sameKey:new Headers(args[1]?.headers).get('Idempotency-Key')===${JSON.stringify(state.loss.key)}};return response;};return {observing:true};})()`)));
 }else if(mode==='check-revoked'){
  if(!m.manage_token_revoked_at||m.manage_access_version!==state.oldVersion+1)throw new Error('Native revoke required');const r=await fetch(`http://127.0.0.1:3087/v1/public/shops/${m.slug}/commerce/memberships/${m.id}`,{headers:{'x-gf-commerce-token':state.oldToken}});if(r.status!==404)throw new Error('Revoked credential still readable');state.revokedVerified=true;await save();console.log(JSON.stringify({revoked:true,oldTokenStatus:404,version:m.manage_access_version}));
 }else if(mode==='open-new'){
  const [notice]=await withTenant(tenant,tx=>tx`select body_text,status from email_outbox where entity_type='customer_membership_access' and commerce_order_id=${m.original_order_id} order by created_at desc limit 1`);
  const link=notice?.body_text.match(/https?:\/\/[^\s]+#m\/cm_[A-Za-z0-9_-]{43}/)?.[0];if(!link||notice.status!=='captured'||new URL(link).origin!=='http://localhost:5296'||!link.endsWith(token)||token===state.oldToken)throw new Error('Captured new private link required');
  browser(['open',link],undefined,customerSession);console.log(JSON.stringify({openedCapturedLink:true,tokenPrinted:false}));
 }else if(mode==='recover-existing'){
  if(token===state.oldToken)throw new Error('Replacement token required');
  const result=browser(['eval','--stdin'],`(()=>{if(location.origin!=='http://localhost:5296')throw new Error('Owned booking origin required');window.location.hash=${JSON.stringify(`#m/${token}`)};return {replacementFragmentApplied:true};})()`, 'commerce-withdraw-native');
  console.log(JSON.stringify({replacementAppliedInExistingTab:true,tokenPrinted:false}));
 }else if(mode==='verify'){
  const after=await facts();if(!state.revokedVerified||JSON.stringify(after)!==JSON.stringify(state.before)||m.manage_token_revoked_at||m.manage_access_version!==state.oldVersion+2||token===state.oldToken)throw new Error('Access replacement or financial preservation failed');
  const endpoint=`http://127.0.0.1:3087/v1/public/shops/${m.slug}/commerce/memberships/${m.id}`,old=await fetch(endpoint,{headers:{'x-gf-commerce-token':state.oldToken}}),fresh=await fetch(endpoint,{headers:{'x-gf-commerce-token':token}});if(old.status!==404||fresh.status!==200)throw new Error('Credential isolation failed');
  const [counts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from email_outbox where entity_type='customer_membership_access' and commerce_order_id=${m.original_order_id} and status='captured') as notices,(select count(*)::int from audit_log where command='commerce.manageMembershipAccess' and entity_id=${m.id}) as requests`);
  const replay=evaluate('window.__accessReplay');if(!replay.sameKey||!replay.result.replayed||counts!.notices!==1||counts!.requests!==2)throw new Error('Native replay or notice count mismatch');
  const report={at:new Date().toISOString(),membershipId:m.id,extendedExpiry:m.manage_token_expires_at,accessVersion:m.manage_access_version,nativeRevocationOldTokenStatus:404,replacedOldTokenStatus:old.status,newTokenStatus:fresh.status,capturedNotices:counts!.notices,successfulAccessCommands:counts!.requests,nativeLossStatus:state.loss.status,nativeReplay:{status:replay.status,sameKey:replay.sameKey,replayed:replay.result.replayed},originalFinancialFactsUnchanged:true,financialFacts:after,originalProviderStatus:m.provider_status,originalSubscriptionReused:true,noNewPaymentOrRefund:true,realEmailSent:false,productionPublished:false};await writeFile('artifacts/customer-commerce/p4-access-native.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }else throw new Error('Unknown mode');
}finally{await closeDb();}
