// Replays current real sandbox receipts in Playwright; never creates, resets, or fabricates financial facts.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332'||process.env.DATABASE_TEST_TARGET!=='isolated')throw new Error('Dedicated preserved sandbox required');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local Auth and test mode required');
process.env.COMMUNICATION_DELIVERY_MODE='capture';
const path='/tmp/gf-commerce-e2e-private.json',tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const {withTenant,closeDb}=await import('../packages/db/src/index');
const {unwrapManageToken}=await import('../apps/api/src/public/bookingToken');
const report=async(name:string)=>JSON.parse(await readFile(`artifacts/customer-commerce/${name}.json`,'utf8'));
const tables=['commerce_payments','commerce_refunds','customer_credit_ledger','customer_package_ledger','customer_membership_invoices','customer_membership_cycles','customer_membership_ledger','commerce_deposit_ledger','payments','ticket_refunds'];
async function money(){return withTenant(tenant,async tx=>{const out:Record<string,unknown>={};for(const table of tables){const [row]=await tx.unsafe(`select count(*)::int as count,md5(string_agg(to_jsonb(x)::text,'|' order by id)) as hash from ${table} x`);out[table]=row;}return out;});}
let exitCode=1;
try{
 const before=await money(),identities:Record<string,unknown>={},secrets:string[]=[];
 for(const [role,email] of [['owner','qa-local-owner@example.test'],['tech','qa-local-tech@example.test']] as const){
  const r=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email,password:process.env.GF_BASELINE_PASSWORD})});if(!r.ok)throw new Error(`Local ${role} login failed`);const login=await r.json() as any;
  const [membership]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!membership)throw new Error('Existing local role mapping required');
  identities[role]={cookies:[],origins:[{origin:'http://localhost:5297',localStorage:[{name:'sb-127-auth-token',value:JSON.stringify(login)},{name:'gf.lang',value:'en'},{name:'gf.membershipId',value:membership.id}]}]};secrets.push(login.access_token,login.refresh_token);
 }
 const expired=await report('p3-native-expiry-expired'),paid=await report('p3-pending-requote-paid'),pkg=await report('p2-package-payout-purchase'),member=await report('p4-access-native'),unlimited=await report('p2-unlimited-native');
 async function appointmentToken(id:string){const [a]=await withTenant(tenant,tx=>tx`select manage_token_wrapped,manage_token_digest from appointments where id=${id}`);const token=a&&unwrapManageToken(a.manage_token_wrapped,a.manage_token_digest);if(!token)throw new Error('Original private appointment link required');return token;}
 const expiredToken=await appointmentToken(expired.appointmentId),paidToken=await appointmentToken(paid.appointmentId);
 async function receipt(orderId:string){const notices=await withTenant(tenant,tx=>tx`select body_text from email_outbox where commerce_order_id=${orderId} and entity_type='commerce_purchase_buyer' and status='captured' order by created_at desc`);for(const n of notices){const raw=String(n.body_text).split('\n').find(v=>v.startsWith('http://localhost:5296/')&&v.includes('#c/'));if(raw){const u=new URL(raw);if(u.origin!=='http://localhost:5296'||u.searchParams.get('order')!==orderId)throw new Error('Receipt scope mismatch');secrets.push(u.hash.slice(3));return raw;}}throw new Error('Original captured receipt required');}
 const [m]=await withTenant(tenant,tx=>tx`select id,manage_token_wrapped,manage_token_hash,provider_status from customer_paid_memberships where id=${member.membershipId}`);if(!m||m.provider_status!=='canceled')throw new Error('Original ended member required');const token=unwrapManageToken(m.manage_token_wrapped,m.manage_token_hash);if(!token)throw new Error('Current private membership link required');
 const profile={identities,bookingBase:'http://localhost:5296',deskBase:'http://localhost:5297',apiBase:'http://127.0.0.1:3087',slug:'golden-foot',expiredUrl:`http://localhost:5296/l/golden-foot#g/${expiredToken}`,paidUrl:`http://localhost:5296/l/golden-foot#g/${paidToken}`,packageUrl:await receipt(pkg.orderId),unlimitedUrl:await receipt(unlimited.orderId),membershipUrl:`http://localhost:5296/golden-foot/memberships?member=${m.id}#m/${token}`};
 secrets.push(expiredToken,paidToken,token);
 await writeFile(path,JSON.stringify(profile),{mode:0o600});await chmod(path,0o600);
 const child=spawnSync('pnpm',['exec','playwright','test','--config=playwright.commerce.config.ts',...process.argv.slice(2)],{env:{...process.env,COMMERCE_E2E_PROFILE_PATH:path},encoding:'utf8',maxBuffer:10*1024*1024});
 const redact=(input:string)=>secrets.filter(Boolean).reduce((s,value)=>s.split(value).join('[private credential redacted]'),input);
 await writeFile('artifacts/customer-commerce/p6-e2e-output.txt',redact((child.stdout??'')+(child.stderr??'')));
 try{const report=await readFile('artifacts/customer-commerce/p6-e2e-report.json','utf8');await writeFile('artifacts/customer-commerce/p6-e2e-report.json',redact(report));}catch{}
 const after=await money(),unchanged=JSON.stringify(before)===JSON.stringify(after);
 const evidence={at:new Date().toISOString(),suite:'preserved sandbox read-only browser replay',exitCode:child.status,financialTablesCompared:tables.length,financialFactsUnchanged:unchanged,before,after,syntheticProviderEvents:false,newPaymentOrRefund:false,databaseReset:false,delivery:'capture',productionPublished:false};
 await writeFile('artifacts/customer-commerce/p6-e2e-preservation.json',JSON.stringify(evidence,null,2)+'\n');
 if(!unchanged)throw new Error('Financial state changed during read-only browser verification');exitCode=child.status??1;
 console.log(JSON.stringify({exitCode,financialTablesCompared:tables.length,financialFactsUnchanged:unchanged,output:'artifacts/customer-commerce/p6-e2e-output.txt'}));
}finally{await closeDb();}
process.exitCode=exitCode;
