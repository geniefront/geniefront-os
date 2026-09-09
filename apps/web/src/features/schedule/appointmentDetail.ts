import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface AppointmentItemDetail {
  itemId: string;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  resourceId: string | null;
  resourceName: string | null;
  startsAt: string;
  durationMin: number;
  priceCents: number;
  status?: string;
  /** 组合套餐来源（U10）。普通预约项为 null。 */
  bundleInstanceId?: string | null;
}

/** 本条预约里的组合套餐实例（U10）。只读展示，金额取下单时快照。 */
export interface AppointmentBundle {
  instanceId: string;
  name: string;
  originalTotalCents: number;
  bundlePriceCents: number;
  bundleDiscountCents: number;
  extraDiscountCents: number;
  unitCount: number;
  status: string;
}

export interface AppointmentTicketFacts {
  ticketId: string;
  number: number | null;
  status: string;
  checkoutTiming: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
  serviceSettledAt: string | null;
  tipSettledAt: string | null;
  serviceCompleted: boolean;
  items: Array<{
    ticketItemId: string;
    name: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
}

export interface AppointmentDetail {
  appointmentId: string;
  status: string;
  customer: {
    id: string | null;
    name: string;
    phone: string | null;
    hasHealthForm: boolean;
    healthFormSubmissionId: string | null;
    allergiesSummary: string | null;
  };
  items: AppointmentItemDetail[];
  /** 组合套餐实例。无则为空数组（旧后端可能不返回，按空处理）。 */
  bundles?: AppointmentBundle[];
  ticket: AppointmentTicketFacts | null;
  notes: string | null;
  createdAt: string;
}

export function useAppointmentDetailQuery(appointmentId: string | null) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'appointment-detail', appointmentId, membershipId],
    queryFn: () => apiGet<AppointmentDetail>(`/v1/desk/appointments/${appointmentId}`),
    enabled: status === 'ready' && Boolean(appointmentId),
  });
}

export function useSaveAppointmentServiceBrief(appointmentId: string | null) {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => apiPost<{ appointmentId: string; note: string | null }>(
      `/v1/desk/appointments/${appointmentId}/service-brief`,
      { note },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'appointment-detail', appointmentId, membershipId] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day', membershipId] });
    },
  });
}

export interface AddAppointmentItemInput {
  appointmentId: string;
  serviceId: string;
  membershipId?: string | null;
  startsAt?: string;
  resourceId?: string | null;
  durationMin?: number;
  isRequest?: boolean;
  override?: { reason: 'guest_requested' | 'staff_on_break' | 'desk_coordination' | 'walk_in_stacking' | 'other'; note?: string };
  idempotencyKey: string;
}

export function useAddAppointmentItem() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...input }: AddAppointmentItemInput) => (
      await runCommand<{
        appointmentId: string;
        itemId: string;
        businessDate: string;
        overbooked: boolean;
      }>('appointment.addItem', input, membershipId!, idempotencyKey)
    ).result,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'appointment-detail', result.appointmentId] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export function useUpdateAppointmentCustomer(appointmentId: string | null) {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { customerId?: string | null; walkInName?: string | null }) =>
      apiPost<{ appointmentId: string; customerId: string | null }>(
        `/v1/desk/appointments/${appointmentId}/customer`,
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'appointment-detail', appointmentId, membershipId] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day', membershipId] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'customers'] });
    },
  });
}

export interface AppointmentHealthForm {
  submissionId: string;
  templateId: string;
  templateKey: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  version: number;
  isLatest: boolean;
  signerName: string | null;
  signedAt: string | null;
  createdAt: string;
  expiresOn: string | null;
  anonymized: boolean;
  locale: string;
}

export function useAppointmentFormsQuery(appointmentId: string | null) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'appointment-forms', appointmentId, membershipId],
    queryFn: () => apiGet<{ forms: AppointmentHealthForm[] }>(`/v1/desk/appointments/${appointmentId}/forms`),
    enabled: status === 'ready' && Boolean(appointmentId),
    // 只在等顾客提交时轮询；已有完成记录后立即停止，避免前台持续重复请求。
    refetchInterval: (query) => (
      appointmentId && !query.state.data?.forms.some((form) => form.isLatest)
        ? 5_000
        : false
    ),
  });
}

export interface HealthFormSubmissionDetail {
  submissionId: string;
  templateKey: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  questions: Array<{ id: string; label: Record<string, string> }>;
  answers: Record<string, unknown> | null;
  signerName: string | null;
  signerRelation: string;
  signatureUrl: string | null;
  signedAt: string | null;
  locale: string;
  source: string;
  expiresOn: string | null;
  anonymized: boolean;
  customerName: string | null;
}

export function useHealthFormSubmissionQuery(submissionId: string | null, enabled: boolean = false) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'form-submission', submissionId, membershipId],
    queryFn: () => apiPost<HealthFormSubmissionDetail>(
      `/v1/desk/forms/submissions/${submissionId}/access`,
      { reason: 'service_prep' },
    ),
    enabled: status === 'ready' && Boolean(submissionId) && enabled,
  });
}
