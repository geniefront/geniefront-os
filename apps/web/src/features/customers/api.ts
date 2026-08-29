/**
 * 客户档案数据层。
 *
 * 读操作走 Desk 查询，档案、偏好、拉黑、合并与短信写操作走对应的
 * `customer.*` 命令。这里不维护本地镜像，命令成功后统一失效相关查询。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  CustomerDetail,
  CustomerListRow,
  SaveCustomerProfileInput,
  SaveCustomerPreferencesInput,
  SetCustomerBlockedInput,
  MergeCustomersInput,
} from './types';

export const customerKeys = {
  list: (membershipId: string | null, params: string) =>
    ['desk', 'customers', membershipId, params] as const,
  detail: (membershipId: string | null, id: string) =>
    ['desk', 'customer', membershipId, id] as const,
};

export interface CustomerListParams {
  /**
   * 搜索词。
   *
   * ⭐ 服务端**优先按手机后四位匹配** —— 前台在电话里问的第一句就是
   * 「您手机后四位是多少」，而客人的全名她多半拼不出来（越南名、韩国名）。
   * 因此输入框的提示语必须明确写出可以只输四位数字。
   */
  q?: string;
  vipOnly?: boolean;
  /** 沉睡客户阈值（天）。用于筛出多久没来的客人。 */
  sleepingDays?: number;
  limit?: number;
  offset?: number;
}

function toQueryString(params: CustomerListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.vipOnly) search.set('vip', '1');
  if (params.sleepingDays) search.set('sleeping', String(params.sleepingDays));
  if (params.limit) search.set('limit', String(params.limit));
  if (params.offset) search.set('offset', String(params.offset));
  return search.toString();
}

export function useCustomerList(params: CustomerListParams) {
  const { membershipId, status } = useSession();
  const qs = toQueryString(params);
  return useQuery({
    queryKey: customerKeys.list(membershipId, qs),
    /*
     * ⚠️ 返回形状是 `{ total, rows }` 而非 `{ customers }`。
     * `total` 是符合条件的总数（不受 limit 截断），分页与「共 N 位客人」都依赖它。
     */
    queryFn: () => apiGet<{ total: number; rows: CustomerListRow[] }>(
      `/v1/desk/customers${qs ? `?${qs}` : ''}`,
    ),
    enabled: status === 'ready' && membershipId !== null,
    /*
     * 保留上一次结果作为占位，避免逐字输入搜索词时列表反复闪成空白。
     * 前台常常是一边打电话一边输入的，列表跳动会让她丢失刚看到的那一行。
     */
    placeholderData: (previous) => previous,
  });
}

export function useCustomerDetail(id: string | null) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: customerKeys.detail(membershipId, id ?? ''),
    queryFn: () => apiGet<CustomerDetail>(`/v1/desk/customers/${id!}`),
    enabled: status === 'ready' && membershipId !== null && Boolean(id),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}

export function useSaveCustomerProfile() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveCustomerProfileInput) => {
      const res = await runCommand<{ customerId: string }>(
        'customer.saveProfile',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'customers'] });
      if (data?.customerId) {
        queryClient.invalidateQueries({ queryKey: ['desk', 'customer', membershipId, data.customerId] });
      }
    },
  });
}

export function useSaveCustomerPreferences() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SaveCustomerPreferencesInput) => {
      const res = await runCommand<{ customerId: string }>(
        'customer.savePreferences',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'customer', membershipId, data.customerId] });
    },
  });
}

export function useSetCustomerBlocked() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: SetCustomerBlockedInput) => {
      const res = await runCommand<{ customerId: string; blocked: boolean }>(
        'customer.setBlocked',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'customers'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'customer', membershipId, data.customerId] });
    },
  });
}

export function useMergeCustomers() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: MergeCustomersInput) => {
      const res = await runCommand<{ targetCustomerId: string; sourceCustomerId: string }>(
        'customer.merge',
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'customers'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'customer', membershipId, data.targetCustomerId] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'customer', membershipId, data.sourceCustomerId] });
    },
  });
}

export function useSendCustomerSms() {
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: { customerId: string; body: string }) => {
      const res = await runCommand<{ outboxId: string; customerId: string; status: string; segments: number }>(
        'customer.sendSms',
        input,
        membershipId!,
      );
      return res.result;
    },
  });
}
