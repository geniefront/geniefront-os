/**
 * 外发通知的配置。
 *
 * ⚠️ 与同目录的 `api.ts` 是两件事：那一份是**应用内通知中心**（前台看的
 * 消息列表与未读数），这一份是**发给顾客与技师的通知**的规则与模板。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';

export type NotifyChannel = 'sms' | 'email';

export interface NotificationRule {
  eventKey: string;
  enabled: boolean;
  channels: NotifyChannel[];
  offsetMin: number;
}

export interface NotificationTemplate {
  id: string;
  eventKey: string;
  channel: NotifyChannel;
  locale: string;
  version: number;
  subject: string | null;
  body: string;
}

export interface MarketingHoliday {
  id: string;
  name: string;
  sendOn: string;
  enabled: boolean;
}

export interface NotificationSettings {
  rules: NotificationRule[];
  templates: NotificationTemplate[];
  holidays: MarketingHoliday[];
  variables: Record<string, string[]>;
  marketingEvents: string[];
  gates: {
    tenDlcStatus: string;
    marketingEmailFrom: string | null;
    quietHours: { start: number; end: number };
  };
}

export const notifySettingsKey = (membershipId: string | null) =>
  ['desk', 'settings', 'notifications', membershipId] as const;

export function useNotificationSettings(opts?: { enabled?: boolean }) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: notifySettingsKey(membershipId),
    queryFn: () => apiGet<NotificationSettings>('/v1/desk/settings/notifications'),
    enabled: (opts?.enabled ?? true) && status === 'ready' && membershipId !== null,
  });
}

/** 所有写操作共用一次失效 —— 这一页的几块数据互相牵连（模板影响预览、闸门影响提示） */
function useNotifyMutation<TInput>(command: string) {
  const qc = useQueryClient();
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: (input: TInput) => runCommand(command, input, membershipId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notifySettingsKey(membershipId) });
    },
  });
}

export const useToggleNotificationRule = () => useNotifyMutation<{
  eventKey: string; enabled: boolean; channels: NotifyChannel[]; offsetMin?: number;
}>('notification.toggleRule');

export const useSaveNotificationTemplate = () => useNotifyMutation<{
  eventKey: string; channel: NotifyChannel; locale: string;
  subject?: string | null; body: string; active?: boolean;
}>('notification.saveTemplate');

export const useSaveMarketingHoliday = () => useNotifyMutation<{
  holidayId?: string; name: string; sendOn: string; enabled?: boolean;
}>('marketing.saveHoliday');

export const useDeleteMarketingHoliday = () => useNotifyMutation<{
  holidayId: string;
}>('marketing.deleteHoliday');
