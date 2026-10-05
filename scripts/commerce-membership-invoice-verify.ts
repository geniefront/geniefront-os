// Read-only checkpoint of the original sandbox memberships after invoice-contract migration.
import {readFile,writeFile} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332')throw new Error('Preserved local QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';assertRegressionTarget(process.env);if(process.env.COMMERCE_STRIPE_MODE!=='test')throw new Error('Sandbox only');
const {withTenant,closeDb}=await import('../packages/db/src/index'),{unwrapManageToken}=await import('../apps/api/src/public/bookingToken');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
try{
 const results=[];
 for(const path of ['/tmp/commerce-membership-browser-private.json','/tmp/commerce-membership-year-browser-private.json','/tmp/commerce-membership-discount-browser-private.json']){
  const original=JSON.parse(await readFile(path,'utf8')) as {membershipId:string};
  const [m]=await withTenant(tenant,tx=>tx`select id,snapshot,manage_token_wrapped,manage_token_hash from customer_paid_memberships where id=${original.membershipId}`);if(!m)throw new Error('Original membership required');
  const invoices=await withTenant(tenant,tx=>tx`select i.id,i.snapshot,i.plan_version_id,i.stripe_price_id,
   i.snapshot=m.snapshot and i.plan_version_id=m.plan_version_id and i.stripe_price_id=m.stripe_price_id as matches_original
   from customer_membership_invoices i join customer_paid_memberships m on m.id=i.membership_id where i.membership_id=${m.id}`);
  if(!invoices.length||invoices.some(i=>!i.matches_original))throw new Error('Original invoice contracts required');
  const token=unwrapManageToken(m.manage_token_wrapped,m.manage_token_hash);if(!token)throw new Error('Existing protected resource link required');
  const response=await fetch(`http://127.0.0.1:3087/v1/public/shops/golden-foot/commerce/memberships/${m.id}`,{headers:{'x-gf-commerce-token':token}});
  const data=await response.json() as {invoices:Array<{id:string;snapshot:unknown;plan_version_id:string}>;cycles:Array<{id:string;snapshot:unknown;plan_version_id:string;available_quantity:number;quantity:number}>};
  if(!response.ok||data.invoices.length!==invoices.length||data.invoices.some(i=>!invoices.some(original=>original.id===i.id&&original.plan_version_id===i.plan_version_id&&JSON.stringify(original.snapshot)===JSON.stringify(i.snapshot)))
   ||data.cycles.some(c=>!invoices.some(i=>i.plan_version_id===c.plan_version_id&&JSON.stringify(i.snapshot)===JSON.stringify(c.snapshot))))throw new Error('HTTP funded-period contracts mismatch');
  results.push({membershipId:m.id,httpStatus:response.status,invoices:invoices.length,cycles:data.cycles.length,availableUnits:data.cycles.reduce((n,c)=>n+c.available_quantity,0),allContractsMatchOriginal:true});
 }
 const [payments]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash from commerce_payments p`);
 if(payments!.count!==14||payments!.hash!=='99c54d5375794365efd655bf0a22cfda')throw new Error('Original payment facts changed');
 const report={at:new Date().toISOString(),readonly:true,migration:183,results,payments,originalTokensReused:true,newStripePayment:false,planChangeScheduled:false,productionPublished:false};
 await writeFile('artifacts/customer-commerce/p4-invoice-contract-native-read.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await closeDb();}
