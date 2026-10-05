import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LanguageProvider} from '../lib/i18n';
import type {ManagedBooking,Shop} from '../lib/api';
import {AppointmentDeposit} from './AppointmentDeposit';
import {SuccessStep} from '../pages/BookPage';
const deposit={status:'pending',amountCents:2000,availableCents:0,currency:'USD',expiresAt:new Date(Date.now()+900000).toISOString(),
  checkoutUrl:'https://checkout.stripe.com/qa-deposit',policy:{cancelCutoffHours:4,notice:'Refundable before cutoff',retainAfterCutoff:false}};
const wrap=(node:React.ReactNode)=>render(<LanguageProvider><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider></LanguageProvider>);
afterEach(()=>{cleanup();vi.useRealTimers();});
it('offers payment while clearly showing the required deposit and the remaining service amount',()=>{
  wrap(<AppointmentDeposit deposit={deposit} serviceCents={10000} timezone="America/New_York"/>);
  expect(screen.getByRole('link',{name:'Pay deposit'}).getAttribute('href')).toBe(deposit.checkoutUrl);
  expect(screen.getByRole('heading',{name:'Awaiting deposit payment'})).toBeTruthy();
  expect(screen.getByText('Refundable before cutoff')).toBeTruthy();
  expect(screen.getByText('$80')).toBeTruthy();expect(screen.getByText('$20')).toBeTruthy();
});
it('removes the payment action when the local reservation deadline has expired',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,expiresAt:new Date(Date.now()-1000).toISOString()}} serviceCents={10000} timezone="America/New_York"/>);
  expect(screen.getByRole('heading',{name:'Reservation expired'})).toBeTruthy();expect(screen.queryByRole('link',{name:'Pay deposit'})).toBeNull();
});
it('shows no outstanding service amount once the server confirms the invoice is settled',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,status:'paid',availableCents:0,appliedCents:2000,serviceRemainingCents:0,checkoutUrl:null}}
    serviceCents={10000} timezone="America/Los_Angeles"/>);
  expect(screen.getByText('Deposit applied to services')).toBeTruthy();
  expect(screen.queryByText('$80')).toBeNull();expect(screen.getAllByText('$0')).toHaveLength(2);
});
it('does not call a pending reservation confirmed or offer a calendar confirmation',()=>{
  const summary={bookingId:'qa-deposit',status:'booked',priceCents:10000,deposit} as ManagedBooking;
  const shop={timezone:'America/New_York',currency:'USD',phone:null} as Shop;
  wrap(<SuccessStep shop={shop} slug="golden-foot" done={{bookingId:summary.bookingId,manageToken:null,summary,status:'booked'}} onAgain={()=>{}} calendarUrl="data:text/calendar,QA"/>);
  expect(screen.getByRole('heading',{level:1,name:'Awaiting deposit payment'})).toBeTruthy();
  expect(screen.queryByText('Appointment confirmed')).toBeNull();expect(screen.queryByRole('link',{name:/Add to calendar/})).toBeNull();
});
it('shows the full service balance and ongoing refund after a waiver without offering payment',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,status:'waived',financialStatus:'refund_pending',serviceRemainingCents:10000,checkoutUrl:null,
    guestAllocation:{method:'service_price',guests:[{guestIndex:0,serviceTotalCents:5000,amountCents:1000},{guestIndex:1,serviceTotalCents:5000,amountCents:1000}]}}}
    serviceCents={10000} timezone="America/Los_Angeles"/>);
  expect(screen.getByRole('heading',{name:'Deposit waived'})).toBeTruthy();
  expect(screen.getByText('Deposit refund in progress')).toBeTruthy();
  expect(screen.getByText('$100')).toBeTruthy();expect(screen.queryByRole('link',{name:'Pay deposit'})).toBeNull();
  expect(screen.queryByText('Original quoted deposit by guest')).toBeNull();
  expect(screen.queryByText('Payment confirms your booking.',{exact:false})).toBeNull();
});
it('explains the original guest shares and the cancelled guest refund while showing only the active service balance',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,status:'refund_pending',availableCents:824,serviceRemainingCents:6176,checkoutUrl:null,
    guestAllocation:{method:'service_price',guests:[{guestIndex:0,serviceTotalCents:10000,amountCents:1176,cancelled:true,refundStatus:'pending'},
      {guestIndex:1,serviceTotalCents:7000,amountCents:824,cancelled:false}]}}} serviceCents={7000} timezone="America/Los_Angeles"/>);
  expect(screen.getByText('Original quoted deposit by guest')).toBeTruthy();expect(screen.getByText('Guest 1 · Cancelled')).toBeTruthy();
  expect(screen.getByText('$61.76')).toBeTruthy();expect(screen.getByText('$11.76')).toBeTruthy();expect(screen.queryByText('$170')).toBeNull();
});
it('explains frontdesk payment when an AI caller has no online payment channel',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,checkoutUrl:null,paymentMethod:'frontdesk'}} serviceCents={10000} timezone="America/Los_Angeles"/>);
  expect(screen.getByText('Contact the store to arrange the deposit before the deadline. Your appointment is not confirmed yet.')).toBeTruthy();
  expect(screen.queryByText('Preparing payment link')).toBeNull();expect(screen.queryByRole('link',{name:'Pay deposit'})).toBeNull();
});

it('distinguishes retained deposit from refunded money without showing a new payment action',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,status:'retained',availableCents:0,retainedCents:1200,refundedCents:800,serviceRemainingCents:0,checkoutUrl:null}}
    serviceCents={0} timezone="America/Los_Angeles"/>);
  expect(screen.getByRole('heading',{name:'Deposit retained'})).toBeTruthy();expect(screen.getByText('$12')).toBeTruthy();expect(screen.getByText('$8')).toBeTruthy();
  expect(screen.queryByRole('link',{name:'Pay deposit'})).toBeNull();
});

it('shows a separate supplementary payment without calling the existing booking unconfirmed, and removes its expired link',()=>{
  const additional={amountCents:1000,expiresAt:new Date(Date.now()+60000).toISOString(),state:'open',checkoutUrl:null,paymentMethod:'frontdesk' as const};
  wrap(<AppointmentDeposit deposit={{...deposit,status:'paid',availableCents:2000,checkoutUrl:null,additionalPayment:additional}} serviceCents={15000} timezone="America/Los_Angeles"/>);
  expect(screen.getByRole('heading',{name:/Additional deposit requested/})).toBeTruthy();
  expect(screen.getByText('Contact the store to arrange this additional payment. Your existing booking remains confirmed.')).toBeTruthy();
  expect(screen.queryByText('Contact the store to arrange the deposit before the deadline. Your appointment is not confirmed yet.')).toBeNull();
});
it('never offers an expired supplementary link while still displaying the originally paid balance',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,status:'paid',availableCents:2000,checkoutUrl:null,additionalPayment:{amountCents:1000,
    expiresAt:new Date(Date.now()-1000).toISOString(),state:'open',checkoutUrl:'https://checkout.stripe.com/expired-qa',paymentMethod:'online'}}} serviceCents={15000} timezone="America/Los_Angeles"/>);
  expect(screen.getByRole('heading',{name:'Deposit paid'})).toBeTruthy();expect(screen.getByText('This payment request has expired. Your existing booking remains confirmed.')).toBeTruthy();
  expect(screen.queryByRole('link',{name:'Pay deposit'})).toBeNull();
});
it('shows an agreed zero-required deposit without pretending a payment was made or asking for payment',()=>{
  wrap(<AppointmentDeposit deposit={{...deposit,status:'not_required',amountCents:0,availableCents:0,checkoutUrl:null,serviceRemainingCents:0}} serviceCents={0} timezone="America/Los_Angeles"/>);
  expect(screen.getByRole('heading',{name:'No deposit required'})).toBeTruthy();expect(screen.queryByRole('link',{name:'Pay deposit'})).toBeNull();
  expect(screen.queryByText('Payment confirms your booking.',{exact:false})).toBeNull();
});
it('shows the unused policy excess as refundable money instead of converting it to a tip',()=>{
 wrap(<AppointmentDeposit deposit={{...deposit,status:'paid',availableCents:2000,excessCents:1000,serviceRemainingCents:3000,checkoutUrl:null}} serviceCents={5000} timezone="America/Los_Angeles"/>);
 expect(screen.getByText('Excess deposit available to refund')).toBeTruthy();expect(screen.getByText('$10')).toBeTruthy();
});
