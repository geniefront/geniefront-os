import { describe, expect, it } from 'vitest';
import { assertBaselineTarget } from './baselineSafety';
import { assertRegressionTarget } from './regressionSafety';

const config = { supabaseUrl: 'https://yfqybhuvzluvrapodahw.supabase.co', databaseHost: 'aws-0-us-east-1.pooler.supabase.com', databasePort: '6543', databaseUser: 'postgres.yfqybhuvzluvrapodahw' };
const env = { GF_ENV: 'staging', MIGRATION_DATABASE_URL: 'postgresql://postgres.yfqybhuvzluvrapodahw:test@aws-0-us-east-1.pooler.supabase.com:6543/postgres', SUPABASE_URL: config.supabaseUrl, COMMUNICATION_DELIVERY_MODE: 'capture', STRIPE_SECRET_KEY: 'sk_test_fixture', GF_BASELINE_PASSWORD: 'unit-test-only-password-123' };
describe('baseline environment boundaries', () => {
  it('accepts only the exact staging project', () => {
    expect(() => assertBaselineTarget('staging', env, config)).not.toThrow();
    expect(() => assertBaselineTarget('staging', { ...env, MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL.replace('yfqybhuvzluvrapodahw', 'qiuyubvhirjtglonbkon') }, config)).toThrow();
  });
  it('rejects production even with staging credentials', () => {
    expect(() => assertBaselineTarget('production', env, config)).toThrow();
  });
  it.each([{ GF_ENV: 'production' }, { COMMUNICATION_DELIVERY_MODE: 'live' }, { STRIPE_SECRET_KEY: 'sk_live_fixture' }, { GF_BASELINE_PASSWORD: '' }, { SUPABASE_URL: 'https://qiuyubvhirjtglonbkon.supabase.co' }])('rejects unsafe setting %j', changes => {
    expect(() => assertBaselineTarget('staging', { ...env, ...changes }, config)).toThrow();
  });
});
describe('legacy regression boundaries', () => {
  const isolated = { DATABASE_TEST_TARGET: 'isolated', NODE_ENV: 'test', DATABASE_URL: 'postgresql://app_user:test@localhost:5432/postgres', MIGRATION_DATABASE_URL: 'postgresql://postgres:test@localhost:5432/postgres' };
  it('keeps isolated CI fixtures working', () => expect(() => assertRegressionTarget(isolated)).not.toThrow());
  it('refuses manual local and hosted databases', () => {
    for (const host of ['localhost:55322', 'aws-0-us-east-1.pooler.supabase.com:6543']) {
      expect(() => assertRegressionTarget({ ...isolated, MIGRATION_DATABASE_URL: `postgresql://postgres:test@${host}/postgres` })).toThrow();
    }
  });
});
