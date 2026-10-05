import { describe, expect, it } from 'vitest';
import { assertQaDatabaseSafe, QA_ALLOW_RESET_ENV } from './safety';

const localApp = 'postgresql://app_user:secret@127.0.0.1:54322/postgres';
const localMig = 'postgresql://postgres:secret@127.0.0.1:54322/postgres';

const allowed = {
  nodeEnv: 'test',
  allowReset: '1',
  databaseTestTarget: 'isolated',
  databaseUrl: localApp,
  migrationDatabaseUrl: localMig,
  supabaseUrl: 'http://127.0.0.1:54321',
  adminDatabaseSource: 'process' as const,
};

describe('QA production safety', () => {
  it('allows isolated local/test config', () => {
    const r = assertQaDatabaseSafe(allowed);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe('127.0.0.1');
      expect(r.database).toBe('postgres');
    }
  });

  it('refuses the persistent manual-QA local database', () => {
    const r = assertQaDatabaseSafe({ ...allowed, databaseUrl: localApp.replace('54322', '55322'), migrationDatabaseUrl: localMig.replace('54322', '55322') });
    expect(r.ok).toBe(false);
  });

  it('refuses NODE_ENV=production', () => {
    const r = assertQaDatabaseSafe({ ...allowed, nodeEnv: 'production' });
    expect(r).toEqual({ ok: false, reason: 'NODE_ENV=production is refused' });
  });

  it(`refuses missing ${QA_ALLOW_RESET_ENV}`, () => {
    const r = assertQaDatabaseSafe({ ...allowed, allowReset: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/GF_QA_ALLOW_RESET/);
  });

  it('refuses non-isolated DATABASE_TEST_TARGET', () => {
    const r = assertQaDatabaseSafe({ ...allowed, databaseTestTarget: 'dev' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/isolated/);
  });

  it('refuses production Supabase project ref', () => {
    const r = assertQaDatabaseSafe({
      ...allowed,
      supabaseUrl: 'https://qiuyubvhirjtglonbkon.supabase.co',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/qiuyubvhirjtglonbkon/);
  });

  it('refuses desk.geniefront.com', () => {
    const r = assertQaDatabaseSafe({
      ...allowed,
      appBaseUrl: 'https://desk.geniefront.com',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/desk\.geniefront\.com|geniefront\.com/);
  });

  it('refuses remote hostname even with isolated flag', () => {
    const r = assertQaDatabaseSafe({
      ...allowed,
      migrationDatabaseUrl: 'postgresql://postgres:secret@db.example.net:5432/postgres',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/local test hostname/);
  });

  it('refuses implicit .env migration URL', () => {
    const r = assertQaDatabaseSafe({ ...allowed, adminDatabaseSource: 'env-file' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/explicitly/);
  });

  it('does not include credentials in refusal reasons', () => {
    const r = assertQaDatabaseSafe({
      ...allowed,
      databaseUrl: 'postgresql://app_user:SUPER_SECRET@api.geniefront.com:5432/postgres',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/SUPER_SECRET/);
      expect(r.reason).not.toMatch(/app_user:/);
    }
  });
});
