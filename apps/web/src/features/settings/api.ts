/**
 * 系统设置数据层。
 *
 * 读：`GET /v1/desk/settings` 获取门店全量配置（门店信息、项目、员工、官网、电话、收银、10DLC、免责知情书、Webhooks）。
 * 写：通过命令总线调用各配置变更命令。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { BillingResponse } from '@/features/billing/types';
import type {
  DeskSettings,
  SaveLocationProfileInput,
  SaveBusinessHoursInput,
  SaveServiceInput,
  ArchiveServiceInput,
  SaveStaffProfileInput,
  SetRotationParticipationInput,
  SaveOnlineBookingInput,
  AddWebOriginInput,
  RemoveWebOriginInput,
  IssueDeviceTokenInput,
  SaveCheckoutInput,
  Apply10DlcInput,
  SaveIntakeWaiverInput,
  SaveWebhooksInput,
  EmailLocale,
} from './types';

export const settingsKeys = {
  desk: (membershipId: string | null) => ['desk', 'settings', membershipId] as const,
  billing: (membershipId: string | null) => ['desk', 'billing', membershipId] as const,
};

export function useDeskSettingsQuery(opts?: { enabled?: boolean }) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: settingsKeys.desk(membershipId),
    queryFn: () => apiGet<DeskSettings>('/v1/desk/settings'),
    enabled: (opts?.enabled ?? true) && status === 'ready' && membershipId !== null,
  });
}

export function useDeskBillingQuery(opts?: { enabled?: boolean }) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: settingsKeys.billing(membershipId),
    queryFn: () => apiGet<BillingResponse>('/v1/desk/billing'),
    enabled: (opts?.enabled ?? true) && status === 'ready' && membershipId !== null,
  });
}

/**
 * 修改账单类邮件的语言。
 *
 * ⚠️ 权限是 `billing.manage`（仅 owner 持有）—— 这些邮件里是他的卡与账单。
 * ⚠️ 只影响发给店主的邮件；顾客侧的邮件与短信恒为英语。
 */
export function useSetEmailLocale() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (locale: EmailLocale) => {
      const res = await runCommand('org.setEmailLocale', { locale }, membershipId!);
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveLocationProfile() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveLocationProfileInput) => {
      const res = await runCommand(
        'location.saveProfile',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveBusinessHours() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveBusinessHoursInput) => {
      const res = await runCommand(
        'location.saveHours',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveService() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveServiceInput) => {
      const res = await runCommand(
        'catalog.saveService',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useArchiveService() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: ArchiveServiceInput) => {
      const res = await runCommand(
        'catalog.archiveService',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveStaffProfile() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveStaffProfileInput) => {
      const res = await runCommand(
        'staff.saveProfile',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useFinishSetup() {
  const queryClient = useQueryClient();
  const { membershipId, reloadLocations } = useSession();

  return useMutation({
    mutationFn: async () => {
      const res = await runCommand<{ locationId: string; status: string }>(
        'location.finishSetup',
        {},
        membershipId!,
      );
      return res.result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
      await reloadLocations();
    },
  });
}

export function useSetRotationParticipation() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SetRotationParticipationInput) => {
      const res = await runCommand(
        'staff.setRotation',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveOnlineBooking() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveOnlineBookingInput) => {
      const res = await runCommand(
        'location.saveOnlineBooking',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useAddWebOrigin() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: AddWebOriginInput) => {
      const res = await runCommand(
        'location.addWebOrigin',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useRemoveWebOrigin() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: RemoveWebOriginInput) => {
      const res = await runCommand(
        'location.removeWebOrigin',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useIssueDeviceToken() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: IssueDeviceTokenInput) => {
      const res = await runCommand<{ token: string; deviceId: string }>(
        'device.issueToken',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export interface SavePhoneAssistantInput {
  greetingPrompt?: string;
  forwardPhoneNumber?: string;
  autoBookEnabled?: boolean;
  voiceTone?: string;
  afterHoursVoicemail?: boolean;
}

export function useSavePhoneAssistant() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SavePhoneAssistantInput) => {
      const res = await runCommand<{ locationId: string; saved: boolean }>(
        'settings.savePhoneAssistant',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveCheckoutSettings() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveCheckoutInput) => {
      const res = await runCommand<{ locationId: string }>(
        'settings.saveCheckout',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useApply10Dlc() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: Apply10DlcInput) => {
      const res = await runCommand<{ locationId: string; status: string; submittedAt: string }>(
        'settings.apply10dlc',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveIntakeWaiver() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveIntakeWaiverInput) => {
      const res = await runCommand<{ locationId: string }>(
        'settings.saveIntakeWaiver',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}

export function useSaveWebhooks() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveWebhooksInput) => {
      const res = await runCommand<{ locationId: string; webhookId: string }>(
        'settings.saveWebhooks',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
    },
  });
}
