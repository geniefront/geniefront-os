import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppointmentDrawer } from './AppointmentDrawer';

const state = vi.hoisted(() => ({ phone: null as string | null, email: null as string | null, loading: false, plan: 'voice_booking', cancelled: false, depositStatus: null as string | null, appointmentStatus:'booked' }));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key, language: 'en' }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ useOpenInternalRoute: () => vi.fn() }));
vi.mock('@/lib/errorMessage', () => ({ useErrorMessage: () => String }));
vi.mock('@/features/billing/useEntitlements', () => ({ useEntitlements: () => ({ data: { plan: state.plan } }) }));
vi.mock('@/context/ScheduleContext', () => ({
  UNASSIGNED_STAFF_ID: 'unassigned',
  useSchedule: () => ({ currentDate: '2026-09-22', timezone: 'America/New_York', services: [], staff: [], resources: [], refetch: vi.fn() }),
}));
vi.mock('@/lib/time', async (original) => ({
  ...await original<typeof import('@/lib/time')>(),
  useStoreTime: () => ({ dateTime: (value: string) => value }),
}));
vi.mock('@/features/schedule/appointmentDetail', () => ({
  useAppointmentDetailQuery: () => ({ isLoading: state.loading, data: state.loading ? undefined : {
    appointmentId: 'appointment', status: state.appointmentStatus, customer: { id: 'customer', name: 'Online Guest', phone: state.phone },
    items: [{ itemId: 'item', serviceId: 'service', serviceName: 'Massage', staffId: null, staffName: null, resourceId: null, resourceName: null, startsAt: '2026-09-22T21:30:00Z', durationMin: 60, priceCents: 6000, status: state.cancelled ? 'cancelled' : 'booked' }],
    ticket: null, notes: null, bundles: [],deposit:state.depositStatus?{status:state.depositStatus}:null,
  } }),
  useAppointmentFormsQuery: () => ({}), useHealthFormSubmissionQuery: () => ({}),
  useAddAppointmentItem: () => ({}), useSaveAppointmentServiceBrief: () => ({}), useUpdateAppointmentCustomer: () => ({}),
}));
vi.mock('@/features/customers/api', () => ({
  useCustomerDetail: () => ({ data: { id: 'customer', displayName: 'Online Guest', phone: state.phone, email: state.email, preferences: { freeNotes: null }, visits: { total: 0, lastAt: null, avgSpendCents: null }, giftCards: [], tags: [] } }),
  useSaveCustomerPreferences: () => ({}), useSaveCustomerProfile: () => ({}),
}));
vi.mock('@/features/tickets/api', () => ({ useTicketsList: () => ({}), useAddTicketItem: () => ({}), useSaveServiceNote: () => ({}) }));
vi.mock('@/features/schedule/api', () => ({ useCancelAppointment: () => ({}), useRescheduleAppointment: () => ({}) }));
vi.mock('@/features/forms/api', () => ({ useShareForm: () => ({}) }));
vi.mock('@/features/schedule/AppointmentCall', () => ({ AppointmentCall: () => null }));
vi.mock('@/features/commerce/AppointmentDepositServiceDialog', () => ({ AppointmentDepositServiceDialog: () => null }));
vi.mock('@/features/commerce/AppointmentDepositPanel', () => ({ AppointmentDepositPanel: () => <div>Deposit panel</div> }));
vi.mock('@/features/schedule/PendingBookingAssignments', () => ({ PendingBookingAssignments: () => null }));
vi.mock('@/components/ui/GuardedButton', () => ({ GuardedButton: ({ children, isDisabled, disabled }: any) => <button disabled={isDisabled ?? disabled}>{children}</button> }));
vi.mock('@/components/ui/Button', () => ({ Button: ({ children }: any) => <button>{children}</button> }));
vi.mock('@/components/ui/Modal', () => ({ Modal: () => null }));
vi.mock('@/components/ui/Badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
afterEach(() => { cleanup(); state.cancelled = false; state.depositStatus = null; state.appointmentStatus='booked'; });

describe.each(['voice_booking', 'full'])('online appointment contact details (%s)', (plan) => {
  it.each([
    [null, 'guest@example.com'],
    ['+12125550123', null],
    [null, null],
  ])('opens an unassigned appointment with phone=%s email=%s', (phone, email) => {
    state.plan = plan;
    state.phone = phone;
    state.email = email;
    state.loading = true;
    const view = render(<AppointmentDrawer appointmentId="appointment" onClose={() => {}} />);
    expect(screen.getByText('schedule.adLoadingAll')).toBeInTheDocument();
    state.loading = false;
    view.rerender(<AppointmentDrawer appointmentId="appointment" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Online Guest' })).toBeInTheDocument();
    expect(screen.getByText('Massage')).toBeInTheDocument();
    if (email) expect(screen.getByText(email)).toBeInTheDocument();
    if (!phone) expect(screen.getByText('schedule.adNoPhone')).toBeInTheDocument();
  });
});

it('keeps cancelled service history visible but prevents editing it', () => {
  state.loading = false; state.plan = 'full'; state.cancelled = true;
  render(<AppointmentDrawer appointmentId="appointment" onClose={() => {}} />);
  expect(screen.getByText('Massage')).toHaveClass('line-through');
  expect(screen.getByRole('button', { name: 'schedule.adEditItem' })).toBeDisabled();
});

it('shows unpaid holds as awaiting deposit throughout the drawer and defers arrival guidance',()=>{
  state.loading=false;state.plan='full';state.depositStatus='pending';
  render(<AppointmentDrawer appointmentId="appointment" onClose={()=>{}}/>);
  expect(screen.getAllByText('Awaiting deposit payment')).toHaveLength(3);
  expect(screen.queryByText('schedule.adStageBooked')).not.toBeInTheDocument();
  expect(screen.queryByText('schedule.adPaymentNone')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'schedule.adGoToBoard'})).not.toBeInTheDocument();
  expect(screen.getByText(/Pay before the deadline to confirm the appointment/)).toBeInTheDocument();
});

it('shows the normal booked stage after the deposit is paid',()=>{
  state.loading=false;state.plan='full';state.depositStatus='paid';
  render(<AppointmentDrawer appointmentId="appointment" onClose={()=>{}}/>);
  expect(screen.queryByText('Awaiting deposit payment')).not.toBeInTheDocument();
  expect(screen.getAllByText('schedule.adStageBooked')).toHaveLength(2);
  expect(screen.getByRole('button',{name:'schedule.adGoToBoard'})).toBeInTheDocument();
});

it('keeps terminal appointment services closed while explaining separate deposit handling',()=>{
  state.loading=false;state.plan='full';state.depositStatus='retained';state.appointmentStatus='cancelled';
  render(<AppointmentDrawer appointmentId="appointment" onClose={()=>{}}/>);
  expect(screen.getByText('Appointment services are closed. Any remaining deposit is handled separately.')).toBeInTheDocument();
  expect(screen.queryByText('schedule.adStatusTerminalHint')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'schedule.adEditItem'})).toBeDisabled();
});
