import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { apiGet, apiPost } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  RevenueTrendsResponse,
  CustomerRetentionResponse,
  StaffAnalyticsResponse,
  ReviewSummaryResponse,
  HeatmapResponse,
  RfmAnalyticsResponse,
  TopServicesResponse,
  CopilotSummaryResponse,
} from './types';

export const analyticsKeys = {
  revenueTrends: (membershipId: string | null, from: string, to: string, interval: string) =>
    ['desk', 'analytics', 'revenue', membershipId, from, to, interval] as const,
  customers: (membershipId: string | null, from: string, to: string) =>
    ['desk', 'analytics', 'customers', membershipId, from, to] as const,
  staff: (membershipId: string | null, from: string, to: string) =>
    ['desk', 'analytics', 'staff', membershipId, from, to] as const,
  reviewsSummary: (membershipId: string | null) =>
    ['desk', 'analytics', 'reviewsSummary', membershipId] as const,
  heatmap: (membershipId: string | null, from: string, to: string) =>
    ['desk', 'analytics', 'heatmap', membershipId, from, to] as const,
  rfm: (membershipId: string | null, from: string, to: string) =>
    ['desk', 'analytics', 'rfm', membershipId, from, to] as const,
  topServices: (membershipId: string | null, from: string, to: string) =>
    ['desk', 'analytics', 'topServices', membershipId, from, to] as const,
  copilotSummary: (membershipId: string | null) =>
    ['desk', 'analytics', 'copilotSummary', membershipId] as const,
};

export function useReviewsSummaryQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.reviewsSummary(membershipId),
    queryFn: () => apiGet<ReviewSummaryResponse>('/v1/desk/reviews/summary'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useRevenueTrendsQuery(from: string, to: string, interval = 'day') {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.revenueTrends(membershipId, from, to, interval),
    queryFn: () =>
      apiGet<RevenueTrendsResponse>(
        `/v1/desk/analytics/revenue-trends?from=${from}&to=${to}&interval=${interval}`,
      ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useCustomerRetentionQuery(from: string, to: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.customers(membershipId, from, to),
    queryFn: () =>
      apiGet<CustomerRetentionResponse>(
        `/v1/desk/analytics/customers?from=${from}&to=${to}`,
      ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useStaffAnalyticsQuery(from: string, to: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.staff(membershipId, from, to),
    queryFn: () =>
      apiGet<StaffAnalyticsResponse>(
        `/v1/desk/analytics/staff?from=${from}&to=${to}`,
      ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useHeatmapQuery(from: string, to: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.heatmap(membershipId, from, to),
    queryFn: () =>
      apiGet<HeatmapResponse>(
        `/v1/desk/analytics/heatmap?from=${from}&to=${to}`,
      ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useRfmCustomersQuery(from: string, to: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.rfm(membershipId, from, to),
    queryFn: () =>
      apiGet<RfmAnalyticsResponse>(
        `/v1/desk/analytics/rfm-customers?from=${from}&to=${to}`,
      ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useTopServicesQuery(from: string, to: string) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.topServices(membershipId, from, to),
    queryFn: () =>
      apiGet<TopServicesResponse>(
        `/v1/desk/analytics/top-services?from=${from}&to=${to}`,
      ),
    enabled: status === 'ready' && membershipId !== null && Boolean(from) && Boolean(to),
  });
}

export function useCopilotSummaryQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: analyticsKeys.copilotSummary(membershipId),
    queryFn: () => apiGet<CopilotSummaryResponse>('/v1/desk/analytics/copilot-summary'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useGenerateCopilotSummary() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<CopilotSummaryResponse>('/v1/desk/analytics/copilot-summary/generate', {}),
    onSuccess: (summary) => {
      queryClient.setQueryData(analyticsKeys.copilotSummary(membershipId), summary);
    },
  });
}

export async function downloadReportCsv(from: string, to: string, membershipId: string | null) {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (membershipId) headers['X-Membership-Id'] = membershipId;

  const url = `/v1/desk/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=csv`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || '导出报表失败');
  }

  const blob = await res.blob();
  const downloadUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `sales-report-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(downloadUrl);
}
