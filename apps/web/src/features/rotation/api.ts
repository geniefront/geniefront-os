/**
 * 技师轮牌数据层。
 *
 * 读：`GET /v1/desk/rotation` 获取当前营业日的实时轮牌榜与排位推导。
 * 写：走命令总线 `rotation.*`。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useAttemptKey } from '@/lib/idempotency';
import { useSession } from '@/lib/session';
import type {
  RotationStanding,
  RotationSkipInput,
  RotationReorderInput,
  RotationSetBreakInput,
  RotationAssignInput,
  RotationCheckInInput,
  RotationCheckOutInput,
  RotationUpdatePolicyInput,
} from './types';

export const rotationKeys = {
  standing: (membershipId: string | null, businessDate?: string) =>
    ['desk', 'rotation', membershipId, businessDate || 'today'] as const,
};

export function useRotationQuery(businessDate?: string) {
  const { membershipId, status } = useSession();
  const url = businessDate ? `/v1/desk/rotation?businessDate=${businessDate}` : '/v1/desk/rotation';
  return useQuery({
    queryKey: rotationKeys.standing(membershipId, businessDate),
    queryFn: () => apiGet<RotationStanding>(url),
    enabled: status === 'ready' && membershipId !== null,
    placeholderData: (previous) => previous,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}

export function useRotationCheckIn() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RotationCheckInInput) => {
      const res = await runCommand<{ eventId: string; membershipId: string; arrivedAt: string }>(
        'rotation.checkIn',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}

export function useRotationCheckOut() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RotationCheckOutInput) => {
      const res = await runCommand<{ eventId: string; membershipId: string; leftAt: string }>(
        'rotation.checkOut',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}

export function useRotationUpdatePolicy() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RotationUpdatePolicyInput) => {
      const res = await runCommand<{ success: boolean; version: number }>(
        'rotation.updatePolicy',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}

export function useRotationSkip() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RotationSkipInput) => {
      const res = await runCommand<{ eventId: string; owed: number }>(
        'rotation.skip',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}

export function useRotationReorder() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RotationReorderInput) => {
      const res = await runCommand<{ eventId: string; membershipId: string; toPosition: number }>(
        'rotation.reorder',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}

export function useRotationSetBreak() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RotationSetBreakInput) => {
      const res = await runCommand<{ eventId: string; onBreak: boolean }>(
        'rotation.setBreak',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}

export function useRotationAssign() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  const attempt = useAttemptKey();

  return useMutation({
    mutationFn: async (input: RotationAssignInput) => {
      /* 键随「这一次意图」走，不随「这一次调用」走 —— 见 lib/idempotency.ts */
      const idempotencyKey = attempt.take();
      const res = await runCommand<{
        eventId: string;
        membershipId: string;
        consumedBp: number;
        nextUpMembershipId: string | null;
      }>(
        'rotation.assign',
        input,
        membershipId!,
        idempotencyKey,
      );
      return res.result;
    },
    onSuccess: () => {
      attempt.settle();

      void queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}
