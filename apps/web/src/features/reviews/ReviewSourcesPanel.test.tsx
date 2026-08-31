/**
 * 口碑采集面板。
 *
 * 这套测试盯的都是「显示错了不会有人立刻发现」的地方：
 *   · 手动同步会花钱 —— 必须先确认
 *   · 清空一项并保存，要真的传 null（不传等于不动，抓取会照常发生）
 *   · 抓完了但没有新评价，不能显示成失败
 *   · 失败原因必须原样出现在同步记录里
 *   · 低可信度的结论必须标出来
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/LanguageContext';
import { ReviewConfidenceBadge, ReviewSourcesPanel } from './ReviewSourcesPanel';
import type { ManualSyncResponse, ReviewSources, ReviewSyncRun } from './types';

const toast = vi.hoisted(() => ({ success: vi.fn(), danger: vi.fn() }));

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast };
});

/** 权限：设置页对 staff.manage 也开放，但这一页要 settings.manage */
const canState = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/permissions', () => ({ useCan: () => canState.allowed }));

const sourcesState = { data: null as ReviewSources | null, isLoading: false };
const runsState = { data: [] as ReviewSyncRun[], isLoading: false };
const saveMutate = vi.fn();
const syncMutate = vi.fn();

vi.mock('./api', () => ({
  useReviewSourcesQuery: () => sourcesState,
  useReviewSyncRunsQuery: () => runsState,
  useSaveReviewSources: () => ({
    isPending: false,
    mutateAsync: (input: unknown) => saveMutate(input),
  }),
  useRunReviewSync: () => ({
    isPending: false,
    mutateAsync: (input: unknown) => syncMutate(input),
  }),
}));

const linked: ReviewSources = {
  googlePlaceId: 'ChIJabc',
  googleMapsUrl: 'https://maps.app.goo.gl/abc',
  yelpBusinessId: 'lucky-nails-boston',
  googleReady: true,
  yelpReady: true,
};

const syncResponse = (over: Partial<ManualSyncResponse['sync'][number]> = {}): ManualSyncResponse => ({
  stats: [],
  sync: [{
    platform: 'google', state: 'ingested', runId: 'r1',
    fetched: 12, inserted: 3, updated: 9, skipped: 0,
    costMillicents: 1800, error: null, ...over,
  }],
  analysis: { analyzed: 3, updated: 3, state: 'done' },
  summary: { state: 'generated', summaryId: 's1', reviewCount: 40, excerptRatioBp: 0 },
});

function renderPanel() {
  return render(
    <LanguageProvider>
      <ReviewSourcesPanel />
    </LanguageProvider>,
  );
}

/** 走一遍「点同步 → 在确认框里确认」 */
async function clickSyncAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /同步/ }));
  const confirm = await screen.findByRole('button', { name: '确认同步' });
  await user.click(confirm);
}

beforeEach(() => {
  toast.success.mockReset();
  toast.danger.mockReset();
  saveMutate.mockReset();
  syncMutate.mockReset();
  sourcesState.data = linked;
  runsState.data = [];
  canState.allowed = true;
});

describe('权限', () => {
  it('没有 settings.manage 时显示无权限，而不是两条失败的请求', () => {
    canState.allowed = false;
    renderPanel();
    expect(screen.getByText('没有权限访问系统设置')).toBeTruthy();
    expect(screen.queryByText('同步记录')).toBeNull();
  });
});

describe('采集配置', () => {
  it('未配置的平台显示未配置，配置好的显示已配置', () => {
    sourcesState.data = { ...linked, yelpBusinessId: null, yelpReady: false };
    renderPanel();
    expect(screen.getAllByText('已配置')).toHaveLength(1);
    expect(screen.getAllByText('未配置')).toHaveLength(1);
  });

  it('清空一项并保存时传 null —— 不传等于不动，抓取会照常发生', async () => {
    const user = userEvent.setup();
    renderPanel();

    const yelpInput = await screen.findByDisplayValue('lucky-nails-boston');
    await user.clear(yelpInput);
    await user.click(screen.getByRole('button', { name: '保存采集配置' }));

    await waitFor(() => expect(saveMutate).toHaveBeenCalledTimes(1));
    expect(saveMutate).toHaveBeenCalledWith({
      googleMapsUrl: 'https://maps.app.goo.gl/abc',
      googlePlaceId: 'ChIJabc',
      yelpBusinessId: null,
    });
  });
});

describe('手动同步', () => {
  it('会花钱，所以必须先确认 —— 直接点按钮不发请求', async () => {
    const user = userEvent.setup();
    syncMutate.mockResolvedValue(syncResponse());
    renderPanel();

    await user.click(screen.getByRole('button', { name: /同步/ }));
    expect(syncMutate).not.toHaveBeenCalled();
    // 确认框里说清楚了代价
    expect(await screen.findByText(/抓取按条数计费/)).toBeTruthy();
  });

  it('确认之后才真的同步，并报出抓到与新增的条数', async () => {
    const user = userEvent.setup();
    syncMutate.mockResolvedValue(syncResponse());
    renderPanel();

    await clickSyncAndConfirm(user);

    await waitFor(() => expect(syncMutate).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('抓到 12 条，新增 3 条');
  });

  it('抓完了但没有新评价 —— 说成常态，不说成失败', async () => {
    const user = userEvent.setup();
    syncMutate.mockResolvedValue(syncResponse({ fetched: 12, inserted: 0, updated: 12 }));
    renderPanel();

    await clickSyncAndConfirm(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('这是常态'));
    expect(toast.danger).not.toHaveBeenCalled();
  });

  it('抓取还在跑时告诉人稍后看记录，而不是报成功或失败', async () => {
    const user = userEvent.setup();
    syncMutate.mockResolvedValue(syncResponse({ state: 'started', fetched: 0, inserted: 0 }));
    renderPanel();

    await clickSyncAndConfirm(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('还在进行中'));
  });

  it('两个平台都没配时同步按钮不可点', () => {
    sourcesState.data = {
      googlePlaceId: null, googleMapsUrl: null, yelpBusinessId: null,
      googleReady: false, yelpReady: false,
    };
    renderPanel();
    expect(screen.getByRole('button', { name: /同步/ })).toHaveProperty('disabled', true);
  });
});

describe('同步记录', () => {
  it('失败原因原样显示 —— 翻译过的版本对不上排查', () => {
    runsState.data = [{
      id: 'r1', platform: 'google', source: 'bright_data', status: 'failed',
      requestedAt: '2026-08-31T10:00:00.000Z', finishedAt: '2026-08-31T10:04:00.000Z',
      attempts: 2, fetched: 0, inserted: 0, skipped: 0,
      costMillicents: 0, error: 'snapshot_timeout',
    }];
    renderPanel();

    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('snapshot_timeout')).toBeTruthy();
  });

  it('费用按毫分折成美元显示', () => {
    runsState.data = [{
      id: 'r1', platform: 'google', source: 'bright_data', status: 'done',
      requestedAt: '2026-08-31T10:00:00.000Z', finishedAt: '2026-08-31T10:04:00.000Z',
      attempts: 1, fetched: 12, inserted: 3, skipped: 0,
      costMillicents: 1800, error: null,
    }];
    renderPanel();
    // 1800 毫分 = 2 分 = $0.02
    expect(screen.getByText('$0.02')).toBeTruthy();
  });

  it('没有记录时显示空态，而不是一张空表', () => {
    renderPanel();
    expect(screen.getByText('还没有同步记录')).toBeTruthy();
  });
});

describe('结论可信度', () => {
  it('low 时标出「样本不完整」', () => {
    render(
      <LanguageProvider>
        <ReviewConfidenceBadge confidence="low" />
      </LanguageProvider>,
    );
    expect(screen.getByText('样本不完整，仅供参考')).toBeTruthy();
  });

  it('其余情况不加任何标记 —— 标签只用来降低轻信，不用来背书', () => {
    const { container } = render(
      <LanguageProvider>
        <ReviewConfidenceBadge confidence="high" />
      </LanguageProvider>,
    );
    expect(container.textContent).toBe('');
  });
});
