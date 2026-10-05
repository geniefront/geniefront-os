// Actual upgrade rehearsal in a second disposable database, independent of browser fixtures.
// node --env-file=.env.commerce-ci scripts/commerce-migration-check.mjs
import {createRequire} from 'node:module';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const require=createRequire(new URL('../packages/db/package.json',import.meta.url));const postgres=require('postgres');
const original=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'');
if(process.env.DATABASE_TEST_TARGET!=='isolated'||original.hostname!=='127.0.0.1'||original.port!=='58332'||original.username!=='postgres')throw new Error('Dedicated commerce QA container required');
const name='gf_commerce_upgrade_ci',migration='20260930154700_customer_commerce.sql';
const maintenance=new URL(original);maintenance.pathname='/postgres';
const root=postgres(maintenance.href,{max:1,onnotice:()=>{}});
try {await root.unsafe(`drop database if exists ${name} with (force)`);await root.unsafe(`create database ${name}`);}finally{await root.end();}
const upgraded=new URL(original);upgraded.pathname=`/${name}`;
const c=postgres(upgraded.href,{max:1,onnotice:()=>{}});
const base=new URL('../packages/db/',import.meta.url);
let report;
try {
  await c.unsafe(await readFile(new URL('test/bootstrap-postgres.sql',base),'utf8'));
  await c`create table _migrations(name text primary key,applied_at timestamptz not null default now())`;
  let previous=0;
  for(const dir of ['drizzle','sql'])for(const file of (await readdir(new URL(`${dir}/`,base))).filter(f=>f.endsWith('.sql')&&(dir==='drizzle'||f<migration)).sort()){
    await c.unsafe(await readFile(new URL(`${dir}/${file}`,base),'utf8'));
    await c`insert into _migrations(name) values(${`${dir}/${file}`})`;previous++;
  }
  const uid='99000000-0000-4000-8000-000000000001',org='99000000-0000-4000-8000-000000000002',loc='99000000-0000-4000-8000-000000000003';
  await c`insert into users(id,email) values(${uid},'commerce-migration@example.test')`;
  await c`insert into organizations(id,name,owner_user_id) values(${org},'Commerce migration fixture',${uid})`;
  await c`insert into locations(id,org_id,name,slug,timezone,business_type,status) values(${loc},${org},'{}'::jsonb,'commerce-upgrade','America/New_York','foot_spa','active')`;
  const [customer]=await c`insert into customers(org_id,primary_location_id,display_name) values(${org},${loc},'Commerce upgrade fixture') returning id`;
  const [tpl]=await c`insert into package_templates(org_id,location_id,name,price_cents,sessions,valid_days) values(${org},${loc},'{}'::jsonb,50000,10,365) returning id`;
  const [pkg]=await c`insert into customer_packages(org_id,location_id,template_id,customer_id,total_sessions,remaining_sessions)
    values(${org},${loc},${tpl.id},${customer.id},10,9) returning id`;
  await c`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,customer_id,entry,amount_cents,balance_after_cents)
    values(${org},${loc},'package',${pkg.id},${customer.id},'issue',50000,50000),(${org},${loc},'package',${pkg.id},${customer.id},'redeem',-1,9)`;
  const before=await c`select entry,amount_cents,balance_after_cents from customer_credit_ledger where subject_id=${pkg.id} order by seq`;
  const additions=(await readdir(new URL('sql/',base))).filter(f=>f.endsWith('.sql')&&f>=migration).sort();
  for(const file of additions){
    await c.unsafe(await readFile(new URL(`sql/${file}`,base),'utf8'));
    await c`insert into _migrations(name) values(${`sql/${file}`})`;
  }
  const after=await c`select entry,amount_cents,balance_after_cents,unit from customer_credit_ledger where subject_id=${pkg.id} order by seq`;
  const [asset]=await c`select remaining_sessions,purchase_snapshot from customer_packages where id=${pkg.id}`;
  const [opening]=await c`select sum(quantity)::int as quantity,count(*)::int as rows from customer_package_ledger where package_id=${pkg.id}`;
  const [payments]=await c`select count(*)::int as n from commerce_payments`;
  const [security]=await c`select not has_function_privilege('anon','commerce_internal.pending_tenants()','execute') as discovery_private,
    (select count(*)::int from pg_class where relname like 'commerce_%' and relkind='r' and relrowsecurity and relforcerowsecurity) as protected_tables,
    (select relrowsecurity and relforcerowsecurity from pg_class where oid='appointment_guest_cancellations'::regclass) as guest_cancellations_rls,
    not has_table_privilege('app_user','appointment_guest_cancellations','UPDATE,DELETE,TRUNCATE') as guest_history_append_only,
    not has_table_privilege('app_user','commerce_deposit_retentions','UPDATE,DELETE,TRUNCATE') as retention_history_append_only,
    not has_table_privilege('app_user','commerce_deposit_retention_releases','UPDATE,DELETE,TRUNCATE') as release_history_append_only,
    (select count(*)::int from appointment_guest_cancellations) as fabricated_guest_cancellations,
    (select count(*)::int from pg_class where relname in('ticket_settlement_sources','ticket_source_receipts','ticket_source_refunds') and relrowsecurity and relforcerowsecurity) as protected_source_tables,
    not exists(select 1 from unnest(array['ticket_settlement_sources','ticket_source_receipts','ticket_source_refunds'])n where has_table_privilege('app_user',n,'UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon',n,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',n,'SELECT,INSERT,UPDATE,DELETE')) as source_grants_restricted,
    (select count(*)::int from ticket_settlement_sources) as fabricated_sources,
    (select count(*)::int from pg_class where relname in('ticket_item_settlements','ticket_item_source_allocations','ticket_item_source_returns','ticket_item_commission_sources','ticket_item_commission_returns','ticket_item_graph_receipts') and relrowsecurity and relforcerowsecurity) as protected_item_tables,
    not exists(select 1 from unnest(array['ticket_item_settlements','ticket_item_source_allocations','ticket_item_source_returns','ticket_item_commission_sources','ticket_item_commission_returns','ticket_item_graph_receipts'])n where has_table_privilege('app_user',n,'UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon',n,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',n,'SELECT,INSERT,UPDATE,DELETE')) as item_grants_restricted`;
  if(JSON.stringify(before)!==JSON.stringify(after.map(({unit,...row})=>row))||asset.remaining_sessions!==9||opening.quantity!==9||opening.rows!==1||payments.n!==0
    ||asset.purchase_snapshot.paymentVerified!==false||asset.purchase_snapshot.rulesProven!==false||asset.purchase_snapshot.amountCents!==50000
    ||!security.discovery_private||security.protected_tables!==17||!security.guest_cancellations_rls
    ||!security.guest_history_append_only||!security.retention_history_append_only||!security.release_history_append_only||security.fabricated_guest_cancellations!==0
    ||security.protected_source_tables!==3||!security.source_grants_restricted||security.fabricated_sources!==0||security.protected_item_tables!==6||!security.item_grants_restricted)throw new Error('Customer commerce upgrade invariants failed');
  report={date:new Date().toISOString(),previousMigrations:previous,migrations:additions,legacyLedgerUnchanged:true,legacyRemaining:9,
    units:after.map(r=>r.unit),legacySource:asset.purchase_snapshot.origin,originalPurchaseRulesClaimed:false,
    fakePaymentsCreated:payments.n,quantityOpeningRows:opening.rows,security};
}finally{await c.end();}
const env={...process.env,MIGRATION_DATABASE_URL:upgraded.href,APP_DB_PASSWORD:process.env.TEST_APP_DB_PASSWORD};
const replay=spawnSync(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env,encoding:'utf8'});
if(replay.status!==0)throw new Error(`Actual migration executor replay failed: ${replay.stderr}`);
report.actualExecutorReplayPassed=true;
// Independently exercise the actual executor from an empty database, preserving both live sandbox facts and stage tests.
const emptyName='gf_commerce_empty_ci',emptyUrl=new URL(original);emptyUrl.pathname=`/${emptyName}`;
const emptyRoot=postgres(maintenance.href,{max:1,onnotice:()=>{}});
try{await emptyRoot.unsafe(`drop database if exists ${emptyName} with (force)`);await emptyRoot.unsafe(`create database ${emptyName}`);}
finally{await emptyRoot.end();}
const empty=postgres(emptyUrl.href,{max:1,onnotice:()=>{}});
try{await empty.unsafe(await readFile(new URL('test/bootstrap-postgres.sql',base),'utf8'));}finally{await empty.end();}
const emptyEnv={...env,MIGRATION_DATABASE_URL:emptyUrl.href};
for(let run=0;run<2;run++){
  const result=spawnSync(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env:emptyEnv,encoding:'utf8'});
  if(result.status!==0)throw new Error(`Empty executor run ${run+1} failed: ${result.stderr}`);
}
const emptyCheck=postgres(emptyUrl.href,{max:1,onnotice:()=>{}});
try{
  const [counts]=await emptyCheck`select (select count(*)::int from _migrations) as migrations,
    (select count(*)::int from commerce_payments) as payments,
    (select count(*)::int from pg_class where relname like 'commerce_%' and relkind='r' and relrowsecurity and relforcerowsecurity) as protected_tables,
    (select relrowsecurity and relforcerowsecurity from pg_class where oid='appointment_guest_cancellations'::regclass) as guest_cancellations_rls,
    not has_table_privilege('app_user','appointment_guest_cancellations','UPDATE,DELETE,TRUNCATE') as guest_history_append_only,
    not has_table_privilege('app_user','commerce_deposit_retentions','UPDATE,DELETE,TRUNCATE') as retention_history_append_only,
    not has_table_privilege('app_user','commerce_deposit_retention_releases','UPDATE,DELETE,TRUNCATE') as release_history_append_only,
    (select count(*)::int from pg_class where relname in('ticket_settlement_sources','ticket_source_receipts','ticket_source_refunds') and relrowsecurity and relforcerowsecurity) as protected_source_tables,
    not exists(select 1 from unnest(array['ticket_settlement_sources','ticket_source_receipts','ticket_source_refunds'])n where has_table_privilege('app_user',n,'UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon',n,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',n,'SELECT,INSERT,UPDATE,DELETE')) as source_grants_restricted,
    (select count(*)::int from pg_class where relname in('ticket_item_settlements','ticket_item_source_allocations','ticket_item_source_returns','ticket_item_commission_sources','ticket_item_commission_returns','ticket_item_graph_receipts') and relrowsecurity and relforcerowsecurity) as protected_item_tables,
    not exists(select 1 from unnest(array['ticket_item_settlements','ticket_item_source_allocations','ticket_item_source_returns','ticket_item_commission_sources','ticket_item_commission_returns','ticket_item_graph_receipts'])n where has_table_privilege('app_user',n,'UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon',n,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',n,'SELECT,INSERT,UPDATE,DELETE')) as item_grants_restricted`;
  if(counts.migrations!==report.previousMigrations+report.migrations.length||counts.payments!==0||counts.protected_tables!==17
    ||!counts.guest_cancellations_rls||!counts.guest_history_append_only||!counts.retention_history_append_only||!counts.release_history_append_only||counts.protected_source_tables!==3||!counts.source_grants_restricted||counts.protected_item_tables!==6||!counts.item_grants_restricted)throw new Error('Empty migration invariants failed');
  report.emptyDatabase={actualExecutorPassed:true,replayPassed:true,...counts};
}finally{await emptyCheck.end();}
await mkdir(new URL('../artifacts/customer-commerce/',import.meta.url),{recursive:true});
const prefix=process.env.COMMERCE_MIGRATION_EVIDENCE_PREFIX??'';
if(prefix&&!/^[a-z0-9-]+$/.test(prefix))throw new Error('Invalid evidence prefix');
await writeFile(new URL(`../artifacts/customer-commerce/${prefix?prefix+'-':''}migration-upgrade.json`,import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
