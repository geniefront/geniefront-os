import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Availability, type Catalog, type Shop } from '../lib/api';
import { addDays, bookingToday, lastBookableDate, todayIn } from '../lib/format';
import { BookPage } from './BookPage';

const getHostedShop = vi.fn();
const getServices = vi.fn();
const getBundles = vi.fn();
const getAvailability = vi.fn();
const book = vi.fn();
const loadTurnstile = vi.fn();

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    getHostedShop: (...args: unknown[]) => getHostedShop(...args),
    getServices: (...args: unknown[]) => getServices(...args),
    getBundles: (...args: unknown[]) => getBundles(...args),
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
  businessDayCutoff: '04:00',
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
          <Route path="/l/:slug" element={<div>manage</div>} />
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
  getBundles.mockReset().mockResolvedValue({ bundles: [] });
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

  it('searches past 14 days when maxDaysAhead is greater', async () => {
    const user = userEvent.setup();
    const start = todayIn(shop.timezone);
    const far = addDays(start, 20);
    getAvailability.mockImplementation(async (q: { date: string }) => {
      if (q.date === far) return avail({ date: far, slots: [{ startsAt: nySlot, staff: null }] });
      return avail({ date: q.date, slots: [] });
    });
    renderBook();
    await screen.findByText('Choose a service');
    await user.click(screen.getByTestId('service-svc-1'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Choose a specialist');
    await waitFor(() => {
      const dates = getAvailability.mock.calls.map((c) => (c[0] as { date: string }).date);
      expect(dates).toContain(far);
    });
    await user.click(screen.getByTestId('staff-any'));
    await screen.findByText('Pick a time');
    expect(screen.getByTestId(`day-${far}`)).toBeInTheDocument();
    expect(screen.getByTestId('later-days')).toBeInTheDocument();
  });

  it('searches today+maxDaysAhead inclusive', async () => {
    const user = userEvent.setup();
    const start = bookingToday(shop.timezone, shop.businessDayCutoff);
    const last = lastBookableDate(start, shop.onlineBooking.maxDaysAhead);
    getAvailability.mockImplementation(async (q: { date: string }) => {
      if (q.date === last) return avail({ date: last, slots: [{ startsAt: nySlot, staff: null }] });
      return avail({ date: q.date, slots: [] });
    });
    renderBook();
    await screen.findByText('Choose a service');
    await user.click(screen.getByTestId('service-svc-1'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      const dates = getAvailability.mock.calls.map((c) => (c[0] as { date: string }).date);
      expect(dates).toContain(last);
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

  it('resets Turnstile after a 429', async () => {
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
    book.mockRejectedValueOnce(new ApiError('RATE_LIMITED', 429, { scope: 'ip', retryAfterSec: 60 }));
    renderBook();
    await throughToTime(user);
    await user.click(screen.getByTestId(`slot-${nySlot}`));
    await user.type(screen.getByLabelText('Name'), 'Amy Chen');
    await user.type(screen.getByLabelText('Mobile phone'), '6175550199');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('wid-1'));
    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
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
    const manage = screen.getByRole('link', { name: /view, reschedule, or cancel/i });
    expect(manage.getAttribute('href')).toBe('/l/lotus-nails#g/mt_abc');
  });

  it('omits the call prompt on success when the shop has no phone', async () => {
    const user = userEvent.setup();
    getHostedShop.mockResolvedValue({ ...shop, phone: null });
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

    expect(screen.getByText('Keep this page or your confirmation text.')).toBeInTheDocument();
    expect(screen.queryByText(/Questions\? Call/)).not.toBeInTheDocument();
  });

  it('books a bundle: skips specialist, queries availability by bundleId, submits bundleSelections', async () => {
    const user = userEvent.setup();
    getBundles.mockResolvedValue({ bundles: [{
      id: 'bnd-1', version: 1, name: 'Mani + Pedi Combo', description: null,
      priceCents: 10000, originalTotalCents: 12000, bundleDiscountCents: 2000,
      components: [
        { serviceId: 'svc-1', name: 'Gel Manicure', qty: 1, seq: 0, listPriceCents: 4500, durationMin: 45 },
        { serviceId: 'svc-2', name: 'Spa Pedicure', qty: 1, seq: 1, listPriceCents: 7500, durationMin: 60 },
      ],
      bookable: true,
    }] });
    book.mockResolvedValue({
      bookingId: 'b1', confirmationCode: 'LN-9Z9Z', manageToken: 'mt_x',
      replayed: false, startsAt: nySlot, durationMin: 105, status: 'booked',
    });
    renderBook();

    await screen.findByText('Choose a service');
    await user.click(await screen.findByTestId('bundle-bnd-1'));

    // 直接进「选时间」，跳过选技师
    await screen.findByText('Pick a time');
    const bundleAvailCall = getAvailability.mock.calls.at(-1)?.[0] as { bundleId?: string };
    expect(bundleAvailCall.bundleId).toBe('bnd-1');

    await user.click(screen.getByTestId(`slot-${nySlot}`));
    await user.type(screen.getByLabelText('Name'), 'Amy Chen');
    await user.type(screen.getByLabelText('Mobile phone'), '6175550199');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    await screen.findByTestId('confirmation-code');

    const body = book.mock.calls[0][0] as {
      items: unknown[]; bundleSelections?: Array<{ bundleId: string; startsAt: string }>;
    };
    expect(body.items).toEqual([]);
    expect(body.bundleSelections).toEqual([{ bundleId: 'bnd-1', startsAt: nySlot }]);
  });
});

it.each(['success', 'failure'])('#25 keeps the latest date when the stale request ends in %s', async outcome => {
  const user = userEvent.setup();
  renderBook(); await throughToTime(user);
  const days = screen.getAllByTestId(/^day-\d/).slice(1, 3);
  const dates = days.map(button => button.getAttribute('data-testid')!.slice(4));
  let resolveOld!: (value: Availability) => void;
  let rejectOld!: (reason: Error) => void;
  let resolveNew!: (value: Availability) => void;
  getAvailability.mockImplementation(({ date }: { date: string }) => new Promise((resolve, reject) => {
    if (date === dates[0]) { resolveOld = resolve; rejectOld = reject; }
    else resolveNew = resolve;
  }));
  await user.click(days[0]!); await user.click(days[1]!);
  const newSlot = `${dates[1]}T18:00:00.000Z`;
  const oldSlot = `${dates[0]}T18:00:00.000Z`;
  resolveNew(avail({ date: dates[1]!, slots: [{ startsAt: newSlot, staff: null }] }));
  await screen.findByTestId(`slot-${newSlot}`);
  if (outcome === 'failure') rejectOld(new Error('old request failed'));
  else resolveOld(avail({ date: dates[0]!, slots: [{ startsAt: oldSlot, staff: null }] }));
  await waitFor(() => expect(screen.queryByTestId(`slot-${oldSlot}`)).not.toBeInTheDocument());
  expect(screen.getByTestId(`slot-${newSlot}`)).toBeInTheDocument();
});
