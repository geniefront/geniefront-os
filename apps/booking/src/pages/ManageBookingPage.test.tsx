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
const cancelManagedGuests = vi.fn();
const rescheduleManagedBooking = vi.fn();
const getManagedAvailability = vi.fn();

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    getHostedShop: (...args: unknown[]) => getHostedShop(...args),
    loadManagedBooking: (...args: unknown[]) => loadManagedBooking(...args),
    cancelManagedBooking: (...args: unknown[]) => cancelManagedBooking(...args),
    cancelManagedGuests: (...args: unknown[]) => cancelManagedGuests(...args),
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
  cancelManagedGuests.mockReset();
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
    await user.click(screen.getByRole('button', { name: 'Continue to edit' }));
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
    await user.click(screen.getByRole('button', { name: 'Continue to edit' }));
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
    await user.click(screen.getByRole('button', { name: 'Continue to edit' }));
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
    await user.click(screen.getByRole('button', { name: 'Continue to edit' }));
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
    await user.click(screen.getByRole('button', { name: 'Continue to edit' }));
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
  it.each([new ApiError('NETWORK',0),new ApiError('UPSTREAM_UNAVAILABLE',503)])('offers a protected retry after temporary loading failure %s',async(error)=>{
    const user=userEvent.setup();loadManagedBooking.mockRejectedValueOnce(error).mockResolvedValue(boot());
    renderManage();await screen.findByText('Your appointment could not be loaded');
    expect(screen.queryByText(/This appointment link is not available/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Cancel'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Try again'}));await screen.findByText('Gel Manicure');
    expect(loadManagedBooking).toHaveBeenLastCalledWith('lotus-nails','mt_secret','en');
    expect(screen.queryByText('mt_secret')).not.toBeInTheDocument();
  });
});

const guestBooking=()=>boot({guestCancellation:{enabled:true,reason:null,currency:'USD'},guests:[
  {guestIndex:0,status:'active',serviceTotalCents:10000,refundableDepositCents:1176},
  {guestIndex:1,status:'active',serviceTotalCents:7000,refundableDepositCents:824},
],items:[
  {serviceId:'a',guestIndex:0,name:'Guest A service',addonIds:[],addonNames:[],startsAt:slot,endsAt:slot,durationMin:30,priceCents:10000,specialistName:null},
  {serviceId:'b',guestIndex:1,name:'Guest B service',addonIds:[],addonNames:[],startsAt:slot,endsAt:slot,durationMin:30,priceCents:7000,specialistName:null},
]});
it('submits only the selected guest and exact refund quote, retaining its request ID after an interrupted response',async()=>{
  loadManagedBooking.mockResolvedValue(guestBooking());
  cancelManagedGuests.mockRejectedValueOnce(new ApiError('NETWORK',0)).mockResolvedValue({status:'booked',remainingGuests:1});
  const user=userEvent.setup();renderManage();await screen.findByText(/Guest A service/);
  await user.type(screen.getByTestId('last4'),'1234');await user.click(screen.getByRole('button',{name:'Continue to edit'}));
  await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
  await user.click(screen.getByRole('checkbox',{name:/Guest 1/}));
  await user.type(screen.getByRole('textbox',{name:'Reason for cancellation'}),'One guest cannot attend');
  expect(screen.getByText('Deposit reserved for refund: $11.76')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
  await screen.findByRole('alert');await user.click(screen.getByRole('button',{name:'Retry saved request'}));
  await waitFor(()=>expect(cancelManagedGuests).toHaveBeenCalledTimes(2));
  expect(cancelManagedGuests.mock.calls[0]).toEqual(cancelManagedGuests.mock.calls[1]);
  expect(cancelManagedGuests.mock.calls[0]).toEqual(['b1',expect.objectContaining({guestIndices:[0],reason:'One guest cannot attend',
    expectedRefundCents:1176,last4:'1234',manageToken:'mt_secret',requestId:expect.any(String)}),'pk_test']);
  expect(cancelManagedBooking).not.toHaveBeenCalled();
});
it('requires all participants of a shared service before customer cancellation',async()=>{
  const b=guestBooking();b.booking.items=[{...b.booking.items[0]!,guestIndices:[0,1],priceCents:17000}];
  loadManagedBooking.mockResolvedValue(b);const user=userEvent.setup();renderManage();await screen.findByText(/Guest A service/);
  await user.type(screen.getByTestId('last4'),'1234');await user.click(screen.getByRole('button',{name:'Continue to edit'}));
  await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
  await user.click(screen.getByRole('checkbox',{name:/Guest 1/}));await user.type(screen.getByRole('textbox',{name:'Reason for cancellation'}),'Shared booking cancelled');
  expect(screen.getByRole('button',{name:'Cancel selected guests'})).toBeDisabled();
  expect(screen.getByText('A shared service requires all its participating guests to be selected together.')).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox',{name:/Guest 2/}));expect(screen.getByRole('button',{name:'Cancel selected guests'})).toBeEnabled();
  expect(cancelManagedGuests).not.toHaveBeenCalled();
});


it('requires the reduced pending quote to be accepted, then keeps the original cancellation across a lost success and reload',async()=>{
 const initial=guestBooking();initial.booking.bookingId='70000000-0000-4000-8000-000000000001';initial.booking.priceCents=17000;
 initial.booking.guests=initial.booking.guests!.map(g=>({...g,refundableDepositCents:0}));
 initial.booking.deposit={status:'pending',amountCents:3400,availableCents:0,currency:'USD',expiresAt:'2030-01-01T12:00:00Z',checkoutUrl:null,policy:{cancelCutoffHours:4,notice:'',retainAfterCutoff:false}};
 const quote={quoteHash:'b'.repeat(64),currency:'USD',serviceTotalCents:7000,requiredCents:1400,availableCents:0,requestCents:1400,excessCents:0,
  previousServiceTotalCents:17000,hasConfirmedBooking:false,expiresAt:initial.booking.deposit.expiresAt,purpose:'replacement'};
 loadManagedBooking.mockResolvedValue(initial);cancelManagedGuests.mockRejectedValueOnce(new ApiError('VALIDATION_FAILED',400,{reason:'deposit_quote_reconfirmation_required',notApplied:true,depositQuote:quote}))
  .mockRejectedValueOnce(new ApiError('NETWORK',0)).mockResolvedValue({status:'booked',remainingGuests:1,replayed:true});
 const user=userEvent.setup(),view=renderManage();await screen.findByText(/Guest A service/);
 await user.type(screen.getByTestId('last4'),'1234');await user.click(screen.getByRole('button',{name:'Continue to edit'}));await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
 await user.click(screen.getByRole('checkbox',{name:/Guest 1/}));await user.type(screen.getByRole('textbox',{name:'Reason for cancellation'}),'One unpaid guest cancels');
 await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));await screen.findByRole('heading',{name:'Review updated deposit'});
 expect(screen.getByRole('button',{name:'Cancel selected guests'})).toBeDisabled();
 await user.click(screen.getByRole('checkbox',{name:/I agree to the updated service price/}));await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
 await screen.findByRole('button',{name:'Retry saved request'});await screen.findByRole('alert');const approved=cancelManagedGuests.mock.calls[1]![1];
 view.unmount();const updated={...initial,booking:{...initial.booking,priceCents:7000,guests:initial.booking.guests!.map(g=>g.guestIndex===0?{...g,status:'cancelled' as const}:g)}};
 loadManagedBooking.mockResolvedValue(updated);renderManage();await screen.findByText(/Guest A service/);
 await user.type(screen.getByTestId('last4'),'1234');await user.click(screen.getByRole('button',{name:'Continue to edit'}));await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
 await screen.findByRole('button',{name:'Retry saved request'});expect(screen.getByRole('textbox',{name:'Reason for cancellation'})).toBeDisabled();
 await user.click(screen.getByRole('button',{name:'Retry saved request'}));await waitFor(()=>expect(cancelManagedGuests).toHaveBeenCalledTimes(3));
 expect(cancelManagedGuests.mock.calls[2]![1]).toEqual(approved);expect(approved.depositAdjustment).toEqual({accepted:true,quoteHash:quote.quoteHash});
});
