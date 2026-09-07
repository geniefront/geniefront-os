/**
 * 外部评价采集链路（05 §8）。
 *
 * 这套测试盯的是这条链路上**只会静默出错**的几个地方：
 *   · 同一条评价抓两次不能变成两行
 *   · 已经分析/处理过的评价不能被第二次抓取重置
 *   · 触发之前必须先占住位置 —— 否则并发会重复计费
 *   · 卡住的采集必须超时，否则唯一索引会把这家店永久堵死
 *   · 最新一条评价没变时**一个 token 都不许花**
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import type { CommandContext, Permission } from '@gf/contracts';
import {
  fetchSnapshot, snapshotProgress, triggerSnapshot,
} from '@gf/brightdata';
import { analyzeReviews, summarizeReviews } from '@gf/ai';
import { advanceReviewSync } from './reviews/sync';
import { analyzeNewReviews, generateReviewSummary } from './reviews/analyze';
import { dispatch } from './bus';
import './handlers/reviews';

vi.mock('@gf/brightdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gf/brightdata')>();
  return {
    ...actual,
    triggerSnapshot: vi.fn(),
    snapshotProgress: vi.fn(),
    fetchSnapshot: vi.fn(),
  };
});

vi.mock('@gf/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gf/ai')>();
  return { ...actual, analyzeReviews: vi.fn(), summarizeReviews: vi.fn() };
});

const triggerMock = vi.mocked(triggerSnapshot);
const progressMock = vi.mocked(snapshotProgress);
const fetchMock = vi.mocked(fetchSnapshot);
const analyzeMock = vi.mocked(analyzeReviews);
const summarizeMock = vi.mocked(summarizeReviews);

const ORG = '11111111-1111-4111-8111-111111111111';
const LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: ORG, locationId: LOC, membershipId: null };

const PERMISSIONS: readonly Permission[] = ['report.view', 'ai.use', 'settings.manage'];

const ctx: CommandContext = {
  orgId: ORG,
  locationId: LOC,
  userId: '00000000-0000-4000-8000-000000000000',
  membershipId: null,
  permissions: new Set(PERMISSIONS),
  actorKind: 'api',
  locale: 'en',
  timezone: 'America/New_York',
};

const usage = {
  inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
};

const envBefore: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in envBefore)) envBefore[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function clearReviewTables(): Promise<void> {
  await withTenant(tenant, async (tx) => {
    await tx`delete from review_sync_runs where location_id = ${LOC}`;
    await tx`delete from review_summaries where location_id = ${LOC}`;
    await tx`delete from location_reviews where location_id = ${LOC}`;
    await tx`delete from location_review_stats where location_id = ${LOC}`;
  });
}

const googleRecord = (id: string, text: string, rating = 5) => ({
  review_id: id, reviewer_name: 'Amy', review_text: text, review_rating: rating,
  review_datetime_utc: '2026-08-01T10:00:00Z', review_url: `https://maps.example/${id}`,
  rating: 4.4, reviews_cnt: 218,
});

/** 走完一次「触发 → 就绪 → 入库」，返回最后一次推进的结果 */
async function runFullSync(records: Record<string, unknown>[]) {
  triggerMock.mockResolvedValue('snap_1');
  progressMock.mockResolvedValue({ status: 'ready', records: records.length, error: null });
  fetchMock.mockResolvedValue(records);

  // force 跳过「距上次采集多久」的节流 —— 测试里两轮之间只隔几毫秒
  await advanceReviewSync(ctx, 'google', { force: true });   // 触发
  return advanceReviewSync(ctx, 'google', { force: true });  // 取结果并入库
}

beforeAll(async () => {
  setEnv('BRIGHT_DATA_API_KEY', 'brd-test');
  setEnv('BRIGHT_DATA_COST_PER_RECORD_MILLICENTS', '150');
  setEnv('OPENAI_API_KEY', 'test-openai-key');
  // 门店必须先配好抓取入参，否则整条链路会正确地跳过
  await withTenant(tenant, (tx) => tx`
    update locations set google_maps_url = 'https://maps.example/shop'
    where id = ${LOC}`);
});

afterAll(async () => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await withTenant(tenant, (tx) => tx`
    update locations set google_maps_url = null where id = ${LOC}`);
  await closeDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearReviewTables();
});

afterEach(async () => {
  await clearReviewTables();
});

describe('Bright Data 采集状态机', () => {
  it('先登记再触发 —— 占位失败时一分钱都不花', async () => {
    const calls: string[] = [];
    triggerMock.mockImplementation(async () => { calls.push('trigger'); return 'snap_1'; });
    progressMock.mockResolvedValue({ status: 'running', records: null, error: null });

    const first = await advanceReviewSync(ctx, 'google');
    expect(first.state).toBe('started');

    // 第二次推进撞上「一店一平台只能有一次进行中的采集」——
    // 它会去查进度，绝不会再触发一次
    const second = await advanceReviewSync(ctx, 'google', { force: true });
    expect(second.state).toBe('running');
    expect(calls).toHaveLength(1);
  });

  it('抓到的评价写进 location_reviews，并记下费用', async () => {
    const outcome = await runFullSync([
      googleRecord('g1', 'Amy 的手法很好'),
      googleRecord('g2', '周末等了四十分钟', 2),
    ]);

    expect(outcome.state).toBe('ingested');
    expect(outcome.inserted).toBe(2);
    // 计费按返回条数：2 × 150 毫分
    expect(outcome.costMillicents).toBe(300);

    const rows = await withTenant(tenant, (tx) => tx<{
      external_id: string; content: string; is_excerpt: boolean; source: string;
    }[]>`
      select external_id, content, is_excerpt, source from location_reviews
      where location_id = ${LOC} order by external_id`);
    expect(rows.map((r) => r.external_id)).toEqual(['g1', 'g2']);
    expect(rows[0]!.source).toBe('bright_data');
    // 抓取拿到的是完整正文，不是截断摘录
    expect(rows[0]!.is_excerpt).toBe(false);

    const [run] = await withTenant(tenant, (tx) => tx<{
      status: string; fetched_count: number; inserted_count: number; cost_millicents: number;
    }[]>`
      select status, fetched_count, inserted_count, cost_millicents
      from review_sync_runs where location_id = ${LOC}`);
    expect(run).toMatchObject({
      status: 'done', fetched_count: 2, inserted_count: 2, cost_millicents: 300,
    });
  });

  it('同一条评价抓第二次不产生第二行，也不重置人工与 AI 的结果', async () => {
    await runFullSync([googleRecord('g1', '原始正文')]);

    // 模拟这条评价已经被回复过并分析过
    await withTenant(tenant, (tx) => tx`
      update location_reviews
      set status = 'replied', ai_sentiment = 'positive',
          ai_highlights = '["Amy"]'::jsonb, technician_name = 'Amy'
      where location_id = ${LOC} and external_id = 'g1'`);

    const second = await runFullSync([googleRecord('g1', '平台上改过的正文')]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);

    const rows = await withTenant(tenant, (tx) => tx<{
      n: number; content: string; status: string; ai_sentiment: string | null;
      technician_name: string | null;
    }[]>`
      select count(*) over ()::int as n, content, status, ai_sentiment, technician_name
      from location_reviews where location_id = ${LOC}`);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('平台上改过的正文');
    // ⭐ 已回复的差评不该因为又被抓到一次就退回「未处理」
    expect(rows[0]!.status).toBe('replied');
    expect(rows[0]!.ai_sentiment).toBe('positive');
    expect(rows[0]!.technician_name).toBe('Amy');
  });

  it('抓取结果里的平台评分按天写进 location_review_stats', async () => {
    await runFullSync([googleRecord('g1', '很好')]);
    const [stats] = await withTenant(tenant, (tx) => tx<{
      rating_bp: number; review_count: number;
    }[]>`
      select rating_bp, review_count from location_review_stats
      where location_id = ${LOC} and platform = 'google'`);
    // 4.4 → 44000 basis point，不是浮点
    expect(stats).toMatchObject({ rating_bp: 44_000, review_count: 218 });
  });

  it('卡住的采集会超时标失败，让下一轮能重新开始', async () => {
    triggerMock.mockResolvedValue('snap_stuck');
    progressMock.mockResolvedValue({ status: 'running', records: null, error: null });
    await advanceReviewSync(ctx, 'google');

    // 把这次采集挪到很久以前
    await withTenant(tenant, (tx) => tx`
      update review_sync_runs set requested_at = now() - interval '10 hours'
      where location_id = ${LOC}`);

    const timedOut = await advanceReviewSync(ctx, 'google');
    expect(timedOut.state).toBe('timed_out');

    const [run] = await withTenant(tenant, (tx) => tx<{ status: string; error: string }[]>`
      select status, error from review_sync_runs where location_id = ${LOC}`);
    expect(run).toMatchObject({ status: 'failed', error: 'snapshot_timeout' });

    // 堵塞解除：可以开新的一轮
    const restarted = await advanceReviewSync(ctx, 'google', { force: true });
    expect(restarted.state).toBe('started');
  });

  it('触发失败立刻收尾，不留下占着位置的 running', async () => {
    triggerMock.mockRejectedValue(new Error('bright_data_down'));
    const outcome = await advanceReviewSync(ctx, 'google');
    expect(outcome.state).toBe('failed');

    const [run] = await withTenant(tenant, (tx) => tx<{ status: string; error: string }[]>`
      select status, error from review_sync_runs where location_id = ${LOC}`);
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('bright_data_down');
  });

  it('门店没配这个平台的标识就跳过 —— 这是正常状态，不是故障', async () => {
    const outcome = await advanceReviewSync(ctx, 'yelp');
    expect(outcome.state).toBe('not_configured');
    const runs = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from review_sync_runs where location_id = ${LOC}`);
    expect(runs[0]!.n).toBe(0);
  });
});

describe('AI 分析与摘要', () => {
  beforeEach(async () => {
    await runFullSync([
      googleRecord('g1', 'Amy 的手法很好'),
      googleRecord('g2', '周末等了四十分钟', 2),
    ]);
    vi.clearAllMocks();
  });

  it('只分析还没分析过的评价，结果回填到那两列', async () => {
    analyzeMock.mockImplementation(async ({ reviews }) => ({
      content: {
        items: reviews.map((review) => ({
          id: review.id,
          sentiment: (review.rating ?? 5) >= 4 ? 'positive' as const : 'negative' as const,
          highlights: ['等位时间'],
        })),
      },
      model: 'claude-sonnet-5',
      usage,
    }));

    const first = await analyzeNewReviews(ctx);
    expect(first.state).toBe('done');
    expect(first.updated).toBe(2);

    const rows = await withTenant(tenant, (tx) => tx<{
      external_id: string; ai_sentiment: string; ai_highlights: unknown;
    }[]>`
      select external_id, ai_sentiment, ai_highlights from location_reviews
      where location_id = ${LOC} order by external_id`);
    expect(rows[0]!.ai_sentiment).toBe('positive');
    expect(rows[1]!.ai_sentiment).toBe('negative');
    expect(rows[0]!.ai_highlights).toEqual(['等位时间']);

    // 第二次没有未分析的评价 —— 一个 token 都不该花
    analyzeMock.mockClear();
    const second = await analyzeNewReviews(ctx);
    expect(second.state).toBe('nothing_to_do');
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('模型返回认不出的 id 时不会静默更新到零行', async () => {
    analyzeMock.mockResolvedValue({
      content: {
        items: [{
          id: '99999999-9999-4999-8999-999999999999',
          sentiment: 'positive', highlights: ['编出来的'],
        }],
      },
      model: 'claude-sonnet-5',
      usage,
    });

    const outcome = await analyzeNewReviews(ctx);
    expect(outcome.updated).toBe(0);
  });

  it('生成摘要，分数取平台权威值而不是模型算的平均分', async () => {
    summarizeMock.mockResolvedValue({
      content: {
        overview: '整体口碑稳定。',
        topKeywords: [{ tag: '等位', count: 1, sentiment: 'warning' }],
        actionableSuggestions: [
          { type: 'warning', title: '周末加人', description: '周末下午建议加一名排班。' },
        ],
        keyPositiveThemes: ['Amy 的手法'],
        keyNegativeThemes: ['周末等位超过 30 分钟'],
        confidence: 'high',
      },
      model: 'claude-sonnet-5',
      usage,
    });

    const outcome = await generateReviewSummary(ctx);
    expect(outcome.state).toBe('generated');

    const [row] = await withTenant(tenant, (tx) => tx<{
      summary_content: Record<string, unknown>; coverage: unknown; latest_review_id: string;
    }[]>`
      select summary_content, coverage, latest_review_id from review_summaries
      where location_id = ${LOC}`);

    // 抓取时写进 stats 的 4.4 分，不是模型自己算的
    expect(row!.summary_content['sentimentScoreBp']).toBe(44_000);
    expect(row!.coverage).toEqual({ google: 2 });
    // 样本只有两条 —— 置信度被强制降级
    expect(row!.summary_content['confidence']).toBe('low');
    expect(row!.latest_review_id).toBeTruthy();
  });

  it('最新一条评价没变就不调模型（§8.2 的增量判断）', async () => {
    summarizeMock.mockResolvedValue({
      content: {
        overview: '整体口碑稳定。',
        topKeywords: [], actionableSuggestions: [],
        keyPositiveThemes: [], keyNegativeThemes: [], confidence: 'medium',
      },
      model: 'claude-sonnet-5',
      usage,
    });

    await generateReviewSummary(ctx);
    summarizeMock.mockClear();

    const second = await generateReviewSummary(ctx);
    expect(second.state).toBe('unchanged');
    expect(summarizeMock).not.toHaveBeenCalled();
  });
});

describe('系统自有命令不对租户开放（AUD-01）', () => {
  it('不带 systemOrigin 的 reviews.ingest 会被拒', async () => {
    await expect(dispatch('reviews.ingest', {
      platform: 'google', source: 'bright_data',
      reviews: [{
        externalId: 'x1', rating: 5, authorName: null, content: '好',
        isExcerpt: false, url: null, postedAt: null,
      }],
    }, ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
