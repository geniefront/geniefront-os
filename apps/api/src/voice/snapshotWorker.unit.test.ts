import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
vi.mock('@gf/db', () => ({ sql: vi.fn(), withTenant: vi.fn() }));
vi.mock('./snapshotRefresh', () => ({ refreshVoiceSnapshot: vi.fn() }));
import { sql, withTenant } from '@gf/db';
import { refreshVoiceSnapshot } from './snapshotRefresh';
import { refreshVoiceSnapshots, startVoiceSnapshots } from './snapshotWorker';
const tenants = [{ org_id: 'org', location_id: 'one' }, { org_id: 'org', location_id: 'two' }];
const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyInstance['log'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sql).mockResolvedValue(tenants as any);
  vi.mocked(withTenant).mockResolvedValue([{ tool_token_digest: 'secret' }]);
  vi.mocked(refreshVoiceSnapshot).mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

it('limits a worker to one tenant calculation at a time', async () => {
  let active = 0, peak = 0;
  vi.mocked(refreshVoiceSnapshot).mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return true;
  });
  expect(await refreshVoiceSnapshots({ log })).toBe(2);
  expect(peak).toBe(1);
});

it('continues other tenants after a refresh fails', async () => {
  vi.mocked(refreshVoiceSnapshot).mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(true);
  expect(await refreshVoiceSnapshots({ log })).toBe(1);
  expect(log.warn).toHaveBeenCalled();
});

it('does not overlap sweeps and finishes its current tenant before stopping', async () => {
  vi.useFakeTimers();
  const hooks: Record<string, () => Promise<void>> = {};
  const app = { log, addHook: (name: string, hook: () => Promise<void>) => { hooks[name] = hook; } } as unknown as FastifyInstance;
  let finish!: (value: boolean) => void;
  vi.mocked(refreshVoiceSnapshot).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const status = startVoiceSnapshots(app);
  await hooks.onListen!();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(refreshVoiceSnapshot).toHaveBeenCalledTimes(1);
  expect(status().running).toBe(true);
  const closed = hooks.onClose!();
  finish(true); await closed;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(refreshVoiceSnapshot).toHaveBeenCalledTimes(1);
  expect(status().ok).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
