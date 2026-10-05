import { beforeEach, expect, it, vi } from 'vitest';
import type { CommandContext } from '@gf/contracts';
vi.mock('@gf/db', () => ({ withTenant: vi.fn(async (_ctx, fn) => fn({})) }));
vi.mock('./offers', () => ({ loadVoiceOffers: vi.fn() }));
vi.mock('./references', async importOriginal => ({
  ...await importOriginal<typeof import('./references')>(),
  claimInitialSnapshot: vi.fn(), publishInitialSnapshot: vi.fn(), failInitialSnapshot: vi.fn(),
}));
import { refreshVoiceSnapshot } from './snapshotRefresh';
import { loadVoiceOffers } from './offers';
import { claimInitialSnapshot, publishInitialSnapshot, failInitialSnapshot } from './references';
const ctx = { locationId: 'test-shop', orgId: 'test-org' } as CommandContext;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(claimInitialSnapshot).mockResolvedValue({ leaseId: '11111111-1111-4111-8111-111111111111', revision: '42' });
  vi.mocked(publishInitialSnapshot).mockResolvedValue(true);
});

it('coalesces same-shop refreshes and only publishes the captured lease revision', async () => {
  let finish!: (value: any) => void;
  vi.mocked(loadVoiceOffers).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = refreshVoiceSnapshot(ctx, 'secret');
  const second = refreshVoiceSnapshot(ctx, 'secret');
  expect(first).toBe(second);
  await vi.waitFor(() => expect(loadVoiceOffers).toHaveBeenCalledTimes(1));
  finish({ coverage: {}, offers: [] });
  expect(await first).toBe(true);
  expect(publishInitialSnapshot).toHaveBeenCalledWith({}, ctx, expect.any(String),
    { leaseId: '11111111-1111-4111-8111-111111111111', revision: '42' }, { coverage: {}, offers: [] });
});

it('does no calculation when another worker owns the lease', async () => {
  vi.mocked(claimInitialSnapshot).mockResolvedValue(null);
  expect(await refreshVoiceSnapshot(ctx, 'secret')).toBe(false);
  expect(loadVoiceOffers).not.toHaveBeenCalled();
});

it('backs off after failure without publishing, then allows a later retry', async () => {
  vi.mocked(loadVoiceOffers).mockRejectedValueOnce(new Error('calculation failed'));
  await expect(refreshVoiceSnapshot(ctx, 'secret')).rejects.toThrow('calculation failed');
  expect(failInitialSnapshot).toHaveBeenCalledWith({}, ctx, '11111111-1111-4111-8111-111111111111');
  expect(publishInitialSnapshot).not.toHaveBeenCalled();
  vi.mocked(loadVoiceOffers).mockResolvedValue({ offers: [] } as any);
  expect(await refreshVoiceSnapshot(ctx, 'secret')).toBe(true);
});

it('does not report success after losing its lease', async () => {
  vi.mocked(loadVoiceOffers).mockResolvedValue({ offers: [] } as any);
  vi.mocked(publishInitialSnapshot).mockResolvedValue(false);
  expect(await refreshVoiceSnapshot(ctx, 'secret')).toBe(false);
});
