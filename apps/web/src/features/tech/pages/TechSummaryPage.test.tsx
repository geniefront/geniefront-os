import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TechSummaryPage } from './TechSummaryPage';
import type { TechToday } from '../types';

const useTechTodayQuery = vi.fn();

vi.mock('../api', () => ({
  useTechTodayQuery: () => useTechTodayQuery(),
}));

vi.mock('@/LanguageContext', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      navSummary: 'Summary',
      todaySummary: 'Today',
      totalEarnedToday: 'Total earned today',
      commission: 'Commission',
      cashTip: 'Cash tip',
      cardTip: 'Card tip',
      grossRevenue: 'Gross revenue',
      cashOwed: 'Cash owed',
      ticketItem: 'Services',
      totalServicesCount: '{n} services',
      serviceCompletedStatus: 'Completed',
      mins: 'min',
      requestedStaffGuest: 'Requested',
      noHistoryRecords: 'No completed services',
      loadingWorkbench: 'Loading',
    })[key] ?? key,
  }),
}));

const snapshot: TechToday = {
  businessDate: '2026-08-29',
  membershipId: 'membership',
  name: 'Linda',
  current: null,
  next: null,
  tasks: [{
    ticketId: 'ticket',
    ticketItemId: 'item',
    customerName: 'Guest',
    customerPhone: null,
    serviceName: 'Deep tissue massage',
    durationMin: 60,
    resourceName: null,
    startedAt: '2026-08-29T12:00:00.000Z',
    finishedAt: '2026-08-29T13:00:00.000Z',
    state: 'done',
    isRequest: false,
    details: [],
    alerts: [],
    customerLocale: null,
    note: null,
    serviceNotes: [],
    tip: { cashCents: 0, cardCents: 0, directCashCents: 0, status: 'settled', editable: false },
  }],
  doneCount: 1,
  onDuty: true,
  workedMinutes: 60,
  rotation: { position: 1, isNextUp: true, onBreak: false },
  earnings: {
    serviceRevenueCents: 10_000,
    commissionCents: 5_000,
    tipCashCents: 1_000,
    tipCardCents: 500,
    payCents: 6_500,
    cashTipOwedCents: 1_000,
  },
};

describe('TechSummaryPage', () => {
  beforeEach(() => {
    useTechTodayQuery.mockReturnValue({
      data: snapshot,
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('renders only server-backed today earnings and completed work', () => {
    render(<TechSummaryPage />);
    expect(screen.getByText('$65.00')).toBeInTheDocument();
    expect(screen.getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('Deep tissue massage')).toBeInTheDocument();
    expect(screen.queryByText('Week')).not.toBeInTheDocument();
    expect(screen.queryByText('Month')).not.toBeInTheDocument();
  });
});
