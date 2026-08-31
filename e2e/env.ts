import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
const value = (key: string): string => process.env[key] ?? fileEnv[key] ?? '';

function required(key: string): string {
  const result = value(key);
  if (!result) throw new Error(`Playwright QA requires ${key}`);
  return result;
}

function localUrl(key: string, expectedUser?: string): string {
  const raw = required(key);
  const parsed = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Playwright QA refuses non-local ${key} host: ${parsed.hostname}`);
  }
  if (expectedUser && parsed.username !== expectedUser) {
    throw new Error(`Playwright QA requires ${key} to use ${expectedUser}`);
  }
  return raw;
}

if (process.env.GF_QA_ALLOW_RESET !== '1') {
  throw new Error('Playwright QA requires GF_QA_ALLOW_RESET=1');
}
if (required('DATABASE_TEST_TARGET') !== 'isolated') {
  throw new Error('Playwright QA requires DATABASE_TEST_TARGET=isolated');
}

export const QA_NOW = process.env.QA_NOW ?? '2026-08-30T16:00:00.000Z';
export const WEB_URL = 'http://127.0.0.1:5177';
export const PLATFORM_URL = 'http://127.0.0.1:5179';
export const MARKETING_URL = 'http://127.0.0.1:5180';
export const API_URL = 'http://127.0.0.1:3000';

const testDatabaseUrl = localUrl('TEST_DATABASE_URL', 'app_user');
const testMigrationDatabaseUrl = localUrl('TEST_MIGRATION_DATABASE_URL', 'postgres');
const testSupabaseUrl = localUrl('TEST_SUPABASE_URL');

export const qaEnvironment: Record<string, string> = {
  GF_QA_ALLOW_RESET: '1',
  NODE_ENV: 'test',
  QA_NOW,
  DATABASE_TEST_TARGET: 'isolated',
  DATABASE_URL: testDatabaseUrl,
  MIGRATION_DATABASE_URL: testMigrationDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  TEST_MIGRATION_DATABASE_URL: testMigrationDatabaseUrl,
  SUPABASE_URL: testSupabaseUrl,
  SUPABASE_ANON_KEY: required('TEST_SUPABASE_ANON_KEY'),
  APP_BASE_URL: WEB_URL,
  APP_URL: WEB_URL,
  MARKETING_BASE_URL: MARKETING_URL,
  VITE_API_BASE: API_URL,
  PORT: '3000',
  APP_JWT_SECRET: required('APP_JWT_SECRET'),
  FORM_ENCRYPTION_KEY: required('FORM_ENCRYPTION_KEY'),
  STRIPE_SECRET_KEY: required('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: required('STRIPE_WEBHOOK_SECRET'),
  STRIPE_PRICE_ESSENTIAL: required('STRIPE_PRICE_ESSENTIAL'),
  STRIPE_PRICE_GROWTH: required('STRIPE_PRICE_GROWTH'),
  STRIPE_PRICE_AI_TOPUP: required('STRIPE_PRICE_AI_TOPUP'),
};

export const rootDir = ROOT;
