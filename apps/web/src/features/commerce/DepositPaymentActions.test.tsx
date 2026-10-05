import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DepositPaymentActions} from './DepositPaymentActions';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
const state=vi.hoisted(()=>({online:true,allowed:true,run:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-owner',isOnline:state.online,can:()=>state.allowed})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>()=> 'Request interrupted; retry'}));
const deposit={holdId:'55555555-5555-4555-8555-555555555555',status:'pending',financialStatus:'pending',amountCents:2000,availableCents:0,currency:'USD',expiresAt:'2030-01-01T00:00:00Z',
  waivable:true,waivedAt:null,waiverReason:null,recordable:true,onlineCheckoutAvailable:true,checkoutUrl:null,emailAvailable:true} as NonNullable<AppointmentDetail['deposit']>;
const show=(d=deposit)=>render(<QueryClientProvider client={new QueryClient()}><DepositPaymentActions deposit={d}/></QueryClientProvider>);
afterEach(()=>{cleanup();sessionStorage.clear();state.online=true;state.allowed=true;state.run.mockReset();});
it('records the exact held deposit only after receiving a reference and preserves its idempotency key after an interrupted response',async()=>{
  state.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({result:{paymentId:'qa-payment'}});
  const user=userEvent.setup();show();await user.click(screen.getByRole('button',{name:'Record deposit received'}));
  const dialog=screen.getByRole('dialog'),submit=within(dialog).getByRole('button',{name:'Record deposit received'});
  expect(submit).toBeDisabled();expect(within(dialog).getByText('Deposit to pay: $20.00')).toBeInTheDocument();
  await user.type(within(dialog).getByRole('textbox'),'QA cash receipt 003');await user.click(submit);await screen.findByRole('alert');await user.click(submit);
  expect(state.run).toHaveBeenCalledTimes(2);expect(state.run.mock.calls[0]?.[1]).toEqual({holdId:'55555555-5555-4555-8555-555555555555',amountCents:2000,method:'cash',reference:'QA cash receipt 003'});
  expect(state.run.mock.calls[0]?.[3]).toBe(state.run.mock.calls[1]?.[3]);
});
it('keeps an existing Stripe attempt out of the cash entry and sends instructions with an explicit reason',async()=>{
  state.run.mockResolvedValue({result:{queued:true}});const user=userEvent.setup();show({...deposit,recordable:false});
  expect(screen.queryByRole('button',{name:'Record deposit received'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Email deposit instructions'}));
  const dialog=screen.getByRole('dialog'),submit=within(dialog).getByRole('button',{name:'Email deposit instructions'});expect(submit).toBeDisabled();
  await user.type(within(dialog).getByRole('textbox'),'Caller requested payment instructions');await user.click(submit);
  expect(state.run).toHaveBeenCalledWith('commerce.sendDepositNotice',{holdId:'55555555-5555-4555-8555-555555555555',reason:'Caller requested payment instructions'},'qa-owner',expect.any(String));
});
it('keeps payment actions read-only offline and prevents sending instructions without an email',()=>{
  state.online=false;show();expect(screen.getByRole('button',{name:'Record deposit received'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Prepare payment link'})).toBeDisabled();expect(screen.getByRole('button',{name:'Email deposit instructions'})).toBeDisabled();
  cleanup();state.online=true;show({...deposit,emailAvailable:false});expect(screen.getByRole('button',{name:'Email deposit instructions'})).toBeDisabled();
  expect(screen.getByText('Add the customer email before sending deposit instructions.')).toBeInTheDocument();expect(state.run).not.toHaveBeenCalled();
});
