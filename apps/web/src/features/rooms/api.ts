import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { RoomsQueryResponse, SetResourceStatusInput, SaveResourceInput } from './types';

export const roomKeys = {
  all: (membershipId: string | null) => ['desk', 'rooms', membershipId] as const,
};

export function useRoomsQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: roomKeys.all(membershipId),
    queryFn: () => apiGet<RoomsQueryResponse>('/v1/desk/rooms'),
    enabled: status === 'ready' && membershipId !== null,
    placeholderData: (previous) => previous,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useSetResourceStatus() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetResourceStatusInput) => {
      const res = await runCommand<{ resourceId: string; status: string }>(
        'resource.setStatus',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'rooms'] });
    },
  });
}

export function useBeginCleaning() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { resourceId: string; note?: string }) => {
      const res = await runCommand<{ resourceId: string; status: 'cleaning' }>(
        'resource.beginCleaning',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'rooms'] });
    },
  });
}

export function useSaveResource() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SaveResourceInput) => {
      const res = await runCommand<{ resourceId: string; created: boolean }>(
        'resource.save',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'rooms'] });
    },
  });
}

export function useDeleteResource() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { resourceId: string; force?: boolean }) => {
      const res = await runCommand<{ resourceId: string; deleted: boolean }>(
        'resource.delete',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'rooms'] });
    },
  });
}

