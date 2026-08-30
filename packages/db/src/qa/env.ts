/**
 * Load only TEST_* database bindings for the QA CLI.
 * Mirrors vitest.shared.ts: never copy NODE_ENV or production DATABASE_URL
 * from the root .env into this process.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_ALLOW_RESET_ENV } from './safety';

const NEVER_FROM_DOTENV = new Set([
  'NODE_ENV',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'APP_DB_PASSWORD',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

function readDotEnv(): Record<string, string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* CI supplies real env */
  }
  return out;
}

/**
 * Map TEST_* → the process variables admin.ts / client.ts expect.
 * Must run before those modules are imported.
 */
export function applyQaEnv(): void {
  const dotenv = readDotEnv();
  const pick = (name: string): string | undefined =>
    process.env[name] || dotenv[name];

  const target = pick('DATABASE_TEST_TARGET');
  const databaseUrl = pick('TEST_DATABASE_URL');
  const migrationUrl = pick('TEST_MIGRATION_DATABASE_URL');
  if (target) process.env['DATABASE_TEST_TARGET'] = target;
  if (databaseUrl) process.env['DATABASE_URL'] = databaseUrl;
  if (migrationUrl) process.env['MIGRATION_DATABASE_URL'] = migrationUrl;

  const testPassword = pick('TEST_APP_DB_PASSWORD');
  if (testPassword) process.env['APP_DB_PASSWORD'] = testPassword;

  const testSupabaseUrl = pick('TEST_SUPABASE_URL');
  const testSupabaseKey = pick('TEST_SUPABASE_SERVICE_ROLE_KEY');
  const testSupabaseAnon = pick('TEST_SUPABASE_ANON_KEY');
  if (testSupabaseUrl) process.env['SUPABASE_URL'] = testSupabaseUrl;
  if (testSupabaseKey) process.env['SUPABASE_SERVICE_ROLE_KEY'] = testSupabaseKey;
  if (testSupabaseAnon) process.env['SUPABASE_ANON_KEY'] = testSupabaseAnon;

  if (!process.env[QA_ALLOW_RESET_ENV]) {
    const fromDot = dotenv[QA_ALLOW_RESET_ENV];
    if (fromDot) process.env[QA_ALLOW_RESET_ENV] = fromDot;
  }
  if (!process.env['QA_NOW'] && dotenv['QA_NOW']) {
    process.env['QA_NOW'] = dotenv['QA_NOW'];
  }

  if (!process.env['NODE_ENV'] || process.env['NODE_ENV'] === 'production') {
    process.env['NODE_ENV'] = 'test';
  }
}
