import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { DirectoryOption, StaffDirectoryItem, SaveStaffProfileInput, SetEmploymentInput } from './types';

export const staffKeys = {
  all: ['desk', 'staff'] as const,
  list: (membershipId: string | null) => ['desk', 'staff', 'list', membershipId] as const,
};

export function useStaffListQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: staffKeys.list(membershipId),
    queryFn: () => apiGet<{ staff: StaffDirectoryItem[]; skills: DirectoryOption[]; levels: DirectoryOption[]; jobs: DirectoryOption[] }>('/v1/desk/staff/list'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useSaveStaffProfile() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...input }: SaveStaffProfileInput) => {
      const res = await runCommand<{ membershipId: string; created?: boolean }>(
        'staff.saveProfile',
        input,
        membershipId!,
        idempotencyKey,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: staffKeys.all });
      queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'settings'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'payroll'] });
    },
  });
}

export function useSetEmploymentStatus() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetEmploymentInput) => {
      const res = await runCommand<{ membershipId: string; status: string }>(
        'staff.setEmployment',
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: staffKeys.all });
      queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'settings'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export function useSaveDirectoryOption() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: 'job' | 'level' | 'skill'; id?: string; name: string; sort: number; active: boolean }) =>
      runCommand('staff.saveDirectoryOption', input, membershipId!),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: staffKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['desk', 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['desk', 'day'] }),
      ]);
    },
  });
}
