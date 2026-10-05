import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {commerceText} from '@gf/contracts';
import {CommercePayouts,type PayoutData} from './CommercePayouts';
const state=vi.hoisted(()=>({online:true,read:true,report:true,configure:true,get:vi.fn(),run:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-owner',isOnline:state.online,context:{timezone:'America/Los_Angeles'},can:(p:string)=>p==='report.view'?state.report:p==='commerce.configure'?state.configure:state.read})}));
vi.mock('@/lib/api',()=>({apiGet:state.get,runCommand:state.run}));
const data:PayoutData={payouts:[{id:'payout',amount_cents:1000,currency:'usd',automatic:false,livemode:false,provider_created_at:'2026-10-02T00:00:00Z',business_date:'2026-10-01',status:'paid',arrival_at:'2026-10-05T00:00:00Z',failure_code:null,source_count:null,source_net_cents:null,debit_net_cents:-1000,returned_net_cents:0,debit_verified:true,return_verified:false}],sources:[]};
function page(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CommercePayouts language="en"/></QueryClientProvider>);}
beforeEach(()=>{state.online=true;state.read=true;state.report=true;state.configure=true;state.get.mockResolvedValue(data);state.run.mockResolvedValue({result:{queued:true}});});
afterEach(()=>{cleanup();state.get.mockReset();state.run.mockReset();});
it('shows account withdrawal without claiming bank receipt or assigning manual payment sources',async()=>{
 page();await screen.findByText('$10.00 · Manual payout');expect(screen.getByText('Verified account debit: -$10.00')).toBeInTheDocument();
 expect(screen.getByText(/Confirm bank receipt separately/)).toBeInTheDocument();expect(screen.getByText(/does not assign individual payment sources/)).toBeInTheDocument();
 expect(screen.getByText('Expected arrival date: Oct 5, 2026')).toBeInTheDocument();
});
it('keeps a failed payout and its confirmed return visible while an incomplete automatic batch stays pending',async()=>{
 state.get.mockResolvedValue({...data,payouts:[{...data.payouts[0]!,automatic:true,status:'failed',returned_net_cents:1000,return_verified:true}]});page();
 await screen.findByText('Payout failed · Test mode');expect(screen.getByText('Verified return to account balance: $10.00')).toBeInTheDocument();expect(screen.getByText('Source batch reconciliation pending')).toBeInTheDocument();
});
it('queues an idempotent discovery retry and keeps offline access read-only',async()=>{
 const user=userEvent.setup();state.run.mockRejectedValueOnce(new Error('network'));page();await user.click(await screen.findByRole('button',{name:'Refresh payouts'}));await screen.findByText(commerceText('en','error'));
 await user.click(screen.getByRole('button',{name:'Refresh payouts'}));await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(2));expect(state.run.mock.calls[0]).toEqual(state.run.mock.calls[1]);
 cleanup();state.online=false;page();expect(await screen.findByRole('button',{name:'Refresh payouts'})).toBeDisabled();
});
it('requires both financial read permissions and does not query account payouts for an unauthorized staff member',()=>{
 state.report=false;page();expect(state.get).not.toHaveBeenCalled();expect(screen.queryByText('Account payouts')).not.toBeInTheDocument();
});
