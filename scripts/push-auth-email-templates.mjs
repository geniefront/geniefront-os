#!/usr/bin/env node
/**
 * 把 supabase/templates 里的 Auth 邮件模板推到托管项目。
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=yfqybhuvzluvrapodahw \
 *     node scripts/push-auth-email-templates.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.PROJECT_REF || 'yfqybhuvzluvrapodahw';

if (!token) {
  console.error('缺少 SUPABASE_ACCESS_TOKEN。到 https://supabase.com/dashboard/account/tokens 建一个再跑。');
  process.exit(2);
}

const logoByRef = {
  yfqybhuvzluvrapodahw: 'https://staging.geniefront.com/brand/geniefront-logo-email.png',
  qiuyubvhirjtglonbkon: 'https://www.geniefront.com/brand/geniefront-logo-email.png',
};
const logo = logoByRef[ref] ?? 'https://www.geniefront.com/brand/geniefront-logo-email.png';

function load(name) {
  return readFileSync(join(root, 'supabase/templates', name), 'utf8')
    .replaceAll('{{ .SiteURL }}/brand/geniefront-logo-email.png', logo);
}

const payload = {
  mailer_subjects_magic_link: 'Sign in to GenieFront',
  mailer_templates_magic_link_content: load('magic_link.html'),
  mailer_subjects_recovery: 'Reset your GenieFront password',
  mailer_templates_recovery_content: load('recovery.html'),
  mailer_subjects_confirmation: 'Confirm your GenieFront email',
  mailer_templates_confirmation_content: load('confirmation.html'),
  mailer_subjects_invite: 'You are invited to GenieFront',
  mailer_templates_invite_content: load('invite.html'),
  mailer_subjects_email_change: 'Confirm your new GenieFront email',
  mailer_templates_email_change_content: load('email_change.html'),
};

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

const body = await res.text();
if (!res.ok) {
  console.error(`推送失败 HTTP ${res.status}`);
  console.error(body.slice(0, 800));
  process.exit(1);
}
console.log(`已推到项目 ${ref}：Magic Link + Recovery + Confirmation + Invite + Email change`);
console.log(`logo ${logo}`);
