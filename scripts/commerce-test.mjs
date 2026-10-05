// Disposable customer-commerce database. Never migrates or resets the source database.
// node --env-file=.env.local scripts/commerce-test.mjs migrate|test|db-test [vitest paths]
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const postgres = require('postgres');
const admin = new URL(process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? '');
const app = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
if (![admin, app].every(u => ['127.0.0.1', 'localhost'].includes(u.hostname))
  || admin.port==='55322' || app.port==='55322' || admin.host !== app.host || decodeURIComponent(admin.username) !== 'postgres'
  || decodeURIComponent(app.username) !== 'app_user') {
  throw new Error('Commerce tests require local PostgreSQL, postgres migration role and app_user runtime role');
}
const requestedAction = process.argv[2];
const resetsDatabase = ['test','db-test','rebuild'].includes(requestedAction);
const databaseName = process.env.COMMERCE_QA_DATABASE ?? (resetsDatabase?'gf_commerce_stage_ci':'gf_commerce_ci');
// Preserve the browser/sandbox database while a real payment is in progress.
if(!['gf_commerce_ci','gf_commerce_stage_ci'].includes(databaseName))throw new Error('Unknown disposable commerce database');
if(resetsDatabase&&databaseName==='gf_commerce_ci')throw new Error('Preserved sandbox database: tests and rebuild must use gf_commerce_stage_ci');
const env = { ...process.env, GF_TEST_NO_DOTENV: '1', DATABASE_TEST_TARGET: 'isolated',
  GF_QA_ALLOW_RESET: '1', NODE_ENV: 'test', SEED_SKIP_AUTH: '1',
  // Integration fixtures never contact email, SMS, or real customer services.
  EMAIL_PROVIDER: 'resend', COMMUNICATION_DELIVERY_MODE:'capture', GF_CUSTOMER_COMMERCE_ENABLED:'1',
  BOOKING_PAGE_ORIGIN:'https://book.geniefront.com',
  COMMERCE_STRIPE_MODE:'test',COMMERCE_STRIPE_SECRET_KEY:'', TEST_APP_DB_PASSWORD: process.env.TEST_APP_DB_PASSWORD ?? process.env.APP_DB_PASSWORD,
  APP_DB_PASSWORD:process.env.TEST_APP_DB_PASSWORD ?? process.env.APP_DB_PASSWORD };
const action = requestedAction==='rebuild'?'migrate':requestedAction;
if (action === 'migrate') {
  const connection = postgres(admin.href, { max: 1, onnotice: () => {} });
  try {
    if(requestedAction==='rebuild')await connection.unsafe(`drop database if exists ${databaseName} with (force)`);
    const existing = await connection`select datname from pg_database where datname = ${databaseName}`;
    if (!existing.length) await connection.unsafe(`create database ${databaseName}`);
  } finally { await connection.end(); }
}
admin.pathname = app.pathname = `/${databaseName}`;
Object.assign(env, { TEST_DATABASE_URL: app.href, TEST_MIGRATION_DATABASE_URL: admin.href,
  DATABASE_URL: app.href, MIGRATION_DATABASE_URL: admin.href });
if (action === 'migrate') {
  const isolated = postgres(admin.href, { max: 1, onnotice: () => {} });
  try {
    await isolated.unsafe(await readFile(new URL('../packages/db/test/bootstrap-postgres.sql', import.meta.url), 'utf8'));
  } finally { await isolated.end(); }
}
const extra = process.argv.slice(3);
const args = action === 'migrate' ? ['--import', 'tsx', 'packages/db/src/migrate.ts']
  : ['--filter', action === 'db-test' ? '@gf/db' : '@gf/api', 'test', ...extra];
if (!['migrate', 'test', 'db-test'].includes(action)) throw new Error('Expected migrate|test|db-test');
const result = spawnSync(action === 'migrate' ? process.execPath : 'pnpm', args, { env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
