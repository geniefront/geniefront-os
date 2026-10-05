import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { mailerooAddress, mailerooSendEmail, mailerooReferenceId, MailerooError } from './maileroo';
import { emailProvider, providerConfigured } from './provider';
import { handleMailerooEvent, mailerooEventState, registerMailerooWebhook, verifyMailerooSignature } from './mailerooWebhook';
import { registerRawBodyParser } from '../rawBody';
const db = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('@gf/db', () => db);
const ids = { outbox_id: '11111111-1111-4111-8111-111111111111', org_id: '22222222-2222-4222-8222-222222222222', location_id: '33333333-3333-4333-8333-333333333333' };
const event = { event_id: 'event-1', event_type: 'delivered', tags: ids, message_reference_id: mailerooReferenceId(ids.outbox_id), event_data: { to: 'customer@example.com' } };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('Maileroo delivery', () => {
  it('selects Maileroo without falling through to legacy credentials', () => {
    expect(emailProvider({ EMAIL_PROVIDER: ' Maileroo ' })).toBe('maileroo');
    expect(providerConfigured({ EMAIL_PROVIDER: 'maileroo', RESEND_API_KEY: 'legacy' })).toBe(false);
    expect(providerConfigured({ EMAIL_PROVIDER: 'maileroo', MAILEROO_API_KEY: 'sending' })).toBe(true);
    expect(() => emailProvider({ EMAIL_PROVIDER: 'mailero' })).toThrow();
  });
  it('preserves sender names, replies, content and correlates delivery before network IO', async () => {
    vi.stubEnv('MAILEROO_API_KEY', 'test-sending-key');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { reference_id: event.message_reference_id } })));
    vi.stubGlobal('fetch', fetch);
    await expect(mailerooSendEmail({ from: 'GenieFront <noreply@notify.geniefront.com>', to: 'customer@example.com', replyTo: 'Salon <salon@example.com>',
      subject: 'Booking', html: '<p>Booking</p>', text: 'Booking', outboxId: ids.outbox_id, orgId: ids.org_id, locationId: ids.location_id,
    })).resolves.toEqual({ reference_id: event.message_reference_id });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://smtp.maileroo.com/api/v2/emails');
    expect(JSON.parse(options.body)).toMatchObject({ from: { address: 'noreply@notify.geniefront.com', display_name: 'GenieFront' },
      reply_to: { address: 'salon@example.com', display_name: 'Salon' }, plain: 'Booking', tracking: false, tags: ids, reference_id: event.message_reference_id });
    expect(mailerooAddress('one@example.com')).toEqual({ address: 'one@example.com' });
  });
  it('redacts upstream bodies and distinguishes throttling from permanent rejections', async () => {
    vi.stubEnv('MAILEROO_API_KEY', 'test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('credential leaked upstream', { status: 401 })));
    await expect(mailerooSendEmail({ from: 'a@example.com', to: 'b@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow('maileroo_http_401');
    expect(new MailerooError(429).permanent).toBe(false);
    expect(new MailerooError(408).permanent).toBe(false);
    expect(new MailerooError(500).permanent).toBe(false);
    expect(new MailerooError(400).permanent).toBe(true);
  });
  it('treats malformed acceptance as uncertain instead of retryable success', async () => {
    vi.stubEnv('MAILEROO_API_KEY', 'test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))));
    await expect(mailerooSendEmail({ from: 'a@example.com', to: 'b@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow('maileroo_http_502');
  });
  it('verifies the exact bytes and rejects absent/malformed signatures', () => {
    const raw = '{ "hello": "world" }';
    const signature = createHmac('sha256', 'secret').update(raw).digest('hex');
    expect(verifyMailerooSignature(raw, signature, 'secret')).toBe(true);
    expect(verifyMailerooSignature(JSON.stringify(JSON.parse(raw)), signature, 'secret')).toBe(false);
    expect(verifyMailerooSignature(raw, 'bad', 'secret')).toBe(false);
    expect(verifyMailerooSignature(raw, signature, '')).toBe(false);
  });
  it('does not permanently suppress full or temporarily unavailable mailboxes', () => {
    expect(mailerooEventState({ ...event, event_type: 'failed', event_data: { reason: '452 4.2.2 mailbox full' } })).toBe('soft_bounce');
    expect(mailerooEventState({ ...event, event_type: 'failed', event_data: { reason: '550 5.1.1 user unknown' } })).toBe('hard_bounce');
    expect(mailerooEventState({ ...event, event_type: 'complained' })).toBe('complained');
    expect(mailerooEventState({ ...event, event_type: 'deferred' })).toBe('delayed');
  });
  it('only updates the known tenant message and matching recipient', async () => {
    const tx = vi.fn().mockResolvedValue([{ to_email: 'different@example.com' }]);
    db.withTenant.mockImplementation(async (_ctx, fn) => fn(tx));
    await handleMailerooEvent(event);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(db.withTenant).toHaveBeenCalledWith({ orgId: ids.org_id, locationId: ids.location_id, membershipId: null }, expect.any(Function));
    await handleMailerooEvent({ ...event, message_reference_id: 'unrelated' });
    expect(db.withTenant).toHaveBeenCalledTimes(1);
  });
  it('uses monotonic delivery updates and tenant-scoped complaint opt-outs', async () => {
    const tx = vi.fn().mockResolvedValue([{ to_email: 'customer@example.com' }]);
    db.withTenant.mockImplementation(async (_ctx, fn) => fn(tx));
    await handleMailerooEvent({ ...event, event_type: 'complained' });
    expect(tx).toHaveBeenCalledTimes(4);
    expect(tx.mock.calls[1]![0].join('')).toContain('array_position');
    expect(tx.mock.calls[3]![0].join('')).toContain('where org_id=');
  });
  it('accepts signed raw JSON with whitespace and refuses unsigned requests', async () => {
    const app = Fastify(); registerRawBodyParser(app); registerMailerooWebhook(app);
    vi.stubEnv('MAILEROO_WEBHOOK_SECRET', 'secret');
    const raw = JSON.stringify({ ...event, tags: null }, null, 2);
    try {
      expect((await app.inject({ method: 'POST', url: '/v1/webhooks/maileroo', payload: raw, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/v1/webhooks/maileroo', payload: raw, headers: { 'content-type': 'application/json', 'x-maileroo-signature': createHmac('sha256', 'secret').update(raw).digest('hex') } })).statusCode).toBe(200);
      expect(db.withTenant).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
