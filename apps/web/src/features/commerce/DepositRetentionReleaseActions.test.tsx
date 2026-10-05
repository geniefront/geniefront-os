import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,within,cleanup,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DepositRetentionReleaseActions} from './DepositRetentionReleaseActions';
import type {AppointmentDetail} from '@/features/schedule/appointmentDetail';
const state=vi.hoisted(()=>({online:true,refund:true,run:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'release-owner',isOnline:state.online,can:(permission:string)=>permission!=='commerce.refund'||state.refund})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>()=> 'Request interrupted'}));
const deposit={holdId:'11111111-3333-4333-8333-111111111111',currency:'USD',retentions:[{id:'11111111-3333-4333-8333-222222222222',amountCents:800,remainingCents:800,reason:'Original retained decision',createdAt:'2026-10-01',releases:[]}]} as unknown as NonNullable<AppointmentDetail['deposit']>;
const success={result:{releaseId:'11111111-3333-4333-8333-333333333333',refundId:'11111111-3333-4333-8333-444444444444',status:'pending',amountCents:800}};
function show(d=deposit){return render(<QueryClientProvider client={new QueryClient()}><DepositRetentionReleaseActions deposit={d}/></QueryClientProvider>);}
afterEach(()=>{cleanup();sessionStorage.clear();state.run.mockReset();state.online=true;state.refund=true;});
async function fill(){const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Release retention and refund'}));const dialog=screen.getByRole('dialog');await user.type(within(dialog).getByLabelText('Amount to release'),'8');await user.type(within(dialog).getByLabelText('Reason for this change'),'Manager revised decision');return {user,dialog};}
it('keeps a lost release after remount and retries its exact original amount and key even when the retained balance is now zero',async()=>{
 state.run.mockRejectedValueOnce(new Error('lost')).mockResolvedValue(success);const first=show();const {user,dialog}=await fill();await user.click(within(dialog).getByRole('button',{name:'Release retention and refund'}));await screen.findByRole('alert');first.unmount();
 show({...deposit,retentions:deposit.retentions!.map(r=>({...r,remainingCents:0}))});const restored=await screen.findByRole('dialog');expect(within(restored).getByLabelText('Amount to release')).toHaveValue('8.00');
 await user.click(within(restored).getByRole('button',{name:'Retry saved release'}));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 expect(state.run).toHaveBeenCalledTimes(2);expect(state.run.mock.calls[1]).toEqual(state.run.mock.calls[0]);expect(sessionStorage.length).toBe(0);
});
it('requires refund permission, online access and an amount within the retained balance',async()=>{
 show();const {user,dialog}=await fill();await user.type(within(dialog).getByLabelText('Amount to release'),'.01');expect(within(dialog).getByRole('button',{name:'Release retention and refund'})).toBeDisabled();expect(state.run).not.toHaveBeenCalled();
 cleanup();state.refund=false;show();expect(screen.queryByRole('button',{name:'Release retention and refund'})).not.toBeInTheDocument();
 cleanup();state.refund=true;state.online=false;show();expect(screen.queryByRole('button',{name:'Release retention and refund'})).not.toBeInTheDocument();
});
it('retains an unknown saved request through a denied retry',async()=>{
 state.run.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce({code:'PERMISSION_DENIED',status:403});show();const {user,dialog}=await fill();await user.click(within(dialog).getByRole('button',{name:'Release retention and refund'}));await screen.findByRole('alert');
 await user.click(within(dialog).getByRole('button',{name:'Retry saved release'}));expect(sessionStorage.length).toBe(1);expect(state.run.mock.calls[1]).toEqual(state.run.mock.calls[0]);
});
