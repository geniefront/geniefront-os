// Provision a dedicated local PostgreSQL container; never touches manual-QA or hosted databases.
import { randomBytes } from 'node:crypto';
import { writeFile,access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const file=new URL('../.env.commerce-ci',import.meta.url);
try {await access(file);console.log('Commerce test environment already exists: .env.commerce-ci');process.exit(0);}catch{}
const name='gf-customer-commerce-ci';
const existing=spawnSync('docker',['container','inspect',name],{stdio:'ignore'});
if(existing.status===0)throw new Error('Commerce container exists without its environment file; recover credentials or choose a new isolated fixture manually');
const adminPassword=randomBytes(24).toString('hex'),appPassword=randomBytes(24).toString('hex');
const base='127.0.0.1:58332/postgres';
await writeFile(file,`DATABASE_TEST_TARGET=isolated\nTEST_DATABASE_URL=postgresql://app_user:${appPassword}@${base}\nTEST_MIGRATION_DATABASE_URL=postgresql://postgres:${adminPassword}@${base}\nTEST_APP_DB_PASSWORD=${appPassword}\nGF_TEST_NO_DOTENV=1\nGF_QA_ALLOW_RESET=1\nNODE_ENV=test\n`,{mode:0o600,flag:'wx'});
const run=spawnSync('docker',['run','--detach','--name',name,'--label','geniefront.commerce-qa=1','--publish','127.0.0.1:58332:5432',
  '--env',`POSTGRES_PASSWORD=${adminPassword}`,'--env','POSTGRES_DB=postgres','public.ecr.aws/supabase/postgres:17.6.1.165'],{encoding:'utf8'});
if(run.status!==0)throw new Error('Commerce QA container startup failed; inspect docker status without printing environment secrets');
console.log('Created dedicated commerce QA container on 127.0.0.1:58332; credentials stored in ignored .env.commerce-ci');
