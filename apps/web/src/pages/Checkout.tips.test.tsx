import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { Checkout } from './Checkout';

const state = vi.hoisted(() => ({
  close: vi.fn(),
  data: { tickets: [{
    ticketId: 'ticket-A', customerName: 'Guest A', customerId: 'customer-A', status: 'ready_to_pay',
    subtotalCents: 5000, checkoutTiming: 'after_service_combined', serviceSettledAt: null,
    tipSettledAt: null, serviceCompleted: true, groupId: null, groupLabel: null,
    businessDate: '2026-09-12', daysAgo: 0, availablePackages: [],
    items: [{ ticketItemId: 'item-A', serviceId: 'service-A', name: 'Massage', totalCents: 5000,
      durationMin: 30, staffName: 'Amy', membershipId: 'staff-A' }],
  }] },
}));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ language: 'en', t: (key: string) => key }) }));
vi.mock('@/lib/permissions', () => ({ useCanWrite: () => true, useWriteBlockReason: () => () => null }));
vi.mock('@/context/ScheduleContext', () => ({ useSchedule: () => ({ staff: [], services: [] }), UNASSIGNED_STAFF_ID: 'unassigned' }));
vi.mock('@/features/checkout/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/checkout/api')>(),
  useOpenTickets: () => ({ data: state.data, isLoading: false }),
  useCloseTicket: () => ({ mutateAsync: state.close, isPending: false }),
  useVoidTicket: () => ({ isPending: false }),
}));
beforeEach(() => { state.close.mockReset().mockResolvedValue({ ticketId: 'ticket-A', allocations: [], totalCents: 6000 }); });
function inputAfterLabel(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('label')).find(el => el.textContent === text);
  if (!label) throw new Error(`Missing label ${text}`);
  return label.parentElement!.querySelector('input')!;
}
it('#23 submits matching channel tips, total and staff splits', async () => {
  render(<MemoryRouter><Checkout /></MemoryRouter>);
  await screen.findByText('checkout.confirmCheckout ($50.00)');
  fireEvent.change(inputAfterLabel('tip'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'checkout.confirmCheckout ($60.00)' }));
  await waitFor(() => expect(state.close).toHaveBeenCalled());
  expect(state.close.mock.calls[0]![0]).toMatchObject({
    payments: [{ amountCents: 6000, tipCents: 1000 }], tipTotalCents: 1000,
    tipSplits: [{ staffMembershipId: 'staff-A', amountCents: 1000 }],
  });
});
it('#22 and #23 keep cash change and retained-tip allocations consistent', async () => {
  render(<MemoryRouter><Checkout /></MemoryRouter>);
  await screen.findByText('checkout.confirmCheckout ($50.00)');
  const method = screen.getAllByRole('combobox').find(el => (el as HTMLSelectElement).value === 'card')!;
  fireEvent.change(method, { target: { value: 'cash' } });
  fireEvent.change(inputAfterLabel('tip'), { target: { value: '10' } });
  fireEvent.change(inputAfterLabel('amountReceived'), { target: { value: '70' } });
  expect(inputAfterLabel('amountReceived').value).toBe('70');
  fireEvent.click(screen.getByRole('checkbox', { name: 'checkout.keepChange' }));
  fireEvent.click(screen.getByRole('button', { name: 'checkout.confirmCheckout ($70.00)' }));
  await waitFor(() => expect(state.close).toHaveBeenCalled());
  expect(state.close.mock.calls[0]![0]).toMatchObject({
    payments: [{ method: 'cash', amountCents: 7000, tipCents: 2000, changeCents: 0, tenderedCents: 7000 }],
    tipTotalCents: 2000, tipSplits: [{ amountCents: 2000 }],
  });
});
