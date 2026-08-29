import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
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
