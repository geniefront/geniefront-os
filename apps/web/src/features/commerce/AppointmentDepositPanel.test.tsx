import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AppointmentDepositPanel} from './AppointmentDepositPanel';
const state=vi.hoisted(()=>({online:true,allowed:true,run:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-owner',isOnline:state.online,can:()=>state.allowed})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>()=> 'Request interrupted; retry'}));
const deposit={holdId:'qa-hold',status:'pending',financialStatus:'pending',amountCents:2000,availableCents:0,currency:'USD',
  expiresAt:new Date(Date.now()+900000).toISOString(),waivable:true,waivedAt:null,waiverReason:null};
function show(){return render(<QueryClientProvider client={new QueryClient()}><AppointmentDepositPanel deposit={deposit}/></QueryClientProvider>);}
afterEach(()=>{cleanup();state.run.mockReset();state.online=true;state.allowed=true;});
it('keeps the financial decision hidden without waiver permission and disabled while offline',()=>{
  state.allowed=false;const view=show();expect(screen.queryByRole('button',{name:'Approve deposit waiver'})).toBeNull();
  state.allowed=true;state.online=false;view.rerender(<QueryClientProvider client={new QueryClient()}><AppointmentDepositPanel deposit={deposit}/></QueryClientProvider>);
  expect(screen.getByRole('button',{name:'Approve deposit waiver'})).toBeDisabled();expect(state.run).not.toHaveBeenCalled();
});
it('requires a reason and reuses the same command key after an interrupted approval',async()=>{
  const user=userEvent.setup();state.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({result:{status:'waived'}});
  show();await user.click(screen.getByRole('button',{name:'Approve deposit waiver'}));
  const dialog=screen.getByRole('dialog');const approval=within(dialog).getByRole('button',{name:'Approve deposit waiver'});
  expect(approval).toBeDisabled();
  await user.type(within(dialog).getByLabelText('Reason for waiver'),'  Returning QA guest  ');
  await user.click(approval);expect(await screen.findByRole('alert')).toHaveTextContent('Request interrupted; retry');
  await user.click(approval);
  expect(state.run).toHaveBeenCalledTimes(2);
  expect(state.run.mock.calls[0]?.slice(0,3)).toEqual(['commerce.waiveAppointmentDeposit',{holdId:'qa-hold',reason:'Returning QA guest'},'qa-owner']);
  expect(state.run.mock.calls[0]?.[3]).toBe(state.run.mock.calls[1]?.[3]);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('shows the actual retained amount in the header after the available deposit reaches zero',()=>{
  render(<QueryClientProvider client={new QueryClient()}><AppointmentDepositPanel deposit={{...deposit,status:'retained',financialStatus:'retained',waivable:false,availableCents:0,retainedCents:800}}/></QueryClientProvider>);
  const panel=screen.getByRole('region',{name:'Deposit retained'});
  expect(within(panel).getByText('$8.00')).toBeInTheDocument();expect(within(panel).queryByText('$0.00')).not.toBeInTheDocument();
});
