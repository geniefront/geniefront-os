// Populated upgrade rehearsal: clone only the disposable stage DB; never reset preserved sandbox facts.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../packages/db/package.json',import.meta.url)),postgres=require('postgres');
const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'');
if(process.env.DATABASE_TEST_TARGET!=='isolated'||url.hostname!=='127.0.0.1'||url.port!=='58332'||url.username!=='postgres')throw new Error('Dedicated local QA required');
const target='gf_commerce_invoice_upgrade_ci',maintenance=new URL(url);maintenance.pathname='/postgres';
const root=postgres(maintenance.href,{max:1,onnotice:()=>{}});
try{await root.unsafe(`drop database if exists ${target} with(force)`);await root.unsafe(`create database ${target} template gf_commerce_stage_ci`);}finally{await root.end();}
url.pathname=`/${target}`;const sql=postgres(url.href,{max:1,onnotice:()=>{}});
const migration='sql/20261002163511_membership_invoice_contracts.sql';
async function snapshot(){const result={};for(const table of ['customer_membership_invoices','customer_membership_cycles','customer_membership_ledger','customer_paid_memberships','commerce_orders','commerce_payments']){
 const [r]=await sql.unsafe(`select count(*)::int as count,md5(string_agg(${table==='customer_membership_invoices'?"(to_jsonb(x)-array['plan_version_id','snapshot','stripe_price_id'])":"to_jsonb(x)"}::text,'|' order by id)) as hash from ${table} x`);result[table]=r;}return result;}
try{
 const before=await snapshot();if(before.customer_membership_invoices.count<2)throw new Error('Run the isolated membership test suite first; historical paid invoices are required');
 // Reproduce the previous invoice shape on this disposable clone, then exercise the exact pending migration.
 await sql`alter table customer_membership_invoices drop column plan_version_id,drop column snapshot,drop column stripe_price_id`;
 await sql`delete from _migrations where name=${migration}`;
 await sql.unsafe(await readFile(new URL(`../packages/db/${migration}`,import.meta.url),'utf8'));
 await sql`insert into _migrations(name) values(${migration})`;
 const after=await snapshot();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original invoice/contract/payment/unit facts changed');
 const [proof]=await sql`select count(*)::int as invoices,
  count(*) filter(where i.snapshot=m.snapshot and i.plan_version_id=m.plan_version_id and i.stripe_price_id=m.stripe_price_id)::int as proven_original_contracts,
  (select tgenabled from pg_trigger where tgrelid='customer_membership_invoices'::regclass and tgname='customer_membership_invoices_append_only') as append_only_trigger
  from customer_membership_invoices i join customer_paid_memberships m on m.id=i.membership_id`;
 if(proof.invoices!==proof.proven_original_contracts||proof.append_only_trigger!=='O')throw new Error('Original contracts or append-only enforcement were not restored');
 const report={at:new Date().toISOString(),disposableClone:target,source:'gf_commerce_stage_ci',originalFinancialFieldsUnchanged:true,preservedSandboxTouched:false,before,proof,migration};
 await writeFile(new URL('../artifacts/customer-commerce/p4-invoice-contract-populated-upgrade.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({verified:true,...proof,preservedSandboxTouched:false}));
}finally{await sql.end();}
