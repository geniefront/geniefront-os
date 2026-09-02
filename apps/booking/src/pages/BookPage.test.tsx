import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Availability, type Catalog, type Shop } from '../lib/api';
import { BookPage } from './BookPage';

const getHostedShop = vi.fn();
const getServices = vi.fn();
const getAvailability = vi.fn();
const book = vi.fn();
const loadTurnstile = vi.fn();

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    getHostedShop: (...args: unknown[]) => getHostedShop(...args),
    getServices: (...args: unknown[]) => getServices(...args),
    getAvailability: (...args: unknown[]) => getAvailability(...args),
    book: (...args: unknown[]) => book(...args),
  };
});

vi.mock('../lib/turnstile', () => ({
  loadTurnstile: (...args: unknown[]) => loadTurnstile(...args),
}));

const shop: Shop = {
  name: 'Lotus Nails',
  slug: 'lotus-nails',
  timezone: 'America/New_York',
  currency: 'USD',
  phone: '+12125550100',
  address: { line1: '1 Main St' },
  businessHours: {},
  locales: ['en'],
  onlineBooking: {
    enabled: true, maxDaysAhead: 60, minMinutesAhead: 120,
    requirePhoneVerification: false, cancelCutoffHours: 4,
  },
  turnstileSiteKey: 'site-key',
  publicKey: 'pk_test',
};

const catalog: Catalog = {
  categories: [{ id: 'c1', name: 'Mani' }],
  services: [{
    id: 'svc-1', categoryId: 'c1', name: 'Gel Manicure', description: null,
    durationMin: 45, priceCents: 4500, isAddon: false,
  }],
  addons: [{
    id: 'add-1', categoryId: 'c1', name: 'Nail Art', description: null,
    durationMin: 15, priceCents: 1500, isAddon: true,
  }],
};

const nySlot = '2026-09-18T18:00:00.000Z'; // 2:00 PM in America/New_York

function avail(over: Partial<Availability> = {}): Availability {
  return {
    date: '2026-09-18',
    timezone: 'America/New_York',
    durationMin: 45,
    slots: [{ startsAt: nySlot, staff: null }],
    staff: [{ id: 'st-1', displayName: 'Amy', avatarUrl: null }],
    ...over,
  };
}

function renderBook() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/lotus-nails']}>
        <Routes>
          <Route path="/:slug" element={<BookPage />} />
          <Route path="/l/:slug/g/:token" element={<div>manage</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function throughToTime(user: ReturnType<typeof userEvent.setup>, withAddon = false) {
  await screen.findByText('Choose a service');
  await user.click(screen.getByTestId('service-svc-1'));
  if (withAddon) await user.click(screen.getByTestId('addon-add-1'));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Choose a specialist');
  await user.click(screen.getByTestId('staff-any'));
  await screen.findByText('Pick a time');
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  getHostedShop.mockReset().mockResolvedValue(shop);
  getServices.mockReset().mockResolvedValue(catalog);
  getAvailability.mockReset().mockResolvedValue(avail());
  book.mockReset();
  sessionStorage.clear();
  loadTurnstile.mockReset().mockResolvedValue({
    render: (_el: HTMLElement, opts: Record<string, unknown>) => {
      (opts['callback'] as (t: string) => void)('turnstile-token');
      return 'wid-1';
    },
    reset: vi.fn(),
    remove: vi.fn(),
  });
});

describe('BookPage', () => {
  it('adds add-on duration and reloads availability with addon ids', async () => {
    const user = userEvent.setup();
    renderBook();
    await screen.findByText('Choose a service');
    await user.click(screen.getByTestId('service-svc-1'));
    expect(screen.getByTestId('totals').textContent).toMatch(/45 min/);
    await user.click(screen.getByTestId('addon-add-1'));
    expect(screen.getByTestId('totals').textContent).toMatch(/1h/);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(getAvailability).toHaveBeenCalled());
    expect(getAvailability.mock.calls[0][0]).toMatchObject({
      serviceId: 'svc-1', addonIds: ['add-1'], staffId: null,
    });
  });

  it('sends any-specialist as null and a named specialist as that id', async () => {
    const user = userEvent.setup();
    renderBook();
    await throughToTime(user);
    const anyCall = getAvailability.mock.calls.at(-1)?.[0] as { staffId: string | null };
    expect(anyCall.staffId).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByTestId('staff-st-1'));
    await waitFor(() => {
      const last = getAvailability.mock.calls.at(-1)?.[0] as { staffId: string | null };
      expect(last.staffId).toBe('st-1');
    });
  });

  it('shows slot times in the shop timezone', async () => {
    const user = userEvent.setup();
    renderBook();
    await throughToTime(user);
    expect(screen.getByTestId(`slot-${nySlot}`).textContent).toMatch(/2:00/);
    expect(screen.getByText(/America\/New York/)).toBeInTheDocument();
  });

  it('returns to time selection and reloads slots after a 409', async () => {
    const user = userEvent.setup();
    book.mockRejectedValueOnce(new ApiError('RESOURCE_CONFLICT', 409));
    renderBook();
    await throughToTime(user);
    await user.click(screen.getByTestId(`slot-${nySlot}`));
    await screen.findByText('Confirm your details');
    await user.type(screen.getByLabelText('Name'), 'Amy Chen');
    await user.type(screen.getByLabelText('Mobile phone'), '6175550199');
    getAvailability.mockClear();
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    await screen.findByText(/just booked/i);
    expect(screen.getByText('Pick a time')).toBeInTheDocument();
    expect(getAvailability).toHaveBeenCalled();
  });

  it('double-click submit sends one request with one idempotency key', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const keys: string[] = [];
    book.mockImplementation(async (_input: unknown, idem: string) => {
      keys.push(idem);
      await gate;
      return {
        bookingId: 'b1', confirmationCode: 'LN-4K2P', manageToken: 'mt_abc',
        replayed: false, startsAt: nySlot, durationMin: 45, status: 'booked',
      };
    });
    renderBook();
    await throughToTime(user);
    await user.click(screen.getByTestId(`slot-${nySlot}`));
    await user.type(screen.getByLabelText('Name'), 'Amy Chen');
    await user.type(screen.getByLabelText('Mobile phone'), '6175550199');
    const submit = screen.getByRole('button', { name: 'Book appointment' });
    await user.click(submit);
    await user.click(submit);
    release();
    await screen.findByTestId('confirmation-code');
    expect(keys).toHaveLength(1);
  });

  it('resets Turnstile after a failed submission', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    loadTurnstile.mockResolvedValue({
      render: (_el: HTMLElement, opts: Record<string, unknown>) => {
        (opts['callback'] as (t: string) => void)('turnstile-token');
        return 'wid-1';
      },
      reset,
      remove: vi.fn(),
    });
    book.mockRejectedValueOnce(new ApiError('VALIDATION_FAILED', 400, { reason: 'bot_check_failed' }));
    renderBook();
    await throughToTime(user);
    await user.click(screen.getByTestId(`slot-${nySlot}`));
    await user.type(screen.getByLabelText('Name'), 'Amy Chen');
    await user.type(screen.getByLabelText('Mobile phone'), '6175550199');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('wid-1'));
  });

  it('stores only minimum same-session data on success', async () => {
    const user = userEvent.setup();
    book.mockResolvedValue({
      bookingId: 'b1', confirmationCode: 'LN-4K2P', manageToken: 'mt_abc',
      replayed: false, startsAt: nySlot, durationMin: 45, status: 'booked',
    });
    renderBook();
    await throughToTime(user);
    await user.click(screen.getByTestId(`slot-${nySlot}`));
    await user.type(screen.getByLabelText('Name'), 'Amy Chen');
    await user.type(screen.getByLabelText('Mobile phone'), '6175550199');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    await screen.findByTestId('confirmation-code');
    const stored = sessionStorage.getItem('gf:last-booking') ?? '';
    expect(stored).toContain('LN-4K2P');
    expect(stored).toContain('mt_abc');
    expect(stored).not.toContain('Amy Chen');
    expect(stored).not.toContain('6175550199');
  });
});
