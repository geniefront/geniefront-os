import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { runCommand } from './api';
import { useRecordCashMovement, usePayCashTips } from '../features/dayclose/api';
import { useIssuePackage, useRedeemPackage, useAdjustLoyaltyPoints, useIssueGiftCard, useAdjustGiftCard } from '../features/marketing/api';
import { useTechDirectCashTipMutation } from '../features/tech/api';

const session = vi.hoisted(() => ({ membershipId: 'member-A' }));
vi.mock('./session', () => ({ useSession: () => session }));
vi.mock('./api', () => ({ runCommand: vi.fn(), apiGet: vi.fn() }));
beforeEach(() => { vi.mocked(runCommand).mockReset(); session.membershipId = 'member-A'; });

const cases = [
  ['cash movement', useRecordCashMovement, { kind: 'other', amountCents: 1000 }],
  ['cash payout', usePayCashTips, { businessDate: '2026-09-12' }],
  ['package issue', useIssuePackage, { templateId: 'template', customerId: 'customer' }],
  ['package redemption', useRedeemPackage, { customerPackageId: 'package', units: 1 }],
  ['loyalty', useAdjustLoyaltyPoints, { customerId: 'customer', pointsDelta: 10, reason: 'adjustment' }],
  ['gift card issue', useIssueGiftCard, { faceValueCents: 1000 }],
  ['gift card adjustment', useAdjustGiftCard, { giftCardId: 'card', amountCents: 1000, reason: 'adjustment' }],
  ['direct cash tip', useTechDirectCashTipMutation, { ticketItemId: 'ticket-A', amountCents: 1000 }],
] as const;

it.each(cases)('%s preserves a lost-response retry and isolates input and membership', async (_, hook, input) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result, rerender } = renderHook(() => hook(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  // Simulate committed writes with a lost first response. The cache is a transport
  // substitute; backend persistence is covered separately by command-bus tests.
  const committed = new Map<string, unknown>();
  vi.mocked(runCommand).mockImplementation(async (_command, body, _member, key) => {
    if (!committed.has(key!)) {
      committed.set(key!, body);
      throw new Error('response lost');
    }
    return { result: committed.get(key!), replayed: true } as any;
  });
  const send = async (body: unknown) => act(async () => {
    await (result.current.mutateAsync as (body: any) => Promise<unknown>)(body).catch(() => {});
  });
  await send(input);
  await send({ ...input, note: 'new intent' });
  await send(input);
  const calls = vi.mocked(runCommand).mock.calls;
  expect(calls[0]![3]).toBeTruthy();
  expect(calls[2]![3]).toBe(calls[0]![3]);
  expect(calls[1]![3]).not.toBe(calls[0]![3]);
  expect(committed.size).toBe(2);
  await send(input);
  expect(calls[3]![3]).not.toBe(calls[0]![3]);
  session.membershipId = 'member-B'; rerender();
  await send(input);
  expect(calls[4]![3]).not.toBe(calls[3]![3]);
  client.clear();
});

it('rejects a direct tip replay belonging to a different ticket or amount', async () => {
  const client = new QueryClient();
  const { result } = renderHook(useTechDirectCashTipMutation, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  vi.mocked(runCommand).mockResolvedValue({ result: { ticketItemId: 'old', amountCents: 1000 } } as any);
  await act(async () => {
    await expect(result.current.mutateAsync({ ticketItemId: 'new', amountCents: 2000 })).rejects.toThrow('DIRECT_TIP_RESPONSE_MISMATCH');
  });
  client.clear();
});
