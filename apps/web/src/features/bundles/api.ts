/**
 * 组合套餐（U10）数据层。
 *
 * 读：`GET /v1/desk/bundles`（目录 + 编辑器可选服务/加项）、
 *     `POST /v1/desk/bundles/quote`（服务端权威报价，与下单/结账同一实现）。
 * 写：命令总线 `bundle.saveTemplate` / `bundle.archiveTemplate` / `bundle.splitInstance`。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPost, runCommand } from '@/lib/api';
import { apiGet } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  BundleCatalogResponse,
  SaveBundleTemplateInput,
  BundleQuoteRequestInput,
  BundleQuoteResult,
} from './types';

export const bundleKeys = {
  catalog: (membershipId: string | null) => ['desk', 'bundles', membershipId] as const,
};

export function useBundleCatalogQuery(opts?: { enabled?: boolean }) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: bundleKeys.catalog(membershipId),
    queryFn: () => apiGet<BundleCatalogResponse>('/v1/desk/bundles'),
    enabled: (opts?.enabled ?? true) && status === 'ready' && membershipId !== null,
  });
}

export function useSaveBundleTemplate() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveBundleTemplateInput) => {
      const res = await runCommand<{ bundleId: string; created: boolean; version: number }>(
        'bundle.saveTemplate', input, membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'bundles'] });
    },
  });
}

export function useArchiveBundleTemplate() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (bundleId: string) => {
      const res = await runCommand<{ bundleId: string }>(
        'bundle.archiveTemplate', { bundleId }, membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'bundles'] });
    },
  });
}

export function useSplitBundleInstance() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ticketId: string; bundleInstanceId: string }) => {
      const res = await runCommand<{
        ticketId: string; bundleInstanceId: string; splitItemCount: number; subtotalCents: number;
      }>('bundle.splitInstance', input, membershipId!);
      return res.result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'queue'] });
    },
  });
}

/** 一次性报价（下单/结账预览用）。不缓存 —— 每次选择变化都要重算。 */
export async function quoteBundle(input: BundleQuoteRequestInput): Promise<BundleQuoteResult> {
  return apiPost<BundleQuoteResult>('/v1/desk/bundles/quote', input);
}
