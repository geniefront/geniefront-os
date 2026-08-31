/**
 * 外部评价采集的数据层（05-AI-INTEGRATION §8）。
 *
 * 读：`GET /v1/desk/reviews/sources`、`GET /v1/desk/reviews/sync-runs`
 * 写：采集配置走命令总线；手动同步走编排接口 —— 它不是一次写库，
 *     而是「去调外部服务、按结果推进状态机」，与副驾摘要生成同类
 *     （`analytics/api.ts` 的 copilot-summary/generate 是同一条路）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  ConfigureReviewSourcesInput, ManualSyncResponse, ReviewSources, ReviewSyncRun,
} from './types';

export const reviewKeys = {
  sources: (membershipId: string | null) => ['desk', 'reviews', 'sources', membershipId] as const,
  syncRuns: (membershipId: string | null) => ['desk', 'reviews', 'syncRuns', membershipId] as const,
};

export function useReviewSourcesQuery(opts?: { enabled?: boolean }) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: reviewKeys.sources(membershipId),
    queryFn: () => apiGet<ReviewSources>('/v1/desk/reviews/sources'),
    enabled: (opts?.enabled ?? true) && status === 'ready' && membershipId !== null,
  });
}

export function useReviewSyncRunsQuery(opts?: { enabled?: boolean }) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: reviewKeys.syncRuns(membershipId),
    queryFn: () => apiGet<ReviewSyncRun[]>('/v1/desk/reviews/sync-runs?limit=20'),
    enabled: (opts?.enabled ?? true) && status === 'ready' && membershipId !== null,
  });
}

export function useSaveReviewSources() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: ConfigureReviewSourcesInput) => {
      const res = await runCommand<{ locationId: string; configured: string[] }>(
        'location.configureReviewSources', input, membershipId!);
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.sources(membershipId) });
    },
  });
}

/**
 * 手动同步。
 *
 * ⚠️ **这一下立刻产生抓取费用**（Bright Data 按记录条数计费），而且可能接着调模型。
 * 按钮那一侧必须先让人确认过再调 —— 它的用途是上线前把整条链路走一遍，
 * 不是一个可以随手点着玩的刷新键。
 *
 * 抓取是异步的，服务端最多在请求里等 45 秒；没等到就返回 `running`，
 * 稍后刷新同步日志能看到结果。
 */
export function useRunReviewSync() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: (input: { platform?: 'google' | 'yelp' }) =>
      apiPost<ManualSyncResponse>('/v1/desk/reviews/sync', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.syncRuns(membershipId) });
      void queryClient.invalidateQueries({ queryKey: reviewKeys.sources(membershipId) });
      // 口碑页面上的分数与摘要也变了
      void queryClient.invalidateQueries({ queryKey: ['desk', 'analytics', 'reviewsSummary'] });
    },
  });
}
