import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
import {DepositRetentionActions} from './DepositRetentionActions';
const state=vi.hoisted(()=>({online:true,allowed:true,run:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-owner',isOnline:state.online,can:()=>state.allowed})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>()=> 'Request interrupted; retry'}));
const deposit={holdId:'11111111-3333-4333-8333-111111111111',status:'review',financialStatus:'review',amountCents:2000,availableCents:2000,currency:'USD',expiresAt:'2030-01-01T00:00:00Z',
  waivable:false,waivedAt:null,waiverReason:null,retentionQuote:{enabled:true,reason:null,policyVersion:'original-policy',guests:[{guestIndex:0,availableCents:1176}],policy:{cancelCutoffHours:48,notice:'Original accepted cancellation terms'}}} as NonNullable<AppointmentDetail['deposit']>;
const show=(d=deposit)=>render(<QueryClientProvider client={new QueryClient()}><DepositRetentionActions deposit={d}/></QueryClientProvider>);
afterEach(()=>{cleanup();state.online=true;state.allowed=true;state.run.mockReset();sessionStorage.clear();});
it('requires an explicit amount and reason and preserves the selected guest quote on interrupted retries',async()=>{
  state.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({result:{retentionId:'qa-retention'}});
  const user=userEvent.setup();show();await user.click(screen.getByRole('button',{name:'Record deposit retention'}));
  const dialog=screen.getByRole('dialog'),submit=within(dialog).getByRole('button',{name:'Record deposit retention'});
  expect(submit).toBeDisabled();expect(within(dialog).getByText('Maximum eligible amount: $11.76')).toBeInTheDocument();
  expect(within(dialog).getByText('Cancel at least 48 hours before the appointment to refund the unused deposit.')).toBeInTheDocument();
  expect(within(dialog).getByText('Original accepted cancellation terms')).toBeInTheDocument();
  await user.type(within(dialog).getByLabelText('Amount to retain'),'8');expect(submit).toBeDisabled();
  await user.type(within(dialog).getByLabelText('Reason for retention'),'Manager reviewed original terms');await user.click(submit);
  await screen.findByRole('alert');await user.click(submit);expect(state.run).toHaveBeenCalledTimes(2);
  expect(state.run.mock.calls[0]?.[1]).toEqual({holdId:'11111111-3333-4333-8333-111111111111',guestIndices:[0],expectedGuestBalances:[{guestIndex:0,availableCents:1176}],amountCents:800,reason:'Manager reviewed original terms'});
  expect(state.run.mock.calls[0]?.[3]).toBe(state.run.mock.calls[1]?.[3]);
});
it('prevents exceeding the selected eligible share, removing all guests or acting offline',async()=>{
  const user=userEvent.setup();show();await user.click(screen.getByRole('button',{name:'Record deposit retention'}));
  const dialog=screen.getByRole('dialog'),submit=within(dialog).getByRole('button',{name:'Record deposit retention'});
  await user.type(within(dialog).getByLabelText('Amount to retain'),'12');await user.type(within(dialog).getByLabelText('Reason for retention'),'Reviewed');
  expect(submit).toBeDisabled();await user.clear(within(dialog).getByLabelText('Amount to retain'));await user.type(within(dialog).getByLabelText('Amount to retain'),'8');
  await user.click(within(dialog).getByRole('checkbox'));expect(submit).toBeDisabled();expect(state.run).not.toHaveBeenCalled();
  cleanup();state.online=false;show();expect(screen.getByRole('button',{name:'Record deposit retention'})).toBeDisabled();
});
it('shows a recorded retention as history and removes the write action without an eligible quote or permission',()=>{
  show({...deposit,retainedCents:800,retentions:[{id:'retention',amountCents:800,remainingCents:800,releases:[],reason:'Original policy reviewed',createdAt:'2026-10-01'}],retentionQuote:{...deposit.retentionQuote!,enabled:false}});
  expect(screen.getByText('Deposit retained: $8.00')).toBeInTheDocument();expect(screen.getByText('$8.00 · Original policy reviewed')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Record deposit retention'})).not.toBeInTheDocument();
  cleanup();state.allowed=false;show();expect(screen.queryByRole('button',{name:'Record deposit retention'})).not.toBeInTheDocument();
});

it('retries the original saved decision after the refreshed balance changes',async()=>{
  state.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({result:{retentionId:'saved'}});
  const user=userEvent.setup(),view=show();await user.click(screen.getByRole('button',{name:'Record deposit retention'}));
  const dialog=screen.getByRole('dialog');await user.type(within(dialog).getByLabelText('Amount to retain'),'8');
  await user.type(within(dialog).getByLabelText('Reason for retention'),'Original decision');
  await user.click(within(dialog).getByRole('button',{name:'Record deposit retention'}));await screen.findByRole('alert');
  view.rerender(<QueryClientProvider client={new QueryClient()}><DepositRetentionActions deposit={{...deposit,retainedCents:800,retentionQuote:{...deposit.retentionQuote!,enabled:false,guests:[]}}}/></QueryClientProvider>);
  expect(within(dialog).getByLabelText('Amount to retain')).toBeDisabled();
  await user.click(within(dialog).getByRole('button',{name:'Retry previous decision'}));
  expect(state.run.mock.calls[1]?.[1]).toEqual(state.run.mock.calls[0]?.[1]);
  expect(state.run.mock.calls[1]?.[3]).toBe(state.run.mock.calls[0]?.[3]);
});
it('restores an unresolved decision on remount with its original input and key',async()=>{
  state.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({result:{retentionId:'saved'}});
  const user=userEvent.setup();show();await user.click(screen.getByRole('button',{name:'Record deposit retention'}));
  let dialog=screen.getByRole('dialog');await user.type(within(dialog).getByLabelText('Amount to retain'),'8');
  await user.type(within(dialog).getByLabelText('Reason for retention'),'Original remounted decision');
  await user.click(within(dialog).getByRole('button',{name:'Record deposit retention'}));await screen.findByRole('alert');
  cleanup();show({...deposit,retainedCents:800,retentionQuote:{...deposit.retentionQuote!,enabled:false,guests:[]}});
  dialog=await screen.findByRole('dialog');expect(within(dialog).getByLabelText('Reason for retention')).toHaveValue('Original remounted decision');
  await user.click(within(dialog).getByRole('button',{name:'Retry previous decision'}));
  expect(state.run).toHaveBeenCalledTimes(2);expect(state.run.mock.calls[1]?.[1]).toEqual(state.run.mock.calls[0]?.[1]);
  expect(state.run.mock.calls[1]?.[3]).toBe(state.run.mock.calls[0]?.[3]);
});
