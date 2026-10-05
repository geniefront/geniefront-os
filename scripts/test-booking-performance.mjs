// Creates its OWN disposable local database. Never reads .env or accepts a DB URL.
// Runs the voice snapshot/booking regressions with captured communications.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBookingWorkerIsolation } from './verify-booking-worker-isolation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const postgres = require('postgres');
const name = `gf-booking-performance-${process.pid}-${randomBytes(3).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const appPassword = randomBytes(24).toString('hex');
const full = process.argv.includes('--full');
// Existing commerce clock fixtures require this exact disposable target.
const database = full ? 'gf_commerce_stage_ci' : 'gf_booking_performance_test';
const baseEnv = Object.fromEntries(['PATH', 'HOME', 'PNPM_HOME', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
function run(command, args, env = baseEnv, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env,
    encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
let started = false;
try {
  run('docker', ['run', '--detach', '--name', name, '--label', 'geniefront.booking-performance-test=1',
    '--publish', full ? '127.0.0.1:58332:5432' : '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', `POSTGRES_DB=${database}`, 'postgres:17'],
    { ...baseEnv, POSTGRES_PASSWORD: password }, true);
  started = true;
  const address = run('docker', ['port', name, '5432/tcp'], baseEnv, true);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Expected a loopback-only disposable database');
  const adminUrl = `postgresql://postgres:${password}@${address}/${database}`;
  const appUrl = `postgresql://app_user:${appPassword}@${address}/${database}`;
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await admin`select 1`; break; }
      catch { if (attempt >= 29) throw new Error('Disposable PostgreSQL did not start'); await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    await admin.unsafe(await readFile(new URL('../packages/db/test/bootstrap-postgres.sql', import.meta.url), 'utf8'));
  } finally { await admin.end(); }
  const env = { ...baseEnv,
    DATABASE_TEST_TARGET: 'isolated', GF_TEST_NO_DOTENV: '1', GF_QA_ALLOW_RESET: '1', NODE_ENV: 'test', SEED_SKIP_AUTH: '1',
    DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: adminUrl, APP_DB_PASSWORD: appPassword,
    TEST_DATABASE_URL: appUrl, TEST_MIGRATION_DATABASE_URL: adminUrl, TEST_APP_DB_PASSWORD: appPassword,
    COMMUNICATION_DELIVERY_MODE: 'capture', EMAIL_PROVIDER: 'resend',
    BOOKING_PAGE_ORIGIN: 'https://book.geniefront.com',
    // Public/voice tests use their own credentials; never contact hosted Auth.
    SUPABASE_URL: 'http://127.0.0.1:1', TEST_SUPABASE_URL: 'http://127.0.0.1:1',
    TEST_SUPABASE_SERVICE_ROLE_KEY: 'isolated-auth-fixture-not-a-real-key',
    TEST_SUPABASE_ANON_KEY: 'isolated-anon-fixture-not-a-real-key',
    APP_JWT_SECRET: randomBytes(32).toString('hex'),
    FORM_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  };
  console.log(`Isolated booking regression database: ${address}/${database}`);
  run(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts'], env);
  if (full) {
    run('pnpm', ['db:seed'], env);
    run('pnpm', ['--filter', '@gf/db', 'exec', 'vitest', 'run'], env);
  }
  run('pnpm', ['--filter', '@gf/api', 'exec', 'vitest', 'run',
    ...(full ? [] : ['src/voiceV2.test.ts', 'src/public.test.ts'])], env);
  // Full suites may leave a different tenant fixture last; restore the voice
  // fixture before the real worker/process isolation check.
  if (full) run('pnpm', ['--filter', '@gf/api', 'exec', 'vitest', 'run', 'src/voiceV2.test.ts'], env);
  await verifyBookingWorkerIsolation(env, root);
} finally {
  // Exact name created above, no shared database/container cleanup.
  if (started) run('docker', ['rm', '--force', '--volumes', name], baseEnv, true);
}
