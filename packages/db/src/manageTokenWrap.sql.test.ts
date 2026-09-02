/**
 * sql/0099 adds a nullable wrap column and is safe to replay.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { adminSql } from './admin';
import { closeDb } from './client';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../sql');
const M099 = 'sql/0099_manage_token_wrap.sql';

afterAll(async () => {
  await closeDb();
  await adminSql.end({ timeout: 5 });
});

async function applySqlFile(key: string): Promise<void> {
  const file = key.replace(/^sql\//, '');
  const body = await readFile(join(SQL_DIR, file), 'utf8');
  await adminSql.unsafe(body);
  await adminSql`insert into _migrations (name) values (${key}) on conflict (name) do nothing`;
}

describe('0099 manage token wrap column', () => {
  it('adds a nullable bytea column and replays cleanly', async () => {
    await applySqlFile(M099);
    await applySqlFile(M099);
    const [col] = await adminSql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'appointments'
         and column_name = 'manage_token_wrapped'`;
    expect(col?.data_type).toBe('bytea');
    expect(col?.is_nullable).toBe('YES');
  });
});
