import { sql } from '@gf/db';
/** Called only after Telnyx signature verification. No recipient details are retained. */
export async function recordSmsDelivery(payload: Record<string, unknown>, occurredAt: unknown) {
  if (payload.direction !== 'outbound' || typeof payload.id !== 'string') return;
  const recipients = Array.isArray(payload.to) ? payload.to as Array<{ status?: string }> : [];
  const states = recipients.map(r => r.status);
  const state = states.length && states.every(s => s === 'delivered') ? 'delivered'
    : states.some(s => s === 'delivery_failed' || s === 'sending_failed') ? 'failed'
    : states.some(s => s === 'delivery_unconfirmed') ? 'unconfirmed' : 'accepted';
  const at = typeof occurredAt === 'string' && Number.isFinite(Date.parse(occurredAt)) ? occurredAt : new Date().toISOString();
  const errors = Array.isArray(payload.errors) ? payload.errors as Array<{ code?: string; title?: string }> : [];
  const reason = errors.map(error => [error.code, error.title].filter(Boolean).join(': ')).join('; ').slice(0,1000);
  await sql`select public.gf_record_sms_delivery(${payload.id},${state},${at}::timestamptz,${reason || null})`;
}
