import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
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

export interface HealthFormSubmissionDetail {
  submissionId: string;
  formId?: string;
  customerName?: string;
  submittedAt?: string;
  answers?: Array<{ question: string; answer: unknown }>;
  data?: Record<string, unknown>;
  signatureSvg?: string;
}

export function useHealthFormSubmissionQuery(submissionId: string | null, enabled: boolean = false) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'form-submission', submissionId, membershipId],
    queryFn: () => apiGet<HealthFormSubmissionDetail>(`/v1/desk/forms/submissions/${submissionId}?reason=service_prep`),
    enabled: status === 'ready' && Boolean(submissionId) && enabled,
  });
}
