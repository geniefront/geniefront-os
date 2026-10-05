import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {AppointmentDepositServiceDialog} from './AppointmentDepositServiceDialog';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import type {DepositAdjustmentQuote} from '@gf/contracts';
const state=vi.hoisted(()=>({online:true,allowed:true,run:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'owner-qa',isOnline:state.online,can:()=>state.allowed})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>()=> 'Request interrupted'}));
const serviceId='10000000-0000-4000-8000-000000000001',smallId='10000000-0000-4000-8000-000000000002',itemId='20000000-0000-4000-8000-000000000001';
const appointment={appointmentId:'30000000-0000-4000-8000-000000000001',status:'booked',items:[{itemId,serviceId,serviceName:'Original service',staffId:null,startsAt:'2030-01-02T16:00:00Z',durationMin:30,priceCents:10000,status:'booked'}],
 deposit:{holdId:'40000000-0000-4000-8000-000000000001',currency:'USD',status:'paid',amountCents:2000,availableCents:2000}} as AppointmentDetail;
const services=[{id:serviceId,name:'Original service',priceCents:10000,durationMin:30,staffCount:1,isAddon:false},{id:smallId,name:'Smaller service',priceCents:5000,durationMin:30,staffCount:1,isAddon:false}];
const quote:DepositAdjustmentQuote={quoteHash:'a'.repeat(64),currency:'USD',serviceTotalCents:5000,requiredCents:1000,availableCents:2000,requestCents:0,excessCents:1000,
 previousServiceTotalCents:10000,hasConfirmedBooking:true,expiresAt:null,purpose:'none'};
const reconfirm=()=>({status:400,code:'VALIDATION_FAILED',details:{reason:'deposit_quote_reconfirmation_required',notApplied:true,depositQuote:quote}});
const saved=vi.fn(async()=>{}),closed=vi.fn();
const show=(data=appointment,editable=true,open=true)=>render(<AppointmentDepositServiceDialog replace appointment={data} open={open} onClose={closed} onSaved={saved} services={services} staff={[]} editable={editable}/>);
afterEach(()=>{cleanup();sessionStorage.clear();state.run.mockReset();state.online=true;state.allowed=true;saved.mockClear();closed.mockClear();});

it('reviews the server quote, then replays the exact approved replacement after a lost result and reload with changed booking data',async()=>{
 state.run.mockRejectedValueOnce(reconfirm()).mockRejectedValueOnce(new Error('lost committed response')).mockResolvedValue({result:{appointmentId:appointment.appointmentId}});
 const user=userEvent.setup();show();await user.selectOptions(screen.getByLabelText('schedule.adServiceItem'),smallId);
 await user.click(screen.getByRole('button',{name:'Review deposit'}));await screen.findByRole('heading',{name:'Review updated deposit'});
 expect(saved).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Confirm updated deposit'})).toBeDisabled();
 await user.click(screen.getByRole('checkbox',{name:'The customer has agreed to the updated service price and deposit.'}));
 await user.click(screen.getByRole('button',{name:'Confirm updated deposit'}));await screen.findByText(/request may have completed/i);
 const originalInput=state.run.mock.calls[1]![1],originalKey=state.run.mock.calls[1]![3];
 expect(originalInput).toMatchObject({appointmentId:appointment.appointmentId,itemId,serviceId:smallId,depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}});
 cleanup();show({...appointment,items:[{...appointment.items[0]!,status:'cancelled'},{...appointment.items[0]!,itemId:'20000000-0000-4000-8000-000000000002',serviceId:smallId,serviceName:'Smaller service',priceCents:5000}]},false,false);
 await screen.findByRole('button',{name:'Retry saved request'});expect(screen.getByLabelText('schedule.adServiceItem')).toBeDisabled();
 await user.click(screen.getByRole('button',{name:'Retry saved request'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(state.run).toHaveBeenCalledTimes(3);expect(state.run.mock.calls[2]![1]).toEqual(originalInput);expect(state.run.mock.calls[2]![3]).toBe(originalKey);
});
it('can recover an interrupted quote preview only after the server proves the original key was not applied',async()=>{
 state.run.mockRejectedValueOnce(new Error('lost preview response')).mockRejectedValueOnce(reconfirm()).mockResolvedValue({result:{}});
 const user=userEvent.setup();show();await user.selectOptions(screen.getByLabelText('schedule.adServiceItem'),smallId);
 await user.click(screen.getByRole('button',{name:'Review deposit'}));await screen.findByRole('button',{name:'Retry saved request'});
 await user.click(screen.getByRole('button',{name:'Retry saved request'}));await screen.findByRole('heading',{name:'Review updated deposit'});
 expect(screen.queryByText(/request may have completed/i)).not.toBeInTheDocument();expect(state.run.mock.calls[0]![3]).toBe(state.run.mock.calls[1]![3]);
 expect(screen.getByRole('button',{name:'Confirm updated deposit'})).toBeDisabled();await user.click(screen.getByRole('checkbox'));
 await user.click(screen.getByRole('button',{name:'Confirm updated deposit'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(state.run.mock.calls[2]![3]).not.toBe(state.run.mock.calls[1]![3]);
});
it('preserves unknown parameters through denied retries and never sends while offline',async()=>{
 state.run.mockRejectedValueOnce(new Error('unknown result')).mockRejectedValue({status:403,code:'PERMISSION_DENIED'});
 const user=userEvent.setup();show();await user.selectOptions(screen.getByLabelText('schedule.adServiceItem'),smallId);await user.click(screen.getByRole('button',{name:'Review deposit'}));
 await screen.findByRole('button',{name:'Retry saved request'});await user.click(screen.getByRole('button',{name:'Retry saved request'}));await screen.findByRole('alert');
 expect(screen.getByText(/request may have completed/i)).toBeInTheDocument();expect(state.run.mock.calls[0]![3]).toBe(state.run.mock.calls[1]![3]);
 cleanup();state.online=false;show();expect(screen.getByRole('button',{name:'Retry saved request'})).toBeDisabled();expect(state.run).toHaveBeenCalledTimes(2);
});
