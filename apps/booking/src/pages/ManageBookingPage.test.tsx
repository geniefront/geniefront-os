import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ManageBootstrap, type Shop } from '../lib/api';
import { ManageBookingPage } from './ManageBookingPage';

const getHostedShop = vi.fn();
const loadManagedBooking = vi.fn();
const cancelManagedBooking = vi.fn();
const rescheduleManagedBooking = vi.fn();
const getManagedAvailability = vi.fn();

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    getHostedShop: (...args: unknown[]) => getHostedShop(...args),
    loadManagedBooking: (...args: unknown[]) => loadManagedBooking(...args),
    cancelManagedBooking: (...args: unknown[]) => cancelManagedBooking(...args),
    rescheduleManagedBooking: (...args: unknown[]) => rescheduleManagedBooking(...args),
    getManagedAvailability: (...args: unknown[]) => getManagedAvailability(...args),
  };
});

const shop: Shop = {
  name: 'Lotus Nails',
  slug: 'lotus-nails',
  timezone: 'America/New_York',
  currency: 'USD',
  businessDayCutoff: '04:00',
  phone: '+12125550100',
  address: null,
  businessHours: {},
  locales: ['en'],
  onlineBooking: {
    enabled: true, maxDaysAhead: 60, minMinutesAhead: 120,
    requirePhoneVerification: false, cancelCutoffHours: 4,
  },
  turnstileSiteKey: null,
  publicKey: 'pk_test',
};

const slot = '2026-09-20T18:00:00.000Z';

function boot(over: Partial<ManageBootstrap['booking']> = {}): ManageBootstrap {
  return {
    publicKey: 'pk_test',
    shop,
    booking: {
      bookingId: 'b1',
      confirmationCode: 'LN-4K2P',
      status: 'booked',
      startsAt: '2026-09-18T18:00:00.000Z',
      endsAt: '2026-09-18T18:45:00.000Z',
      timezone: 'America/New_York',
      durationMin: 45,
      priceCents: 4500,
      specialistName: 'Amy',
      items: [{
        serviceId: 'svc-1', name: 'Gel Manicure', addonIds: [], addonNames: [],
        startsAt: '2026-09-18T18:00:00.000Z', endsAt: '2026-09-18T18:45:00.000Z',
        durationMin: 45, priceCents: 4500, specialistName: 'Amy',
      }],
      policy: {
        cancelCutoffHours: 4, rescheduleEnabled: true,
        rescheduleCutoffHours: 4, selfRescheduleMax: 2,
      },
      actions: {
        canReschedule: true, canCancel: true, canRebook: true,
        reason: null, rescheduleCountLeft: 2,
      },
      ...over,
    },
  };
}

function renderManage(path = '/l/lotus-nails#g/mt_secret') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/l/:slug/g/:token" element={<ManageBookingPage />} />
          <Route path="/l/:slug" element={<ManageBookingPage />} />
          <Route path="/:slug" element={<div>rebook</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getHostedShop.mockReset().mockResolvedValue(shop);
  loadManagedBooking.mockReset().mockResolvedValue(boot());
  cancelManagedBooking.mockReset();
  rescheduleManagedBooking.mockReset();
  getManagedAvailability.mockReset().mockResolvedValue({
    date: '2026-09-20', timezone: 'America/New_York', durationMin: 45,
    canReschedule: true, reason: null,
    slots: [{ startsAt: slot, staff: { id: 'st-1', displayName: 'Amy' } }],
    staff: [{ id: 'st-1', displayName: 'Amy', avatarUrl: null }],
  });
  localStorage.clear();
  sessionStorage.clear();
});

describe('ManageBookingPage', () => {
  it('bootstraps from the fragment token and still accepts the old path', async () => {
    const hash = renderManage('/l/lotus-nails#g/mt_secret');
    await screen.findByText('Gel Manicure');
    expect(loadManagedBooking).toHaveBeenCalledWith('lotus-nails', 'mt_secret', 'en');
    hash.unmount();

    loadManagedBooking.mockClear();
    const legacy = renderManage('/l/lotus-nails/g/mt_legacy');
    await screen.findByText('Gel Manicure');
    expect(loadManagedBooking).toHaveBeenCalledWith('lotus-nails', 'mt_legacy', 'en');
    legacy.unmount();
  });

  it('asks for last four before mutations and does not persist it', async () => {
    const user = userEvent.setup();
    renderManage();
    await screen.findByText('Gel Manicure');
    expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
    await user.type(screen.getByTestId('last4'), '4821');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(localStorage.getItem('last4')).toBeNull();
    expect(sessionStorage.getItem('last4')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('4821');
  });

  it('shows locked and mismatch last-four errors from the mutation', async () => {
    const user = userEvent.setup();
    cancelManagedBooking.mockRejectedValueOnce(
      new ApiError('PERMISSION_DENIED', 403, { reason: 'last4_mismatch', attemptsLeft: 2 }),
    );
    renderManage();
    await screen.findByTestId('last4');
    await user.type(screen.getByTestId('last4'), '0000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await screen.findByText(/did not match/i);
  });

  it('hides mutations when cutoff, limit, or reschedule-disabled', async () => {
    loadManagedBooking.mockResolvedValue(boot({
      actions: {
        canReschedule: false, canCancel: false, canRebook: true,
        reason: 'cutoff_passed', rescheduleCountLeft: 0,
      },
    }));
    renderManage();
    await screen.findByText(/too close to the appointment time/i);
    expect(screen.queryByTestId('last4')).not.toBeInTheDocument();
    expect(screen.getByText('Book again')).toBeInTheDocument();
  });

  it('pages the manage calendar past 14 days when maxDaysAhead is greater', async () => {
    const user = userEvent.setup();
    renderManage();
    await screen.findByTestId('last4');
    await user.type(screen.getByTestId('last4'), '4821');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(screen.getByTestId('later-days')).toBeInTheDocument();
  });

  it('updates the displayed time after a successful reschedule', async () => {
    const user = userEvent.setup();
    rescheduleManagedBooking.mockResolvedValue({
      bookingId: 'b1', status: 'booked', startsAt: slot, rescheduleCountLeft: 1,
    });
    loadManagedBooking
      .mockResolvedValueOnce(boot())
      .mockResolvedValueOnce(boot({ startsAt: slot, endsAt: '2026-09-20T18:45:00.000Z' }));
    renderManage();
    await screen.findByTestId('last4');
    await user.type(screen.getByTestId('last4'), '4821');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Reschedule' }));
    await screen.findByTestId(`reslot-${slot}`);
    expect(getManagedAvailability.mock.calls[0][0]).toMatchObject({
      slug: 'lotus-nails', manageToken: 'mt_secret',
    });
    await user.click(screen.getByTestId(`reslot-${slot}`));
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }));
    await waitFor(() => expect(screen.getByTestId('when').textContent).toMatch(/September 20/));
  });

  it('becomes read-only and offers rebook after cancellation', async () => {
    const user = userEvent.setup();
    cancelManagedBooking.mockResolvedValue({ bookingId: 'b1', status: 'cancelled' });
    loadManagedBooking
      .mockResolvedValueOnce(boot())
      .mockResolvedValueOnce(boot({
        status: 'cancelled',
        actions: {
          canReschedule: false, canCancel: false, canRebook: true,
          reason: 'not_mutable', rescheduleCountLeft: 2,
        },
      }));
    renderManage();
    await screen.findByTestId('last4');
    await user.type(screen.getByTestId('last4'), '4821');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await screen.findByTestId('status');
    expect(screen.getByTestId('status').textContent).toMatch(/cancelled/i);
    expect(screen.getByText('Book again')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('cannot mutate completed or no-show appointments', async () => {
    for (const status of ['completed', 'no_show']) {
      loadManagedBooking.mockResolvedValue(boot({
        status,
        actions: {
          canReschedule: false, canCancel: false, canRebook: true,
          reason: 'not_mutable', rescheduleCountLeft: 2,
        },
      }));
      const { unmount } = renderManage();
      await screen.findByTestId('status');
      expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
      expect(screen.getByText('Book again')).toBeInTheDocument();
      unmount();
    }
  });

  it('shows a generic error plus shop contact for an invalid token', async () => {
    loadManagedBooking.mockRejectedValue(new ApiError('NOT_FOUND', 404, { entity: 'booking' }));
    renderManage();
    await screen.findByText(/not available/i);
    expect(screen.getByText('+1 212 555 0100')).toBeInTheDocument();
    expect(screen.queryByText('mt_secret')).not.toBeInTheDocument();
  });
});
