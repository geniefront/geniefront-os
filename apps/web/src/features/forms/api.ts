import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, ApiError, apiGet, apiPost, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Locale } from '@gf/contracts';

export type FormQuestionType = 'bool' | 'text' | 'choice' | 'multi';
export interface FormQuestion {
  id: string;
  type: FormQuestionType;
  label: Partial<Record<Locale, string>>;
  options?: Array<{ value: string; label: Partial<Record<Locale, string>> }>;
  required: boolean;
  /** 店主隐藏后仍保留在版本草稿中，但公开端不会收到。 */
  hidden?: boolean;
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
  submissions: FormSubmissionSummary[];
  shares: FormShareSummary[];
  canViewContent: boolean;
}

export interface FormSubmissionSummary {
  submissionId: string;
  templateId: string;
  templateKey: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  customerId: string | null;
  customerName: string | null;
  signerName: string | null;
  signerRelation: string;
  source: string;
  locale: string;
  signedAt: string | null;
  createdAt: string;
  expiresOn: string | null;
  expired: boolean;
  anonymized: boolean;
  hasSignature: boolean;
}

export interface FormSubmissionDetail {
  submissionId: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  questions: FormQuestion[];
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

export interface FormShareSummary {
  shareId: string;
  customerId: string | null;
  customerName: string | null;
  channel: string;
  sentTo: string | null;
  templateCount: number;
  createdAt: string;
  expiresAt: string;
  openedAt: string | null;
  submittedAt: string | null;
  revokedAt: string | null;
  state: string;
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

export function useGenerateFormQuestions() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: (input: {
      prompt: string;
      actionType: string;
      templateTitle: Partial<Record<Locale, string>>;
      existingQuestions: FormQuestion[];
    }) => apiPost<{ questions: FormQuestion[]; model: string }>(
      '/v1/desk/forms/ai/questions',
      input,
      { membershipId: membershipId! },
    ),
  });
}

/** 读取健康内容会由服务端写访问日志，因此只在用户明确点击时调用。 */
export function useAccessFormSubmission() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: (submissionId: string) =>
      apiGet<FormSubmissionDetail>(
        `/v1/desk/forms/submissions/${encodeURIComponent(submissionId)}?reason=service_prep`,
        membershipId!,
      ),
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
      templateIds?: string[];
      customerId?: string | null;
      appointmentId?: string | null;
      channel?: 'qr' | 'email';
      email?: string;
      locale: 'zh-Hans' | 'en' | 'ko' | 'es' | 'vi';
    }) => (await runCommand<FormShareResult>('form.share', {
      templateIds: input.templateIds ?? [],
      customerId: input.customerId ?? null,
      appointmentId: input.appointmentId ?? null,
      channel: input.channel ?? 'qr',
      ...(input.email ? { email: input.email } : {}),
      expiresInHours: 72,
      locale: input.locale,
    }, membershipId!)).result,
  });
}

export interface PublicFormsResponse {
  shopName: string;
  locale: string;
  shopPhone: string | null;
  maskedName: string | null;
  expiresAt: string;
  /** 门店日历今天 YYYY-MM-DD，供生日等 date-only 字段判「未来」。 */
  today?: string;
  forms: Array<{
    templateId: string;
    key: string;
    version: number;
    title: Record<string, string>;
    questions: FormQuestion[];
    requiresSignature: boolean;
    done: boolean;
  }>;
}

async function parsePublic<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      body.code ?? 'INTERNAL',
      body.details ?? {},
      Boolean(body.overridable),
      res.status,
    );
  }
  return body as T;
}

export function usePublicForms(token: string, locale: string) {
  return useQuery({
    queryKey: ['public', 'forms', token, locale],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/public/v1/forms?locale=${encodeURIComponent(locale)}`, {
        headers: { 'X-GF-Form-Token': token },
      });
      return parsePublic<PublicFormsResponse>(res);
    },
    enabled: token.length > 0,
    retry: false,
  });
}

export function useSubmitPublicForm(token: string) {
  return useMutation({
    mutationFn: async (input: {
      templateId: string;
      answers: Record<string, unknown>;
      signatureDataUrl?: string;
      signerName: string;
      locale: string;
    }) => {
      const res = await fetch(`${API_BASE}/public/v1/forms/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GF-Form-Token': token },
        body: JSON.stringify(input),
      });
      return parsePublic<{ submissionId: string; remaining: number; done: boolean }>(res);
    },
  });
}
