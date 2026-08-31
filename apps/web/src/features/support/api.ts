import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
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


export type SupportStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';

export interface SupportRequestSummary {
  id: string;
  category: SupportCategory;
  subject: string;
  description: string;
  status: SupportStatus;
  priority: string;
  createdAt: string;
  /**
   * 客服最后一次改状态或加备注的时刻。
   *
   * ⚠️ 只有时刻，**没有备注内容** —— 运营的内部备注对租户不可见（AUD-08），
   * 数据库那一侧也已经按「必须是运营」收窄了 RLS（sql/0077）。
   */
  lastOperatorUpdateAt: string | null;
  resolvedAt: string | null;
}

/**
 * 本店提过的工单。
 *
 * 修 QA-006 时只补了提交表单，工单于是成了一个单向投递口：
 * 平台把状态改成 `waiting`（等客户回话）之后，客户那边什么都看不到。
 */
export function useMySupportRequests() {
  const { membershipId } = useSession();
  return useQuery({
    queryKey: ['support', 'requests', membershipId],
    enabled: Boolean(membershipId),
    queryFn: () => apiGet<{ requests: SupportRequestSummary[] }>(
      '/v1/desk/support/requests', membershipId!,
    ),
  });
}
