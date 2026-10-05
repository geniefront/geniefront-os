import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from '@gf/db';
import { rawBodyOf } from '../rawBody';
import { mailerooReferenceId } from './maileroo';

export function verifyMailerooSignature(raw: string, signature: unknown, secret = process.env['MAILEROO_WEBHOOK_SECRET']): boolean {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(signature, 'hex'));
}
const tenantTags = z.object({ outbox_id: z.string().uuid(), org_id: z.string().uuid(), location_id: z.string().uuid() });
const eventSchema = z.object({
  event_id: z.string().min(1).max(256), event_type: z.string().max(64),
  message_reference_id: z.string().max(256),
  // Sending accepts a map, but live callbacks can serialize tags as name/value pairs.
  tags: z.preprocess(value => Array.isArray(value)
    ? Object.fromEntries(value.filter(v => v && typeof v.name === 'string' && typeof v.value === 'string').map(v => [v.name, v.value]))
    : value, tenantTags.nullish()),
  event_data: z.object({ to: z.union([z.string().email(), z.array(z.string().email())]).optional(), reason: z.string().optional(), reject_reason: z.string().optional() }).passthrough(),
});
type Event = z.infer<typeof eventSchema>;
export function mailerooEventState(event: Event): 'delivered' | 'delayed' | 'soft_bounce' | 'hard_bounce' | 'complained' | null {
  switch (event.event_type) {
    case 'delivered': return 'delivered';
    case 'deferred': return 'delayed';
    case 'complained': return 'complained';
    // A terminal failure can still be a full mailbox. Only known invalid recipients are suppressed forever.
    case 'failed': return /\b5\.1\.[1236]\b|user unknown|no such user|mailbox (?:does not exist|not found)|recipient address rejected: user unknown/i.test(event.event_data.reason ?? '') ? 'hard_bounce' : 'soft_bounce';
    case 'rejected': return 'soft_bounce';
    default: return null;
  }
}
export async function handleMailerooEvent(event: Event): Promise<void> {
  const tags = event.tags;
  if (!tags || mailerooReferenceId(tags.outbox_id) !== event.message_reference_id) return;
  const state = mailerooEventState(event);
  if (!state) return;
  await withTenant({ orgId: tags.org_id, locationId: tags.location_id, membershipId: null }, async tx => {
    const [row] = await tx<{ to_email: string }[]>`select to_email from email_outbox where id=${tags.outbox_id}
      and provider='maileroo' and provider_id=${event.message_reference_id} and location_id=${tags.location_id} for update`;
    const recipients = Array.isArray(event.event_data.to) ? event.event_data.to : [event.event_data.to];
    if (!row || !recipients.some(r => r?.trim().toLowerCase() === row.to_email.trim().toLowerCase())) return;
    await tx`update email_outbox set delivery_state=${state},delivery_at=now(),last_reconciled_at=now()
      where id=${tags.outbox_id} and (delivery_state is null or
        array_position(array['delayed','soft_bounce','delivered','hard_bounce','complained'],delivery_state)
        < array_position(array['delayed','soft_bounce','delivered','hard_bounce','complained'],${state}))`;
    if (state === 'hard_bounce' || state === 'complained') {
      const email = row.to_email.trim().toLowerCase();
      const reason = state === 'complained' ? 'complaint' : 'hard_bounce';
      await tx`insert into email_suppressions(email,reason,provider_id) values(${email},${reason},${event.message_reference_id})
        on conflict(email) do update set reason=case when excluded.reason='complaint' then excluded.reason else email_suppressions.reason end,updated_at=now()`;
      if (state === 'complained') await tx`update customers set marketing_email_opt_in=false where org_id=${tags.org_id} and lower(email)=${email}`;
    }
  });
}
export function registerMailerooWebhook(app: FastifyInstance): void {
  app.post('/v1/webhooks/maileroo', async (req, reply) => {
    const raw = rawBodyOf(req);
    if (!verifyMailerooSignature(raw, req.headers['x-maileroo-signature'])) return reply.code(401).send({ ok: false });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reply.code(400).send({ ok: false }); }
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) {
      req.log.warn({ fields: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) }, 'maileroo callback schema mismatch');
      return reply.code(400).send({ ok: false });
    }
    await handleMailerooEvent(parsed.data);
    return { ok: true };
  });
}
