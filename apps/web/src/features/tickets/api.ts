import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export interface OpenTicketInput {
  customerId: string | null;
  walkInName?: string;
  appointmentId?: string;
  items: Array<{
    serviceId: string;
    membershipId?: string;
    staffAssignments?: Array<{ membershipId: string; role: 'primary' | 'assistant'; minutes?: number }>;
    resourceId?: string;
    minutes?: number;
    priceCentsOverride?: number;
  }>;
  idempotencyKey: string;
}

export function useOpenTicket() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...input }: OpenTicketInput) =>
      (await runCommand<{
        ticketId: string; ticketItemIds: string[]; subtotalCents: number;
      }>('ticket.open', input, membershipId!, idempotencyKey)).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export interface AddTicketItemInput {
  ticketId: string;
  serviceId: string;
  membershipId: string;
  kind?: 'service' | 'addon';
  minutes?: number;
  idempotencyKey: string;
}

export function useAddTicketItem() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...input }: AddTicketItemInput) =>
      (await runCommand<{ ticketItemId: string; subtotalCents: number }>(
        'ticket.addItem', input, membershipId!, idempotencyKey,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export function useSaveServiceNote() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async (input: {
      ticketItemId: string;
      content: string;
      visibility: 'management' | 'assigned_staff';
      containsSensitiveData: boolean;
    }) => (await runCommand<{ noteId: string; ticketItemId: string; updated: boolean }>(
      'ticket.saveServiceNote', input, membershipId!,
    )).result,
  });
}

export function useStartTicketItem() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ticketItemId: string; membershipId?: string }) =>
      (await runCommand<{ ticketItemId: string; startedAt: string }>(
        'ticket.startItem', input, membershipId!,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export function useFinishTicketItem() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ticketItemId: string; membershipId?: string }) =>
      (await runCommand<{
        ticketItemId: string; finishedAt: string; actualMinutes: number; ticketDone: boolean;
      }>('ticket.finishItem', input, membershipId!)).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
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
        {
          ticketId: input.ticketId,
          refundAmountCents: input.amountCents,
          refundTipCents: input.refundTipCents ?? 0,
          reason: input.reason === 'duplicate' ? 'accidental_duplicate' : input.reason,
          refundMethod: input.method,
          notes: input.notes,
        },
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
    mutationFn: async ({ ticketId, channel, destination }: {
      ticketId: string;
      channel: 'sms' | 'email';
      destination?: string;
    }) => (await runCommand<{
      ticketId: string;
      channel: 'sms' | 'email';
      destination: string;
      outboxId: string;
    }>('ticket.sendReceipt', { ticketId, channel, destination }, membershipId!)).result,
  });
}
