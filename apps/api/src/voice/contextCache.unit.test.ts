import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CommandContext } from '@gf/contracts';
import type { InitialSnapshotRecord } from './references';

vi.mock('@gf/db', () => ({ withTenant: vi.fn(async (_ctx, fn) => fn({})) }));
vi.mock('./offers', () => ({ loadVoiceOffers: vi.fn(() => { throw new Error('API must never compute a snapshot'); }) }));
vi.mock('./references', async importOriginal => ({
  ...await importOriginal<typeof import('./references')>(),
  readInitialSnapshot: vi.fn(), requestInitialSnapshot: vi.fn(),
}));
import { initialVoiceContext, requestVoiceSnapshot, usableSnapshot } from './contextCache';
import { readInitialSnapshot, requestInitialSnapshot, referenceScope } from './references';
import { loadVoiceOffers } from './offers';

const ctx = { locationId: 'test-shop', orgId: 'test-org' } as CommandContext;
const now = Date.parse('2026-10-05T15:00:00Z');
function snapshot(): InitialSnapshotRecord {
  return {
    scope: referenceScope('secret'), generatedAt: new Date(now - 60_000).toISOString(),
    refreshAfter: new Date(now - 1).toISOString(), retryAfter: new Date(now).toISOString(),
    clean: false, revision: '1', leaseUntil: new Date(now + 10_000).toISOString(),
    payload: { shop: { timezone: 'America/New_York', currentTime: 'old' },
      coverage: { from: '2026-10-05', generatedAt: new Date(now - 60_000).toISOString() }, offers: [] },
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

it('serves a usable stale snapshot while a worker holds its lease, without computing or mutating it', async () => {
  const row = snapshot();
  vi.mocked(readInitialSnapshot).mockResolvedValue(row);
  const result = await initialVoiceContext(ctx, 'secret');
  expect(result.coverage).toMatchObject({ stale: true, refreshing: true, expiresInSeconds: 240 });
  expect((row.payload as any).shop.currentTime).toBe('old');
  expect(requestInitialSnapshot).not.toHaveBeenCalled();
  expect(loadVoiceOffers).not.toHaveBeenCalled();
});

it.each(['missing', 'expired', 'wrong-scope', 'previous-day'] as const)(
  'queues %s cache and returns retryable 503 without doing CPU work or waiting for it', async mode => {
    const row = snapshot();
    if (mode === 'expired') row.generatedAt = new Date(now - 300_000).toISOString();
    if (mode === 'wrong-scope') row.scope = 'old-credential';
    if (mode === 'previous-day') (row.payload as any).coverage.from = '2026-10-04';
    vi.mocked(readInitialSnapshot).mockResolvedValue(mode === 'missing' ? undefined : row);
    await expect(initialVoiceContext(ctx, 'secret')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE', details: { reason: 'context_refreshing', retryable: true, retryAfterSeconds: 5 },
    });
    expect(requestInitialSnapshot).toHaveBeenCalledWith({}, ctx, referenceScope('secret'), true);
    expect(loadVoiceOffers).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('rejects invalid timestamps, future snapshots and non-object payloads', () => {
  for (const generatedAt of ['bad-date', new Date(now + 1).toISOString()]) {
    expect(usableSnapshot({ ...snapshot(), generatedAt }, referenceScope('secret'), now)).toBe(false);
  }
  expect(usableSnapshot({ ...snapshot(), payload: 'invalid' }, referenceScope('secret'), now)).toBe(false);
});

it('prewarms by scheduling a refresh, never by computing inside the request', async () => {
  await requestVoiceSnapshot(ctx, 'secret');
  expect(requestInitialSnapshot).toHaveBeenCalledWith({}, ctx, referenceScope('secret'));
  expect(loadVoiceOffers).not.toHaveBeenCalled();
});
