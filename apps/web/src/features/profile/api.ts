/**
 * 个人资料与账号安全。
 *
 * ⚠️ **本模块不得保留任何本地兜底数据。**
 * 此前每个写操作都以 `catch {}` 吞掉服务端异常、转写 localStorage 并返回
 * `{ ok: true }`，读取路径亦回落到同一份本地副本。其表现为：员工修改手机号后
 * 看到成功提示、刷新后数据仍在，而记录从未落库 —— 该类故障在门店现场
 * 无法自查，且会一直沉默到需要用这份资料时才暴露。
 *
 * 所对应的服务端接口均已实现并有测试覆盖
 * （`GET /v1/me/profile`、`GET /v1/me/sessions`、
 * `GET /v1/me/notification-preferences`，以及 `user.updateProfile`、
 * `staff.setPin`、`user.revokeSession`、`user.saveNotificationPreferences`），
 * 因此异常一律向上抛出，由调用方呈现错误态。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type {
  UserProfileData,
  UpdateUserProfileInput,
  ChangePasswordInput,
  SetPinInput,
  UserSessionItem,
  PersonalNotificationPreferences,
} from './types';

/**
 * 写操作要求已选定门店 —— 命令总线依 `X-Membership-Id` 判定租户与权限。
 * 该前置条件由会话门禁保证（未选店时主应用路由树不会挂载），
 * 此处显式断言，避免缺失时退化为一个难以定位的服务端校验失败。
 */
function assertMembership(membershipId: string | null): string {
  if (!membershipId) throw new Error('NO_ACTIVE_MEMBERSHIP');
  return membershipId;
}

export const profileKeys = {
  all: ['me', 'profile'] as const,
  profile: (userId?: string) => ['me', 'profile', userId ?? 'current'] as const,
  sessions: (userId?: string) => ['me', 'sessions', userId ?? 'current'] as const,
  preferences: (userId?: string) => ['me', 'preferences', userId ?? 'current'] as const,
};

export function useUserProfileQuery() {
  const { session, status } = useSession();
  const userId = session?.user.id;

  return useQuery({
    queryKey: profileKeys.profile(userId),
    queryFn: () => apiGet<UserProfileData>('/v1/me/profile'),
    enabled: status === 'ready' || status === 'selecting',
    staleTime: 60_000,
  });
}

export function useUpdateUserProfile() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateUserProfileInput) =>
      runCommand<{ ok: boolean }>('user.updateProfile', input, assertMembership(membershipId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}

/**
 * 修改登录密码。
 *
 * 走 Supabase Auth 而非命令总线：凭据由身份服务持有，
 * 业务库中不存储密码，因此不存在对应的服务端命令。
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: async ({ newPassword }: ChangePasswordInput) => {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message);
      return { ok: true };
    },
  });
}

export function useSetPin() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ pin }: SetPinInput) =>
      runCommand<{ ok: boolean }>('staff.setPin', { pin }, assertMembership(membershipId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}

export function useActiveSessionsQuery(enabled = true) {
  const { status } = useSession();

  return useQuery({
    queryKey: profileKeys.sessions(),
    queryFn: async (): Promise<UserSessionItem[]> => {
      const remote = await apiGet<{ sessions: UserSessionItem[] } | UserSessionItem[]>(
        '/v1/me/sessions',
      );
      if (Array.isArray(remote)) return remote;
      return remote?.sessions ?? [];
    },
    enabled: enabled && status === 'ready',
  });
}

export function useRevokeSession() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      await runCommand<{ ok: boolean }>(
        'user.revokeSession',
        { sessionId },
        assertMembership(membershipId),
      );
      return { sessionId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileKeys.sessions() });
    },
  });
}

export function usePersonalNotificationPreferencesQuery() {
  const { status } = useSession();

  return useQuery({
    queryKey: profileKeys.preferences(),
    queryFn: () =>
      apiGet<PersonalNotificationPreferences>('/v1/me/notification-preferences'),
    enabled: status === 'ready',
  });
}

export function useSavePersonalNotificationPreferences() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (prefs: PersonalNotificationPreferences) => {
      await runCommand<{ ok: boolean }>(
        'user.saveNotificationPreferences',
        prefs,
        assertMembership(membershipId),
      );
      return prefs;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileKeys.preferences() });
    },
  });
}
