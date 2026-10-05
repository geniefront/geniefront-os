// Rehearse migration 187 against a private copy of the preserved real sandbox history. Never reset that source.
import {createRequire} from 'node:module';
import {open,chmod,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const require=createRequire(new URL('../packages/db/package.json',import.meta.url)),postgres=require('postgres');
const rootUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'');
if(process.env.DATABASE_TEST_TARGET!=='isolated'||rootUrl.hostname!=='127.0.0.1'||rootUrl.port!=='58332'||rootUrl.username!=='postgres')throw new Error('Dedicated local commerce QA required');
const source='gf_commerce_ci',target='gf_commerce_adjustment_upgrade_ci',container='gf-customer-commerce-ci',dump='/tmp/commerce-deposit-adjustment-upgrade.dump';
const sourceUrl=new URL(rootUrl);sourceUrl.pathname=`/${source}`;
const check=postgres(sourceUrl.href,{max:1,onnotice:()=>{}});
try{const [state]=await check`select (select count(*)::int from _migrations) as migrations,(select count(*)::int from commerce_payments) as payments,
 (select md5(string_agg(row_to_json(p)::text,'|' order by id)) from commerce_payments p) as fingerprint`;
 if(state.migrations!==186||state.payments!==18||state.fingerprint!=='32be213097fb73caafc211c2024b69b5')throw new Error('The original pre-187, 18-payment checkpoint is required');
}finally{await check.end();}
const file=await open(dump,'w',0o600);await chmod(dump,0o600);
try{const result=spawnSync('docker',['exec',container,'pg_dump','-U','postgres','-Fc',source],{stdio:['ignore',file.fd,'pipe'],encoding:'utf8'});
 if(result.status!==0)throw new Error('Private sandbox snapshot failed');}finally{await file.close();}
const maintenance=new URL(rootUrl);maintenance.pathname='/postgres';const admin=postgres(maintenance.href,{max:1,onnotice:()=>{}});
try{await admin.unsafe(`drop database if exists ${target} with (force)`);await admin.unsafe(`create database ${target}`);}finally{await admin.end();}
const input=await open(dump,'r');try{const restored=spawnSync('docker',['exec','-i',container,'pg_restore','-U','postgres','-d',target],{stdio:[input.fd,'pipe','pipe'],encoding:'utf8'});
 if(restored.status!==0)throw new Error('Private sandbox restore failed');}finally{await input.close();await unlink(dump);}
const targetUrl=new URL(rootUrl);targetUrl.pathname=`/${target}`;
async function facts(){const sql=postgres(targetUrl.href,{max:1,onnotice:()=>{}});try{
 const tables={};for(const table of ['commerce_payments','commerce_orders','commerce_refunds','commerce_deposit_ledger','commerce_appointment_holds','payments','ticket_refunds']){
  const remove=table==='commerce_appointment_holds'?['has_confirmed_booking']:table==='payments'?['deposit_commerce_payment_id']:[];
  const [row]=await sql`select count(*)::int as count,md5(string_agg((to_jsonb(t)-${remove}::text[])::text,'|' order by id)) as hash from ${sql(table)} t`;tables[table]=row;
 }
 const [m]=await sql`select count(*)::int as count from _migrations`;return {migrations:m.count,tables};
}finally{await sql.end();}}
const before=await facts();
const env={...process.env,GF_TEST_NO_DOTENV:'1',MIGRATION_DATABASE_URL:targetUrl.href,TEST_MIGRATION_DATABASE_URL:targetUrl.href,APP_DB_PASSWORD:process.env.TEST_APP_DB_PASSWORD};
for(let run=0;run<2;run++){const result=spawnSync(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env,encoding:'utf8'});if(result.status!==0)throw new Error(`Copied migration run ${run+1} failed`);}
const after=await facts();if(before.migrations!==186||after.migrations!==187||JSON.stringify(before.tables)!==JSON.stringify(after.tables))throw new Error('Original financial history changed during upgrade');
const sql=postgres(targetUrl.href,{max:1,onnotice:()=>{}});let projection;
try{[projection]=await sql`select
 (select count(*)::int from commerce_appointment_holds where order_id is not null) as initial_orders,
 (select count(*)::int from commerce_deposit_requests) as requests,
 not exists(select 1 from commerce_appointment_holds h left join commerce_deposit_requests r on r.order_id=h.order_id
  where h.order_id is not null and (r.hold_id is distinct from h.id or r.org_id<>h.org_id or r.location_id<>h.location_id or r.purpose<>'initial')) as requests_match_original_contract,
 (select count(*)::int from commerce_deposit_requotes) as fabricated_requotes,
 not exists(select 1 from payments p join commerce_appointment_holds h on h.id=p.deposit_hold_id join commerce_payments cp on cp.order_id=h.order_id
  where p.method='deposit' and p.deposit_commerce_payment_id is distinct from cp.id) as service_sources_match_original_payment,
 (select count(*)::int from pg_class where relname in('commerce_deposit_requests','commerce_deposit_requotes') and relrowsecurity and relforcerowsecurity) as protected_new_tables,
 not has_table_privilege('app_user','commerce_deposit_requotes','UPDATE,DELETE,TRUNCATE') as quotes_append_only,
 not has_table_privilege('anon','commerce_deposit_requests','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated','commerce_deposit_requests','SELECT,INSERT,UPDATE,DELETE') as requests_private`;
 if(projection.requests!==projection.initial_orders||!projection.requests_match_original_contract||projection.fabricated_requotes!==0||!projection.service_sources_match_original_payment
  ||projection.protected_new_tables!==2||!projection.quotes_append_only||!projection.requests_private)throw new Error('Deposit source projection or isolation failed');
}finally{await sql.end();}
const report={at:new Date().toISOString(),sourceDatabase:source,copyDatabase:target,sourceNotReset:true,actualExecutorReplayPassed:true,before,after,projection,
 actualNativePaymentsPreserved:18,migrationPromotedToPreservedDatabase:false,productionPublished:false};
await writeFile('artifacts/customer-commerce/p3-adjustments-populated-upgrade.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({verified:true,sourceNotReset:true,oldMigrations:before.migrations,newMigrations:after.migrations,originalPayments:18,projection}));
