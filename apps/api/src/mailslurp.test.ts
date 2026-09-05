import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mailslurpEnabled, mailslurpCreateInbox, mailslurpAttachWebhook, mailslurpGetEmail } from './email/mailslurp';
import { buildServer } from './server';
import { closeDb } from '@gf/db';

let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  app = buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('MailSlurp Integration', () => {
  it('strictly disables MailSlurp in production env (safety invariant)', () => {
    vi.stubEnv('GF_ENV', 'production');
    vi.stubEnv('MAILSLURP_API_KEY', 'test-key');
    expect(mailslurpEnabled()).toBe(false);

    vi.stubEnv('GF_ENV', 'staging');
    expect(mailslurpEnabled()).toBe(true);

    vi.stubEnv('MAILSLURP_API_KEY', '');
    expect(mailslurpEnabled()).toBe(false);
  });

  it('mailslurpCreateInbox sends correct headers and body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'inbox-123',
      emailAddress: 'shop-123@sandbox.zazamail.link',
      name: 'shop-test'
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const inbox = await mailslurpCreateInbox('shop-test', 'mock-key');
    expect(inbox.id).toBe('inbox-123');
    expect(inbox.emailAddress).toBe('shop-123@sandbox.zazamail.link');

    expect(fetchMock).toHaveBeenCalledWith('https://api.mailslurp.com/inboxes', expect.objectContaining({
      method: 'POST',
      headers: { 'x-api-key': 'mock-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'shop-test' })
    }));
  });

  it('mailslurpAttachWebhook registers NEW_EMAIL webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'wh-123' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await mailslurpAttachWebhook('inbox-123', 'https://api.example.com/webhook', 'mock-key');
    expect(res.id).toBe('wh-123');
    expect(fetchMock).toHaveBeenCalledWith('https://api.mailslurp.com/inboxes/inbox-123/webhooks', expect.objectContaining({
      method: 'POST',
      headers: { 'x-api-key': 'mock-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://api.example.com/webhook', eventName: 'NEW_EMAIL' })
    }));
  });

  it('webhook endpoint /v1/webhooks/mailslurp behaves correctly', async () => {
    // 1. GET returns 200
    const getRes = await app.inject({ method: 'GET', url: '/v1/webhooks/mailslurp' });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({ ok: true, provider: 'mailslurp' });

    // 2. POST in non-production returns 200
    vi.stubEnv('GF_ENV', 'staging');
    const postRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mailslurp',
      payload: { eventName: 'NEW_EMAIL', inboxId: 'inbox-1', emailId: 'email-1', subject: 'Hello' }
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json()).toEqual({ ok: true, received: true });

    // 3. POST in production returns 403
    vi.stubEnv('GF_ENV', 'production');
    const prodPostRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mailslurp',
      payload: { eventName: 'NEW_EMAIL' }
    });
    expect(prodPostRes.statusCode).toBe(403);
  });

  it('provisionEmailAccount uses MailSlurp when enabled, without touching Elastic Email', async () => {
    vi.stubEnv('GF_ENV', 'staging');
    vi.stubEnv('MAILSLURP_API_KEY', 'test-key');
    vi.stubEnv('EMAIL_CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'));

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('api.mailslurp.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          id: 'ms-inbox-uuid',
          emailAddress: 'shop-test@sandbox.zazamail.link'
        }), { status: 201 }));
      }
      throw new Error(`Unexpected call to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const testTenant = {
      orgId: '11111111-1111-4111-8111-111111111111',
      locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      membershipId: null
    };

    const { provisionEmailAccount } = await import('./email/service');
    await provisionEmailAccount(testTenant);

    expect(fetchMock).toHaveBeenCalledWith('https://api.mailslurp.com/inboxes', expect.any(Object));
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toContain('elasticemail.com');
    }
  });
});
