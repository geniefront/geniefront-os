import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  NotificationItem,
  NotificationFilterOptions,
  NotificationStats,
} from './types';

/** 见 `features/profile/api.ts` 中同名函数的说明。 */
function assertMembership(membershipId: string | null): string {
  if (!membershipId) throw new Error('NO_ACTIVE_MEMBERSHIP');
  return membershipId;
}

export const notificationKeys = {
  all: ['desk', 'notifications'] as const,
  list: (membershipId?: string | null, filters?: NotificationFilterOptions) =>
    ['desk', 'notifications', 'list', membershipId, filters] as const,
  stats: (membershipId?: string | null) =>
    ['desk', 'notifications', 'stats', membershipId] as const,
};

/**
 * ⚠️ **本模块不得保留本地兜底数据。**
 * 此前接口失败时会回落到一份内置的示例通知（SEED_NOTIFICATIONS）并把已读状态
 * 写入 localStorage，标记已读、删除、清理等操作即便被服务端拒绝也照样成功返回。
 * 其结果是：门店以为自己在处理真实待办，而实际处理的是一份本地副本。
 * 所对应的服务端接口与命令均已实现，异常一律向上抛出。
 */

export function useNotificationsQuery(filters?: NotificationFilterOptions) {
  const { membershipId, status } = useSession();

  return useQuery({
    queryKey: notificationKeys.list(membershipId, filters),
    queryFn: async (): Promise<NotificationItem[]> => {
      const queryParams = new URLSearchParams();
      if (filters?.category && filters.category !== 'all') {
        queryParams.append('category', filters.category);
      }
      if (filters?.unreadOnly) {
        queryParams.append('unreadOnly', 'true');
      }
      const remote = await apiGet<{ notifications: NotificationItem[] }>(
        `/v1/desk/notifications?${queryParams.toString()}`,
      );
      let items: NotificationItem[] = Array.isArray(remote?.notifications)
        ? remote.notifications
        : [];

      // 分类与未读由服务端过滤；关键词检索在本地进行，避免为逐字输入产生请求
      if (filters?.searchQuery?.trim()) {
        const q = filters.searchQuery.toLowerCase();
        items = items.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            n.message.toLowerCase().includes(q) ||
            n.meta?.customerName?.toLowerCase().includes(q) ||
            n.meta?.serviceName?.toLowerCase().includes(q) ||
            n.meta?.ticketId?.toLowerCase().includes(q),
        );
      }

      return items;
    },
    enabled: status === 'ready' || status === 'selecting',
    refetchInterval: 20_000,
    /*
     * 切换分类标签时留着上一组结果，别把列表清空。
     *
     * 这里保留旧数据是安全的：通知列表不承载「当前正在操作哪一单」这类会被
     * 误读的上下文，最坏情况只是多看了一眼上一个分类；而每次点标签都闪一次
     * 空列表，在门店 iPad 上翻分类时非常晃眼。
     *
     * 与日程不同 —— 日程的旧数据属于**另一个营业日**，会被误读成经营事实，
     * 因此那边必须配一层遮罩，见 `features/schedule/api.ts`。
     */
    placeholderData: (previous) => previous,
  });
}

export function useNotificationStatsQuery() {
  const { membershipId, status } = useSession();

  return useQuery({
    queryKey: notificationKeys.stats(membershipId),
    queryFn: async (): Promise<NotificationStats> => {
      return apiGet<NotificationStats>('/v1/desk/notifications/stats');
    },
    enabled: status === 'ready' || status === 'selecting',
    refetchInterval: 20_000,
  });
}

/**
 * ── 乐观更新的适用边界 ──────────────────────────────────────────────────────
 *
 * 本模块的「标记已读」与「全部已读」采用乐观更新：点下去红点立刻消失，不等
 * 服务端回话。这两个操作满足全部三个前提，缺一不可：
 *
 *   1. **幂等**：重复执行与执行一次结果相同，即便重试也不会产生第二个后果；
 *   2. **无金额、不可见于顾客**：判断错了顶多是红点晚一秒回来；
 *   3. **失败可无声回滚**：本地快照原样放回，用户看到的就是「没点上」。
 *
 * ⚠️ **删除不在此列，业务命令更不在此列。** 删除是不可逆的，先从列表里抹掉再
 * 因为失败把它变回来，用户会以为自己删错了、或者系统把删掉的东西又找了回来。
 * 开单、结账、退款一类更是绝对不能乐观 —— 「看起来成功了」与「真的成功了」
 * 在钱上的差别，前台要到日结对不上账时才发现。
 */
export function useMarkNotificationRead() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ notificationId }: { notificationId: string }) => {
      await runCommand('notification.markRead', { notificationId }, assertMembership(membershipId));
      return { notificationId };
    },
    onMutate: async ({ notificationId }) => {
      // 取消在途查询，否则它回来时会用旧数据盖掉刚写下的乐观结果
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });
      const snapshot = queryClient.getQueriesData({ queryKey: notificationKeys.all });

      queryClient.setQueriesData<NotificationItem[]>(
        { queryKey: ['desk', 'notifications', 'list'] },
        (current) => current?.map((item) => (item.id === notificationId ? { ...item, read: true } : item)),
      );
      queryClient.setQueriesData<NotificationStats>(
        { queryKey: ['desk', 'notifications', 'stats'] },
        (current) => (current ? { ...current, unread: Math.max(0, current.unread - 1) } : current),
      );

      return { snapshot };
    },
    onError: (_error, _input, context) => {
      // 原样放回：用户看到的就是「没点上」，而不是一个已读了又变回未读的条目
      context?.snapshot.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (category?: string | void) => {
      await runCommand('notification.markAllRead', { category }, assertMembership(membershipId));
      return { category };
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });
      const snapshot = queryClient.getQueriesData({ queryKey: notificationKeys.all });

      queryClient.setQueriesData<NotificationItem[]>(
        { queryKey: ['desk', 'notifications', 'list'] },
        (current) => current?.map((item) => ({ ...item, read: true })),
      );
      queryClient.setQueriesData<NotificationStats>(
        { queryKey: ['desk', 'notifications', 'stats'] },
        (current) => (current ? { ...current, unread: 0 } : current),
      );

      return { snapshot };
    },
    onError: (_error, _input, context) => {
      context?.snapshot.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useDeleteNotification() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ notificationId }: { notificationId: string }) => {
      await runCommand('notification.delete', { notificationId }, assertMembership(membershipId));
      return { notificationId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useClearReadNotifications() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await runCommand('notification.clearRead', {}, assertMembership(membershipId));
      return { ok: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
