import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Locale } from '@gf/contracts';

export type FormQuestionType = 'bool' | 'text' | 'choice' | 'multi';
export interface FormQuestion {
  id: string;
  type: FormQuestionType;
  label: Partial<Record<Locale, string>>;
  options?: Array<{ value: string; label: Partial<Record<Locale, string>> }>;
  required: boolean;
  sync?: 'avoid_areas' | 'health_flag';
}

export interface FormTemplate {
  templateId: string;
  key: string;
  version: number;
  title: Partial<Record<Locale, string>>;
  questions: FormQuestion[];
  requiresSignature: boolean;
  validDays: number | null;
  serviceIds: string[];
  publishedAt: string | null;
  signedCount: number;
}

export interface FormsResponse {
  templates: FormTemplate[];
  submissions: unknown[];
  shares: unknown[];
  canViewContent: boolean;
}

export interface SaveFormTemplateInput {
  key: string;
  title: Partial<Record<Locale, string>>;
  questions: FormQuestion[];
  requiresSignature: boolean;
  validDays: number | null;
  serviceIds: string[];
}

export function useFormsQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'forms', membershipId],
    queryFn: () => apiGet<FormsResponse>('/v1/desk/forms'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useSaveFormTemplate() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveFormTemplateInput) =>
      (await runCommand<{ templateId: string; version: number }>('catalog.saveFormTemplate', input, membershipId!)).result,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['desk', 'forms'] }),
  });
}

export interface FormShareResult {
  shareId: string;
  token: string;
  url: string;
  qrSvg: string;
  expiresAt: string;
  emailQueued: boolean;
}

export function useShareForm() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async (input: {
      customerId?: string | null;
      appointmentId?: string | null;
      locale: 'zh-Hans' | 'en' | 'ko' | 'es' | 'vi';
    }) => (await runCommand<FormShareResult>('form.share', {
      templateIds: [],
      customerId: input.customerId ?? null,
      appointmentId: input.appointmentId ?? null,
      channel: 'qr',
      expiresInHours: 72,
      locale: input.locale,
    }, membershipId!)).result,
  });
}
