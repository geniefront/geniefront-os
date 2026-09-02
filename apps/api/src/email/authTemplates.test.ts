import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/templates');

describe('Supabase Auth 邮件模板', () => {
  const magic = readFileSync(join(dir, 'magic_link.html'), 'utf8');
  const recovery = readFileSync(join(dir, 'recovery.html'), 'utf8');
  const confirmation = readFileSync(join(dir, 'confirmation.html'), 'utf8');
  const invite = readFileSync(join(dir, 'invite.html'), 'utf8');
  const emailChange = readFileSync(join(dir, 'email_change.html'), 'utf8');
  const all = [magic, recovery, confirmation, invite, emailChange];

  it('五封都套品牌壳：logo、薄荷顶条、600 白卡片', () => {
    for (const html of all) {
      expect(html).toContain('#9BCDA3');
      expect(html).toContain('#F2FAF3');
      expect(html).toContain('#384341');
      expect(html).toContain('alt="GenieFront"');
      expect(html).toContain('geniefront-logo-email.png');
      expect(html).toContain('{{ .SiteURL }}');
      expect(html).toContain('{{ .ConfirmationURL }}');
      expect(html).toContain('width="600"');
      expect(html).not.toMatch(/127\.0\.0\.1|localhost/);
    }
  });

  it('Magic Link 按钮落到 ConfirmationURL，不自己拼 host', () => {
    expect(magic).toContain('href="{{ .ConfirmationURL }}"');
    expect(magic).toContain('Open dashboard');
    expect(magic).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('Recovery 带 Google 注册提示，且不写卡号', () => {
    expect(recovery).toContain('Set a new password');
    expect(recovery).toContain('Signed up with Google?');
    expect(recovery).not.toMatch(/visa|mastercard|\*{2,}\d{4}/i);
  });

  it('Confirmation / Invite / Email change 按钮落到 ConfirmationURL', () => {
    expect(confirmation).toContain('Confirm email');
    expect(invite).toContain('Accept invitation');
    expect(emailChange).toContain('Confirm new email');
    expect(emailChange).toContain('{{ .Email }}');
    expect(emailChange).toContain('{{ .NewEmail }}');
    for (const html of [confirmation, invite, emailChange]) {
      expect(html).toContain('href="{{ .ConfirmationURL }}"');
    }
  });
});
