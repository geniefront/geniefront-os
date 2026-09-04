import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../sql/0105_copilot_sessions.sql', import.meta.url);

describe('copilot session data governance migration', () => {
  it('forces RLS and scopes both tables to org, location and membership', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
    expect(sql).toContain('alter table copilot_sessions force row level security');
    expect(sql).toContain('alter table copilot_messages force row level security');
    expect(sql.match(/membership_id = app_membership_id\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain('foreign key (session_id, org_id, location_id, membership_id)');
  });

  it('stores no image bytes or executable proposal tokens and enforces retention metadata', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
    expect(sql).not.toMatch(/base64|proposal_token|image_data/i);
    expect(sql).toContain("interval '30 days'");
    expect(sql).toContain('had_image boolean');
  });
});
