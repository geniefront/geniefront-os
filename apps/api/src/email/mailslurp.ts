/**
 * MailSlurp integration for local development and staging.
 *
 * In staging and local environments, MailSlurp provides isolated test inboxes
 * and incoming email callbacks so developers can receive and inspect emails
 * without polluting geniefront.com domain reputation or creating subaccounts under Elastic Email.
 */
import { isProductionEnv } from '../comms/mode';

export function mailslurpKey(env = process.env): string | undefined {
  return env['MAILSLURP_API_KEY'];
}

/**
 * MailSlurp is strictly for local and staging environments, never active in production.
 */
export function mailslurpEnabled(env = process.env): boolean {
  if (isProductionEnv(env)) return false;
  return Boolean(mailslurpKey(env));
}

export interface MailSlurpInbox {
  id: string;
  emailAddress: string;
  name?: string;
}

export async function mailslurpCreateInbox(name: string, key = mailslurpKey()): Promise<MailSlurpInbox> {
  if (!key) throw new Error('mailslurp_not_configured');
  const res = await fetch('https://api.mailslurp.com/inboxes', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`mailslurp_http_${res.status}`);
  return await res.json() as MailSlurpInbox;
}

export async function mailslurpAttachWebhook(inboxId: string, url: string, key = mailslurpKey()): Promise<{ id: string }> {
  if (!key) throw new Error('mailslurp_not_configured');
  const res = await fetch(`https://api.mailslurp.com/inboxes/${encodeURIComponent(inboxId)}/webhooks`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, eventName: 'NEW_EMAIL' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`mailslurp_webhook_http_${res.status}`);
  return await res.json() as { id: string };
}

export async function mailslurpGetEmail(emailId: string, key = mailslurpKey()): Promise<{
  id: string;
  subject?: string;
  from?: string;
  to: string[];
  body?: string;
}> {
  if (!key) throw new Error('mailslurp_not_configured');
  const res = await fetch(`https://api.mailslurp.com/emails/${encodeURIComponent(emailId)}`, {
    headers: { 'x-api-key': key },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`mailslurp_email_http_${res.status}`);
  return await res.json() as { id: string; subject?: string; from?: string; to: string[]; body?: string };
}
