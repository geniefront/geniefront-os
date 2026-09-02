#!/usr/bin/env node
/**
 * 把 supabase/templates 里的 Magic Link / Recovery 模板推到托管项目。
 *
 * 需要个人 access token（https://supabase.com/dashboard/account/tokens）：
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=yfqybhuvzluvrapodahw \
 *     node scripts/push-auth-email-templates.mjs
 *
 * 默认 PROJECT_REF 是 staging 项目。生产另传 PROJECT_REF。
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

const magic = readFileSync(join(root, 'supabase/templates/magic_link.html'), 'utf8');
const recovery = readFileSync(join(root, 'supabase/templates/recovery.html'), 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    mailer_subjects_magic_link: 'Sign in to GenieFront',
    mailer_templates_magic_link_content: magic,
    mailer_subjects_recovery: 'Reset your GenieFront password',
    mailer_templates_recovery_content: recovery,
  }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`推送失败 HTTP ${res.status}`);
  console.error(body.slice(0, 800));
  process.exit(1);
}
console.log(`已推到项目 ${ref}：Magic Link + Recovery`);
