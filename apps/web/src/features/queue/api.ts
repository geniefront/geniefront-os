/**
 * 候客队列数据层。
 *
 * 读：`GET /v1/desk/queue`（`date` 可省略，服务端按门店营业日兜底）。
 * 写：`queue.join` 取号、`queue.update` 叫号 / 入座 / 离场。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { QueueLeftReason, QueueStatus, QueueView } from './types';

export const queueKeys = {
  /** 键含 membershipId：多店切换时不得复用上一家门店的队列。 */
  list: (membershipId: string | null) => ['desk', 'queue', membershipId] as const,
};

export function useQueue() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: queueKeys.list(membershipId),
    queryFn: () => apiGet<QueueView>('/v1/desk/queue'),
    enabled: status === 'ready' && membershipId !== null,
    /*
     * 队列是门店里变化最快的一份数据：客人随时到店，技师随时空出来，
     * 而前台不会主动刷新页面。因此定时轮询。
     *
     * 20 秒是权衡结果 —— 更短会在网络较差的门店产生可感知负载，更长则会出现
     * 「客人已站在柜台前，屏幕上还没有他」。服务端已有 Realtime 通道
     * （`queue.changed` 事件），接入后应改为事件驱动，轮询降级为兜底。
     */
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

export interface JoinQueueInput {
  customerId?: string | null;
  /** 匿名到店客：只留姓名，事后可与正式客户档案合并。 */
  walkInName?: string;
  requestedServiceId?: string | null;
  requestedStaffId?: string | null;
  partySize?: number;
  /** 有预约的客人到店签到时传入，队列条目与该预约关联。 */
  appointmentId?: string | null;
}

export function useJoinQueue() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    /*
     * ⚠️ 幂等键为必填。取号是最容易被重复提交的操作 —— 网络抖动时前台会再点一次，
     * 而重复取号意味着同一位客人拿到两个号，队列顺序随即失真。
     */
    /*
     * 在数据层解包 `CommandResult`，调用方直接拿到命令的 output。
     * `replayed` 标志（幂等重放）此处不透出 —— 对前台而言，
     * 「重试后成功」与「首次成功」是同一件事，区分只会带来困惑。
     */
    mutationFn: async (input: JoinQueueInput & { idempotencyKey?: string }) =>
      (await runCommand<{
        queueId: string; ticketNumber: number;
        aheadCount: number; quotedWaitMin: number | null; businessDate: string;
      }>(
        'queue.join',
        {
          customerId: input.customerId ?? null,
          ...(input.walkInName ? { walkInName: input.walkInName } : {}),
          requestedServiceId: input.requestedServiceId ?? null,
          requestedStaffId: input.requestedStaffId ?? null,
          partySize: input.partySize ?? 1,
          appointmentId: input.appointmentId ?? null,
          source: 'desk',
        },
        membershipId!,
        input.idempotencyKey,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queueKeys.list(membershipId) });
    },
  });
}

export interface UpdateQueueEntryInput {
  queueId: string;
  status: QueueStatus;
  /** ⚠️ `status = 'left'` 时必填：不同的离场原因对门店是不同的经营信号。 */
  leftReason?: QueueLeftReason;
}

export function useUpdateQueueEntry() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: UpdateQueueEntryInput) =>
      (await runCommand<{ queueId: string; status: string }>(
        'queue.update',
        {
          queueId: input.queueId,
          status: input.status,
          ...(input.leftReason ? { leftReason: input.leftReason } : {}),
        },
        membershipId!,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queueKeys.list(membershipId) });
    },
  });
}
