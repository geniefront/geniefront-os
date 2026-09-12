/**
 * 打烊日结数据层。
 *
 * 读：`GET /v1/desk/dayclose?date=` 获取指定营业日的对账数据、流水快照与小费发放明细。
 * 写：走命令总线 `dayclose.*`。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useAttemptKey } from '@/lib/idempotency';
import { useSession } from '@/lib/session';
import type {
  DayCloseSnapshot,
  SaveCashCountInput,
  PayCashTipsInput,
  FinalizeDayInput,
  ReopenDayInput,
  RecordCashMovementInput,
} from './types';

export const dayCloseKeys = {
  detail: (membershipId: string | null, date?: string) =>
    ['desk', 'dayclose', membershipId, date ?? 'current'] as const,
};

export function useDayCloseQuery(businessDate?: string) {
  const { membershipId, status } = useSession();
  const queryParam = businessDate ? `?date=${encodeURIComponent(businessDate)}` : '';

  return useQuery({
    queryKey: dayCloseKeys.detail(membershipId, businessDate),
    queryFn: () => apiGet<DayCloseSnapshot>(`/v1/desk/dayclose${queryParam}`),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useSaveCashCount() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveCashCountInput) => {
      const res = await runCommand(
        'dayclose.saveCount',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({
        queryKey: dayCloseKeys.detail(membershipId, variables.businessDate),
      });
    },
  });
}

export function usePayCashTips() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  const attempt = useAttemptKey();

  return useMutation({
    mutationFn: async (input: PayCashTipsInput) => {
      /* 键随「这一次意图」走，不随「这一次调用」走 —— 见 lib/idempotency.ts */
      const idempotencyKey = attempt.take();
      const res = await runCommand(
        'dayclose.payTips',
        input,
        membershipId!,
        idempotencyKey,
      );
      return res.result;
    },
    onSuccess: (_, variables) => {
      attempt.settle();

      void queryClient.invalidateQueries({
        queryKey: dayCloseKeys.detail(membershipId, variables.businessDate),
      });
    },
  });
}

export function useFinalizeDay() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: FinalizeDayInput) => {
      const res = await runCommand(
        'dayclose.finalize',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({
        queryKey: dayCloseKeys.detail(membershipId, variables.businessDate),
      });
    },
  });
}

export function useReopenDay() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: ReopenDayInput) => {
      const res = await runCommand(
        'dayclose.reopen',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({
        queryKey: dayCloseKeys.detail(membershipId, variables.businessDate),
      });
    },
  });
}

export function useRecordCashMovement() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RecordCashMovementInput) => {
      const res = await runCommand(
        'dayclose.recordCash',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({
        queryKey: dayCloseKeys.detail(membershipId, variables.businessDate),
      });
    },
  });
}
