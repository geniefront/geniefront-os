import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  TicketsQueryResponse,
  VoidTicketInput,
  OrdersQueryResponse,
  OrdersQueryParams,
  RefundTicketInput,
} from './types';

export const ticketKeys = {
  all: (membershipId: string | null) => ['desk', 'tickets', membershipId] as const,
  orders: (membershipId: string | null, params: OrdersQueryParams) =>
    ['desk', 'orders', membershipId, params] as const,
};

export function useTicketsList(status?: string) {
  const { membershipId, status: sessionStatus } = useSession();
  const url = status ? `/v1/desk/tickets?status=${status}` : '/v1/desk/tickets';
  return useQuery({
    queryKey: ['desk', 'tickets', membershipId, status],
    queryFn: () => apiGet<TicketsQueryResponse>(url),
    enabled: sessionStatus === 'ready' && membershipId !== null,
    refetchInterval: 15_000,
  });
}

export function useOrdersQuery(params: OrdersQueryParams = {}) {
  const { membershipId, status: sessionStatus } = useSession();
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.from) searchParams.set('from', params.from);
  if (params.to) searchParams.set('to', params.to);
  if (params.staffId) searchParams.set('staffId', params.staffId);
  if (params.paymentMethod) searchParams.set('paymentMethod', params.paymentMethod);
  if (params.minAmount !== undefined) searchParams.set('minAmount', String(params.minAmount));
  if (params.maxAmount !== undefined) searchParams.set('maxAmount', String(params.maxAmount));
  if (params.q) searchParams.set('q', params.q);
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));

  const qs = searchParams.toString();
  const url = qs ? `/v1/desk/orders?${qs}` : '/v1/desk/orders';

  return useQuery({
    queryKey: ticketKeys.orders(membershipId, params),
    queryFn: () => apiGet<OrdersQueryResponse>(url),
    enabled: sessionStatus === 'ready' && membershipId !== null,
    refetchInterval: 20_000,
  });
}

export function useVoidTicket() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: VoidTicketInput) => {
      const res = await runCommand<{ ticketId: string; status: string }>(
        'ticket.void',
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'orders'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'dayclose'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export function useRefundTicket() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RefundTicketInput) => {
      const res = await runCommand<{ ticketId: string; status: string }>(
        'ticket.refund',
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'orders'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'dayclose'] });
    },
  });
}

export function useSendReceipt() {
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async ({ ticketId, channel, recipient }: { ticketId: string; channel: 'sms' | 'email'; recipient?: string }) => {
      const session = (await supabase.auth.getSession()).data.session;
      const token = session?.access_token;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (membershipId) headers['X-Membership-Id'] = membershipId;

      const res = await fetch(`/v1/desk/tickets/${ticketId}/send-receipt`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel, recipient }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || '发送小票失败');
      }
      return res.json();
    },
  });
}
