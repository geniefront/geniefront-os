import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {GuestCancellationPanel} from './GuestCancellationPanel';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
const state=vi.hoisted(()=>({online:true,run:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-owner',isOnline:state.online,can:()=>true})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>()=> 'Request interrupted; retry'}));
const appointment={appointmentId:'66666666-6666-4666-8666-666666666666',items:[{status:'booked',guestIndices:[0]},{status:'booked',guestIndices:[1]}],
  guestCancellation:{enabled:true,reason:null,currency:'USD'},guests:[
    {guestIndex:0,status:'active',serviceTotalCents:10000,refundableDepositCents:1176},
    {guestIndex:1,status:'active',serviceTotalCents:7000,refundableDepositCents:824}]} as AppointmentDetail;
const show=(data=appointment)=>render(<QueryClientProvider client={new QueryClient()}><GuestCancellationPanel appointment={data}/></QueryClientProvider>);
afterEach(()=>{cleanup();sessionStorage.clear();state.online=true;state.run.mockReset();});
it('confirms only selected guests and their exact refund quote, reusing the command key after an interruption',async()=>{
  const user=userEvent.setup();state.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({result:{remainingGuests:1}});
  show();await user.click(screen.getByRole('checkbox',{name:/Guest 1/}));await user.click(screen.getByRole('button',{name:'Cancel selected guests'}));
  const dialog=screen.getByRole('dialog'),approval=within(dialog).getByRole('button',{name:'Cancel selected guests'});
  expect(approval).toBeDisabled();expect(within(dialog).getByText(/\$11.76/)).toBeInTheDocument();
  await user.type(within(dialog).getByLabelText('Reason for cancellation'),'QA guest A cancels');
  await user.click(approval);await screen.findByRole('alert');await user.click(approval);
  expect(state.run).toHaveBeenCalledTimes(2);expect(state.run.mock.calls[0]?.[1]).toEqual({appointmentId:'66666666-6666-4666-8666-666666666666',guestIndices:[0],reason:'QA guest A cancels',expectedRefundCents:1176});
  expect(state.run.mock.calls[0]?.[3]).toBe(state.run.mock.calls[1]?.[3]);
});
it('requires all participants of a shared service and keeps selection read-only offline',async()=>{
  const user=userEvent.setup();show({...appointment,items:[{guestIndices:[0,1],status:'booked'}] as AppointmentDetail['items']});
  await user.click(screen.getByRole('checkbox',{name:/Guest 1/}));
  expect(screen.getByRole('button',{name:'Cancel selected guests'})).toBeDisabled();
  expect(screen.getByText('A shared service requires all its participating guests to be selected together.')).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox',{name:/Guest 2/}));expect(screen.getByRole('button',{name:'Cancel selected guests'})).toBeEnabled();
  cleanup();state.online=false;show();expect(screen.getByRole('checkbox',{name:/Guest 1/})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Cancel selected guests'})).toBeDisabled();expect(state.run).not.toHaveBeenCalled();
});
