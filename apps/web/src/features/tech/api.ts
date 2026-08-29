import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Language } from '@/i18n';
import type { PunchKind, TechRoster, TechToday } from './types';

function requireMembership(membershipId: string | null): string {
  if (!membershipId) throw new Error('NO_ACTIVE_MEMBERSHIP');
  return membershipId;
}

export const techKeys = {
  all: ['tech'] as const,
  today: (membershipId: string | null) => ['tech', 'today', membershipId] as const,
  roster: (membershipId: string | null) => ['tech', 'roster', membershipId] as const,
};

export function useTechTodayQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: techKeys.today(membershipId),
    queryFn: () => apiGet<TechToday>('/v1/staff/me/today', requireMembership(membershipId)),
    enabled: status === 'ready' && membershipId !== null,
    refetchInterval: 60_000,
    // Mobile browsers may suspend both timers and sockets. Refetch-on-focus is the
    // final reconciliation path after the page becomes active again.
    refetchOnWindowFocus: true,
  });
}

export function useTechRosterQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: techKeys.roster(membershipId),
    queryFn: () => apiGet<TechRoster>('/v1/desk/roster?days=7', requireMembership(membershipId)),
    enabled: status === 'ready' && membershipId !== null,
    staleTime: 5 * 60_000,
  });
}

function useRefreshTechToday() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: techKeys.today(membershipId) });
}

export function useTechPunchMutation() {
  const { membershipId } = useSession();
  const refresh = useRefreshTechToday();
  return useMutation({
    mutationFn: async (kind: PunchKind) => (
      await runCommand<{
        punchId: string;
        kind: string;
        at: string;
        onDuty: boolean;
        workedMinutes: number;
      }>('timeclock.punch', { kind }, requireMembership(membershipId))
    ).result,
    onSuccess: refresh,
  });
}

export function useTechStartServiceMutation() {
  const { membershipId } = useSession();
  const refresh = useRefreshTechToday();
  return useMutation({
    mutationFn: async (ticketItemId: string) => (
      await runCommand<{ ticketItemId: string; startedAt: string }>(
        'ticket.startItem',
        { ticketItemId },
        requireMembership(membershipId),
      )
    ).result,
    onSuccess: refresh,
  });
}

export function useTechFinishServiceMutation() {
  const { membershipId } = useSession();
  const refresh = useRefreshTechToday();
  return useMutation({
    mutationFn: async (ticketItemId: string) => (
      await runCommand<{
        ticketItemId: string;
        finishedAt: string;
        actualMinutes: number;
        ticketDone: boolean;
      }>('ticket.finishItem', { ticketItemId }, requireMembership(membershipId))
    ).result,
    onSuccess: refresh,
  });
}

export function useTechDirectCashTipMutation() {
  const { membershipId } = useSession();
  const refresh = useRefreshTechToday();
  return useMutation({
    mutationFn: async (input: { ticketItemId: string; amountCents: number; note?: string }) => (
      await runCommand<{
        ticketItemId: string;
        amountCents: number;
        settlementStatus: 'no_tip' | 'received_direct';
      }>('staff.recordDirectCashTip', input, requireMembership(membershipId), crypto.randomUUID())
    ).result,
    onSuccess: refresh,
  });
}

export function useTechLocaleMutation() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async (locale: Language) => (
      await runCommand<{ locale: string }>(
        'staff.setLocale',
        { locale },
        requireMembership(membershipId),
      )
    ).result,
  });
}
