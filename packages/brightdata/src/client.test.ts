import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@gf/contracts';
import { fetchSnapshot, snapshotProgress, triggerSnapshot } from './client';

function stubFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return vi.fn(async (input: unknown, init?: unknown) =>
    handler(String(input), (init ?? {}) as RequestInit)) as unknown as typeof fetch;
}

const opts = (fetchImpl: typeof fetch) => ({
  apiKey: 'brd-test', datasetId: 'gd_test', fetchImpl,
});

describe('triggerSnapshot', () => {
  it('带上 dataset_id 与鉴权，返回 snapshot_id', async () => {
    let seenUrl = '';
    let seenBody: unknown;
    let seenAuth: string | undefined;
    const f = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      seenAuth = (init.headers as Record<string, string>)['Authorization'];
      return new Response(JSON.stringify({ snapshot_id: 's_123' }), { status: 200 });
    });

    const id = await triggerSnapshot(
      { url: 'https://www.yelp.com/biz/x', daysLimit: 30, limit: 50 }, opts(f));

    expect(id).toBe('s_123');
    expect(seenUrl).toContain('dataset_id=gd_test');
    expect(seenAuth).toBe('Bearer brd-test');
    expect(seenBody).toEqual([{ url: 'https://www.yelp.com/biz/x', days_limit: 30, num_of_reviews: 50 }]);
  });

  it('返回里没有 snapshot_id 视为上游不可用 —— 不能当成「抓到了 0 条」', async () => {
    const f = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    await expect(triggerSnapshot({ url: 'https://x' }, opts(f))).rejects.toBeInstanceOf(AppError);
  });

  it('429 单独标成 rate_limited，供重试策略区分', async () => {
    const f = stubFetch(() => new Response('', { status: 429 }));
    const err = await triggerSnapshot({ url: 'https://x' }, opts(f)).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toMatchObject({ reason: 'rate_limited' });
  });
});

describe('snapshotProgress', () => {
  it('collecting / building 都归为 running', async () => {
    for (const raw of ['running', 'collecting', 'building']) {
      const f = stubFetch(() => new Response(JSON.stringify({ status: raw }), { status: 200 }));
      expect((await snapshotProgress('s_1', opts(f))).status).toBe('running');
    }
  });

  it('ready 与 failed 原样映射，失败原因保留', async () => {
    const ready = stubFetch(() =>
      new Response(JSON.stringify({ status: 'ready', records: 42 }), { status: 200 }));
    expect(await snapshotProgress('s_1', opts(ready)))
      .toEqual({ status: 'ready', records: 42, error: null });

    const failed = stubFetch(() =>
      new Response(JSON.stringify({ status: 'failed', error: 'blocked' }), { status: 200 }));
    expect(await snapshotProgress('s_1', opts(failed)))
      .toEqual({ status: 'failed', records: null, error: 'blocked' });
  });
});

describe('fetchSnapshot', () => {
  it('接受裸数组与 { data: [] } 两种包装', async () => {
    const bare = stubFetch(() =>
      new Response(JSON.stringify([{ review_id: 'a' }]), { status: 200 }));
    expect(await fetchSnapshot('s_1', opts(bare))).toEqual([{ review_id: 'a' }]);

    const wrapped = stubFetch(() =>
      new Response(JSON.stringify({ data: [{ review_id: 'b' }] }), { status: 200 }));
    expect(await fetchSnapshot('s_1', opts(wrapped))).toEqual([{ review_id: 'b' }]);
  });

  it('尚未就绪返回的非数组当作空结果，不抛错 —— 抛错会触发重复计费的重试', async () => {
    const f = stubFetch(() =>
      new Response(JSON.stringify({ status: 'running' }), { status: 202 }));
    expect(await fetchSnapshot('s_1', opts(f))).toEqual([]);
  });
});
