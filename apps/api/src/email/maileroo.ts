import { createHash, randomBytes } from 'node:crypto';
import type { OutgoingEmail } from './send';

export class MailerooError extends Error {
  constructor(readonly status: number) { super(`maileroo_http_${status}`); }
  get permanent(): boolean { return this.status >= 400 && this.status < 500 && ![408, 429].includes(this.status); }
}
export function mailerooReferenceId(outboxId?: string): string {
  return outboxId ? createHash('sha256').update(`maileroo:${outboxId}`).digest('hex').slice(0, 24) : randomBytes(12).toString('hex');
}
export function mailerooAddress(value: string): { address: string; display_name?: string } {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  return match ? { address: match[2]!.trim(), display_name: match[1]!.replace(/^"|"$/g, '').trim() } : { address: value.trim() };
}
export async function mailerooSendEmail(msg: OutgoingEmail & { from: string }): Promise<{ reference_id: string }> {
  const key = process.env['MAILEROO_API_KEY'];
  if (!key) throw new Error('maileroo_not_configured');
  const reference_id = mailerooReferenceId(msg.outboxId);
  const response = await fetch('https://smtp.maileroo.com/api/v2/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: mailerooAddress(msg.from), to: [mailerooAddress(msg.to)], subject: msg.subject,
      html: msg.html, plain: msg.text, tracking: false, reference_id,
      ...(msg.replyTo ? { reply_to: mailerooAddress(msg.replyTo) } : {}),
      ...(msg.outboxId && msg.orgId && msg.locationId ? { tags: { outbox_id: msg.outboxId, org_id: msg.orgId, location_id: msg.locationId } } : {}),
    }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new MailerooError(response.status);
  const body = await response.json() as { success?: boolean; data?: { reference_id?: string } };
  if (body.success !== true || body.data?.reference_id !== reference_id) throw new MailerooError(502);
  return { reference_id };
}

export interface MailerooDnsRecord { host: string; record: string; created: boolean; cname_fallback?: string; priority?: number }
export interface MailerooDomain {
  id: number; domain_name: string; status: boolean;
  dns_records?: { dkim_record: MailerooDnsRecord; spf_record: MailerooDnsRecord; dmarc_record: MailerooDnsRecord };
}
export async function mailerooRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const key = process.env['MAILEROO_ACCOUNT_API_KEY'];
  if (!key) throw new Error('maileroo_management_not_configured');
  const response = await fetch(`https://api.maileroo.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new MailerooError(response.status);
  return (await response.json() as { data: T }).data;
}
export async function mailerooDomains(): Promise<MailerooDomain[]> {
  const domains: MailerooDomain[] = [];
  for (let page = 1; ; page++) {
    const data = await mailerooRequest<{ domains: MailerooDomain[]; total_pages: number }>(`/domains?per_page=100&page=${page}`);
    domains.push(...data.domains);
    if (page >= data.total_pages) return domains;
  }
}
export async function mailerooDomain(name: string): Promise<MailerooDomain | undefined> {
  const data = await mailerooRequest<{ domains: MailerooDomain[] }>(`/domains?per_page=100&search=${encodeURIComponent(name)}`);
  return data.domains.find(d => d.domain_name.toLowerCase() === name.toLowerCase());
}
