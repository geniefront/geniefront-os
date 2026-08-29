import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resolveApiBase, setStoredDeviceToken } from './client';

describe('resolveApiBase', () => {
  it('rewrites a loopback API host when the Kiosk is opened from an iPad on LAN', () => {
    expect(resolveApiBase('http://127.0.0.1:3000', {
      protocol: 'http:', hostname: '192.168.1.25', origin: 'http://192.168.1.25:5178',
    }, true)).toBe('http://192.168.1.25:3000');
  });

  it('keeps loopback for a browser running on the development computer', () => {
    expect(resolveApiBase('http://127.0.0.1:3000', {
      protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:5178',
    }, true)).toBe('http://127.0.0.1:3000');
  });
});

describe('kiosk API client', () => {
  beforeEach(() => {
    localStorage.clear();
    setStoredDeviceToken('gfk_test-token');
    vi.restoreAllMocks();
  });

  it('sends device auth, visit context, and a stable idempotency key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      submissionId: '11111111-1111-4111-8111-111111111111', expiresOn: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await api.submitForm({
      templateId: '22222222-2222-4222-8222-222222222222',
      queueId: '33333333-3333-4333-8333-333333333333',
      answers: { safe: false },
      signerName: 'Guest',
      signerRelation: 'self',
      locale: 'en',
      idempotencyKey: 'idem-123',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('x-device-token')).toBe('gfk_test-token');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      queueId: '33333333-3333-4333-8333-333333333333',
      idempotencyKey: 'idem-123',
    });
  });
});
