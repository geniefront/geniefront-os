import {useState,useEffect} from 'react';
import {customerMergeInput} from '@gf/contracts';
import {useAttemptKey} from '@/lib/idempotency';
/**
 * 客户档案数据层。
 *
 * 读操作走 Desk 查询，档案、偏好、拉黑、合并与短信写操作走对应的
 * `customer.*` 命令。这里不维护本地镜像，命令成功后统一失效相关查询。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError,apiGet, runCommand } from '@/lib/api';
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
  filterType?: 'all' | 'vip' | 'active30' | 'sleep30' | 'sleep90';
  vipOnly?: boolean;
  /** 沉睡客户阈值（天）。用于筛出多久没来的客人。 */
  sleepingDays?: number;
  limit?: number;
  offset?: number;
}

function toQueryString(params: CustomerListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.filterType) search.set('filterType', params.filterType);
  if (params.vipOnly) search.set('vip', '1');
  if (params.sleepingDays) search.set('sleeping', String(params.sleepingDays));
  if (params.limit) search.set('limit', String(params.limit));
  if (params.offset) search.set('offset', String(params.offset));
  return search.toString();
}

export function useCustomerList(params: CustomerListParams, enabled = true) {
  const { membershipId, status } = useSession();
  const qs = toQueryString(params);
  return useQuery({
    queryKey: customerKeys.list(membershipId, qs),
    /*
     * ⚠️ 返回形状是 `{ total, rows }` 而非 `{ customers }`。
     * `total` 是符合条件的总数（不受 limit 截断），分页与「共 N 位客人」都依赖它。
     */
    queryFn: () => apiGet<{ total: number; rows: CustomerListRow[]; metrics: { total: number; vipCount: number; active30: number; sleep30: number; sleep90: number } }>(
      `/v1/desk/customers${qs ? `?${qs}` : ''}`,
    ),
    enabled: enabled && status === 'ready' && membershipId !== null,
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
  const queryClient=useQueryClient(),{membershipId}=useSession(),attempt=useAttemptKey(),storageKey=`gf-customer-merge:${membershipId}`;
  type Pending={key:string;input:MergeCustomersInput};
  const read=():Pending|null=>{try{const p=JSON.parse(sessionStorage.getItem(storageKey)??'null');const input=customerMergeInput.safeParse(p?.input);return p&&typeof p.key==='string'&&input.success?{key:p.key,input:input.data}:null;}catch{return null;}};
  const [stored,setStored]=useState<{storageKey:string;value:Pending|null}>(()=>({storageKey,value:read()}));
  useEffect(()=>{setStored({storageKey,value:read()});},[storageKey]);
  const preserve=(value:Pending|null)=>{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);setStored({storageKey,value});};
  const mutation=useMutation({mutationFn:async(input:MergeCustomersInput)=>{
    const payload=customerMergeInput.parse(input),saved=read();
    if(saved&&(saved.input.sourceCustomerId!==payload.sourceCustomerId||saved.input.targetCustomerId!==payload.targetCustomerId))throw new ApiError('VALIDATION_FAILED',{reason:'customer_merge_result_unknown'},false,409);
    const pending=saved??{key:attempt.take([membershipId,payload]),input:payload};preserve(pending);
    try{const res=await runCommand<{targetCustomerId:string;sourceCustomerId:string}>('customer.merge',payload,membershipId!,pending.key);
      if(res.result.targetCustomerId!==payload.targetCustomerId||res.result.sourceCustomerId!==payload.sourceCustomerId)throw new Error('CUSTOMER_MERGE_RESPONSE_MISMATCH');
      preserve(null);attempt.settle([membershipId,payload]);return res.result;
    }catch(e){if(e instanceof ApiError&&e.status>0&&e.status<500&&(!saved||(![401,403,429].includes(e.status)&&e.code!=='IDEMPOTENCY_KEY_REUSED')))preserve(null);throw e;}
  },onSuccess:()=>{void queryClient.invalidateQueries({queryKey:['desk']});void queryClient.invalidateQueries({queryKey:['checkout']});}});
  return {...mutation,pendingMerge:stored.storageKey===storageKey?stored.value?.input??null:null};
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
