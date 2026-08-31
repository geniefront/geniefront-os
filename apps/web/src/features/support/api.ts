import { useMutation } from '@tanstack/react-query';
import { runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';

export type SupportCategory =
  | 'general'
  | 'onboarding'
  | 'billing'
  | 'sms_10dlc'
  | 'storefront'
  | 'technical'
  | 'other';

export interface SubmitSupportRequestInput {
  category: SupportCategory;
  subject: string;
  description: string;
  /** Stable key for one user submission so a retried POST cannot insert twice. */
  idempotencyKey: string;
}

export function useSubmitSupportRequest() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async (input: SubmitSupportRequestInput) => {
      const { idempotencyKey, ...body } = input;
      const res = await runCommand<{ requestId: string; status: 'open'; createdAt: string }>(
        'support.submitRequest',
        body,
        membershipId!,
        idempotencyKey,
      );
      return res.result;
    },
  });
}
