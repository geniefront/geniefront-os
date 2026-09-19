// Runs migrations or integration suites only against a disposable local database.
// Invoke with: node --env-file=.env.local scripts/test-voice-local.mjs migrate|test
import { spawnSync } from 'node:child_process';
const admin = new URL(process.env.MIGRATION_DATABASE_URL);
const app = new URL(process.env.DATABASE_URL);
if (![admin, app].every(u => u.hostname === '127.0.0.1' && u.port === '55322')) {
  throw new Error('Voice integration tests require local Supabase on 127.0.0.1:55322');
}
admin.pathname = app.pathname = '/gf_voice_ci';
const env = { ...process.env, GF_TEST_NO_DOTENV: '1', DATABASE_TEST_TARGET: 'isolated',
  TEST_DATABASE_URL: app.href, TEST_MIGRATION_DATABASE_URL: admin.href,
  DATABASE_URL: app.href, MIGRATION_DATABASE_URL: admin.href, SEED_SKIP_AUTH: '1',
  TEST_APP_DB_PASSWORD: process.env.APP_DB_PASSWORD };
const migrate = process.argv[2] === 'migrate';
const args = migrate ? ['--import', 'tsx', 'packages/db/src/migrate.ts']
  : ['--filter', '@gf/api', 'test', ...(process.argv.slice(3).length ? process.argv.slice(3) : ['src/voice.test.ts'])];
const out = spawnSync(migrate ? process.execPath : 'pnpm', args, { env, stdio: 'inherit' });
process.exitCode = out.status ?? 1;
