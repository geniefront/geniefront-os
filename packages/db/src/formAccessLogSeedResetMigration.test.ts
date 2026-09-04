import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../sql/0106_form_access_log_seed_reset.sql', import.meta.url);

describe('form access log seed reset migration', () => {
  it('keeps the bypass administrator-only and transaction opt-in', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain("current_user <> 'app_user'");
    expect(sql).toContain("current_setting('app.seed_reset', true) = 'on'");
    expect(sql).toContain("tg_op = 'DELETE'");
  });

  it('does not expose the trigger function publicly', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain(
      'revoke all on function form_access_log_immutable() from public, anon, authenticated',
    );
    expect(sql).toContain('grant execute on function form_access_log_immutable() to app_user');
  });
});
