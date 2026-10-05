#!/usr/bin/env node
// Explicit migration operations. Credentials and rollback snapshots stay in ignored env files.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
const [mode, file = '.env.production'] = process.argv.slice(2);
const secrets = parseEnv(readFileSync('.env.maileroo', 'utf8'));
const env = parseEnv(readFileSync(file, 'utf8'));
const domains = ['geniefront.com', 'notify.geniefront.com', 'appointment.geniefront.com', 'mkt.geniefront.com', 'tenant.geniefront.com'];
export async function request(path, method = 'GET', body) {
  const r = await fetch(`https://api.maileroo.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${secrets.MAILEROO_ACCOUNT_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Maileroo ${method} ${path}: HTTP ${r.status}`);
  return (await r.json()).data;
}
function save(values) {
  let content = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(String(value))}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    content = re.test(content) ? content.replace(re, () => line) : `${content}\n${line}\n`;
  }
  writeFileSync(file, content, { mode: 0o600 }); chmodSync(file, 0o600);
}
async function cf(path, method = 'GET', body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}${path}`, {
    method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json(); if (!r.ok || !j.success) throw new Error(`Cloudflare ${method} ${path}: HTTP ${r.status}`);
  return j.result;
}
const list = (await request('/domains?per_page=100')).domains;
if (mode === 'domains') {
  for (const name of domains) {
    if (!list.some(d => d.domain_name === name)) await request('/domains', 'POST', { type: 'custom', domain_name: name });
  }
  console.log('Sending and inbound domains registered.');
} else if (mode === 'dns') {
  const records = await cf('/dns_records?per_page=500');
  const backup = `${file}.maileroo-dns-backup`;
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(records), { mode: 0o600 });
  for (const name of domains) {
    const domain = list.find(d => d.domain_name === name);
    if (!domain) throw new Error(`Missing domain ${name}`);
    const d = await request(`/domains/${domain.id}`);
    {
      const dkim = d.dns_records.dkim_record;
      const wanted = [{ type: 'TXT', name: dkim.host, content: dkim.record }];
      const spf = records.filter(r => r.type === 'TXT' && r.name === name && r.content.replaceAll('"', '').startsWith('v=spf1'));
      if (spf.length > 1) throw new Error(`Multiple SPF records for ${name}`);
      let content = spf[0]?.content.replaceAll('"', '') || 'v=spf1 ~all';
      if (/\bredirect=/.test(content)) throw new Error(`SPF redirect requires review: ${name}`);
      if (!content.includes('include:_spf.maileroo.com')) content = content.replace(/\s+([~?+-]?all)\s*$/, ' include:_spf.maileroo.com $1');
      wanted.push({ type: 'TXT', name, content, id: spf[0]?.id });
      if (!records.some(r => r.type === 'TXT' && r.name === `_dmarc.${name}`)) wanted.push({ type: 'TXT', name: `_dmarc.${name}`, content: 'v=DMARC1; p=none;' });
      for (const w of wanted) {
        const existing = w.id || records.find(r => r.type === w.type && r.name === w.name && w.name !== name)?.id;
        await cf(`/dns_records${existing ? `/${existing}` : ''}`, existing ? 'PATCH' : 'POST', { type: w.type, name: w.name, content: w.content, ttl: 300 });
      }
      await request(`/domains/${d.id}/settings`, 'PATCH', { interaction_tracking: false, custom_hostname_tracking: false });
      console.log(`${name}: SPF/DKIM configured, existing DMARC preserved, tracking disabled`);
    }
    await request(`/domains/${d.id}/scan-dns`, 'POST');
  }
} else if (mode === 'credentials') {
  const name = `GenieFront ${env.GF_ENV || 'production'}`;
  const apps = (await request('/applications?per_page=100')).applications;
  const existing = apps.find(a => a.name === name);
  const app = existing ? await request(`/applications/${existing.id}`) : await request('/applications', 'POST', {
    name, authorized_domains: list.filter(d => domains.includes(d.domain_name)).map(d => d.id),
    notes: 'GenieFront application email migration',
  });
  if (!app.sending_key || !app.smtp_password || !app.smtp_username) throw new Error('Incomplete application credentials');
  save({ MAILEROO_API_KEY: app.sending_key, MAILEROO_SMTP_USERNAME: app.smtp_username, MAILEROO_SMTP_PASSWORD: app.smtp_password,
    MAILEROO_APPLICATION_ID: app.id, MAILEROO_ACCOUNT_API_KEY: secrets.MAILEROO_ACCOUNT_API_KEY });
  console.log(`Stored isolated sending/SMTP credentials for ${name}. Provider unchanged.`);
} else if (mode === 'webhook') {
  const callback_url = `https://${env.API_HOST}/v1/webhooks/maileroo`;
  const hooks = await request('/webhooks');
  const hook = hooks.find(w => w.callback_url === callback_url) || await request('/webhooks', 'POST', {
    callback_url, domains: list.filter(d => domains.includes(d.domain_name)).map(d => d.id),
    event_types: ['accepted', 'delivered', 'deferred', 'failed', 'complained', 'rejected'],
  });
  const secret = hook.shared_secret || hook.secret;
  if (!secret) { console.log('Webhook response fields:', Object.keys(hook)); throw new Error('Missing webhook signing secret'); }
  save({ MAILEROO_WEBHOOK_SECRET: secret });
  console.log(`Webhook registered: ${callback_url}; signing secret stored locally`);
} else if (mode === 'auth') {
  const authToken = env.SUPABASE_ACCESS_TOKEN || parseEnv(readFileSync('.env.production', 'utf8')).SUPABASE_ACCESS_TOKEN;
  if (!authToken || !env.MAILEROO_SMTP_PASSWORD) throw new Error('Missing management token or SMTP credentials');
  const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];
  const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };
  const before = await fetch(url, { headers }); if (!before.ok) throw new Error(`Auth read ${before.status}`);
  const previous = await before.json();
  const backup = `${file}.maileroo-auth-backup`;
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(Object.fromEntries(Object.entries(previous).filter(([k]) => k.startsWith('smtp_')))), { mode: 0o600 });
  const patch = { smtp_host: 'smtp.maileroo.com', smtp_port: '587', smtp_user: env.MAILEROO_SMTP_USERNAME, smtp_pass: env.MAILEROO_SMTP_PASSWORD, smtp_admin_email: previous.smtp_admin_email || 'noreply@geniefront.com', smtp_sender_name: previous.smtp_sender_name || 'GenieFront' };
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(patch) }); if (!r.ok) throw new Error(`Auth update ${r.status}`);
  const verified = await (await fetch(url, { headers })).json();
  for (const k of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_admin_email']) if (String(verified[k]) !== String(patch[k])) throw new Error(`Auth verify mismatch: ${k}`);
  console.log(`${ref}: verified Supabase SMTP migration to Maileroo`);
} else if (mode === 'status') {
  for (const d of list.filter(d => domains.includes(d.domain_name))) {
    const detail = await request(`/domains/${d.id}`);
    console.log(JSON.stringify({ domain: d.domain_name, verified: detail.status, dns: Object.fromEntries(Object.entries(detail.dns_records).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => x.created) : v.created])), tracking: detail.interaction_tracking }));
  }
} else if (mode === 'local') {
  if (!['.env','.env.local'].includes(file)) throw new Error('Local env files only');
  const staging = parseEnv(readFileSync('.env.staging','utf8'));
  const values = Object.fromEntries(['MAILEROO_API_KEY','MAILEROO_ACCOUNT_API_KEY','MAILEROO_APPLICATION_ID','MAILEROO_WEBHOOK_SECRET'].map(k=>[k,staging[k]]));
  if (Object.values(values).some(v=>!v)) throw new Error('Staging Maileroo credentials missing');
  save({...values,EMAIL_PROVIDER:'maileroo'});
  console.log(`${file}: local sending provider updated; capture settings preserved`);
} else throw new Error('Use domains|dns|credentials|webhook|auth|status|local');
