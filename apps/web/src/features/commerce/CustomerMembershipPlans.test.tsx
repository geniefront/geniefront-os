import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CustomerMembershipPlans} from './CustomerMembershipPlans';
const state=vi.hoisted(()=>({online:true,configure:true,read:true,get:vi.fn(),run:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-employee',isOnline:state.online,can:(p:string)=>p==='commerce.configure'?state.configure:state.read})}));
vi.mock('@/lib/api',()=>({apiGet:state.get,runCommand:state.run}));
const plan={id:'10000000-0000-4000-8000-000000000001',version_id:'10000000-0000-4000-8000-000000000002',version:2,active:true,online_sale:true,currency:'usd',
 terms:{name:{en:'Care plan'},amountCents:9900,cadence:'month',benefitFrequency:'month',quantity:1,serviceIds:['10000000-0000-4000-8000-000000000003'],discountBps:0,discountServiceIds:[],commissionBasis:'sale_price'}};
const data={plans:[plan],services:[{id:plan.terms.serviceIds[0],name:'Care service'}],members:[{id:'member',display_name:'QA member',provider_status:'active',paid_invoices:1,available_quantity:1,snapshot:{terms:plan.terms}}]};
const page=()=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CustomerMembershipPlans language="en"/></QueryClientProvider>);
beforeEach(()=>{state.online=true;state.configure=true;state.read=true;state.get.mockResolvedValue(data);state.run.mockResolvedValue({result:{}});});
afterEach(()=>{cleanup();state.get.mockReset();state.run.mockReset();});
it('saves a new version with the expected existing version and explicit recurring terms',async()=>{
 const user=userEvent.setup();page();await user.selectOptions(await screen.findByRole('combobox',{name:'Plan name'}),plan.id);
 const input=screen.getByRole('textbox',{name:'Recurring amount'});await user.clear(input);await user.type(input,'119');
 await user.click(screen.getByRole('button',{name:'Save plan version'}));
 await waitFor(()=>expect(state.run).toHaveBeenCalled());const call=state.run.mock.calls[0]!;
 expect(call[0]).toBe('commerce.saveMembershipPlan');expect(call[1]).toMatchObject({planId:plan.id,expectedVersion:2,terms:{amountCents:11900,cadence:'month',quantity:1}});
 expect(call[3]).toBeTruthy();
});
it('keeps offline access read-only and prevents staff without configure permission from editing plans',async()=>{
 state.online=false;page();expect(await screen.findByRole('button',{name:'Save plan version'})).toBeDisabled();expect(screen.getByText('Paid invoices: 1 · Available services: 1')).toBeInTheDocument();
 cleanup();state.configure=false;page();await screen.findByText(/QA member/);expect(screen.queryByRole('button',{name:'Save plan version'})).not.toBeInTheDocument();expect(state.run).not.toHaveBeenCalled();
});
it('does not query financial memberships for staff without commerce read permission',()=>{
 state.read=false;page();expect(state.get).not.toHaveBeenCalled();expect(screen.queryByText('Paid memberships')).not.toBeInTheDocument();
});
