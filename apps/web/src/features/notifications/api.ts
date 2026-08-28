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

export function useMarkNotificationRead() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ notificationId }: { notificationId: string }) => {
      await runCommand('notification.markRead', { notificationId }, assertMembership(membershipId));
      return { notificationId };
    },
    onSuccess: () => {
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
    onSuccess: () => {
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
