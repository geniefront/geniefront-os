import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MembershipTermination,type MembershipTerminationReview} from './MembershipTermination';
const state=vi.hoisted(()=>({online:true,refund:true,get:vi.fn(),run:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-manager',isOnline:state.online,can:()=>state.refund})}));
vi.mock('@/lib/api',()=>({apiGet:state.get,runCommand:state.run}));
vi.mock('@/components/ui/Modal',()=>({Modal:({children,title}:{children:React.ReactNode;title:string})=><div role="dialog" aria-label={title}>{children}</div>}));
const review:MembershipTerminationReview={reviewHash:'a'.repeat(64),membership:{id:'paid-member',name:'Annual care',currency:'usd',timezone:'America/Los_Angeles'},termination:null,
 summary:{paidCents:99900,refundedCents:0,reservedCents:0,currentAvailable:1,futurePlanned:11,usedServices:0},
 invoices:[{id:'original-invoice',amount_cents:99900,currency:'usd',paid_at:'2026-10-01T00:00:00Z',refundable:99900,keep_current_refundable:91575,held:0}],requests:[]};
function page(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MembershipTermination id="paid-member" language="en" onClose={()=>{}}/></QueryClientProvider>);}
beforeEach(()=>{sessionStorage.clear();state.online=true;state.refund=true;state.get.mockResolvedValue(review);state.run.mockResolvedValue({result:{}});});
afterEach(()=>{cleanup();state.get.mockReset();state.run.mockReset();});
async function fill(user:ReturnType<typeof userEvent.setup>,amount='500'){
 await user.type(await screen.findByLabelText('Refund amount 1'),amount);await user.type(screen.getByLabelText('Reason'),'Customer requested termination');await user.click(screen.getByRole('checkbox'));
}
it('submits a reviewed current-period decision and an explicit original invoice refund only after confirmation',async()=>{
 const user=userEvent.setup();page();await user.click(await screen.findByLabelText('Keep the current paid benefit period'));
 expect(screen.getByText('Maximum refundable: $915.75')).toBeInTheDocument();expect(screen.getByText('Value protected for the current paid period: $83.25')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'End membership and refund'})).toBeDisabled();await fill(user);await user.click(screen.getByRole('button',{name:'End membership and refund'}));
 await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(1));expect(state.run.mock.calls[0]!.slice(0,3)).toEqual(['commerce.terminateMembership',{
  membershipId:'paid-member',expectedReviewHash:review.reviewHash,unusedBenefits:'keep_current_paid',refunds:[{invoiceId:'original-invoice',amountCents:50000}],reason:'Customer requested termination',confirmed:true},'qa-manager']);
});
it('blocks refunds over the selected cap and keeps offline and unauthorized access read-only',async()=>{
 const user=userEvent.setup();page();await user.click(await screen.findByLabelText('Keep the current paid benefit period'));await fill(user,'915.76');
 expect(screen.getByRole('button',{name:'End membership and refund'})).toBeDisabled();expect(state.run).not.toHaveBeenCalled();
 cleanup();state.online=false;page();expect(await screen.findByLabelText('Refund amount 1')).toBeDisabled();expect(screen.getByRole('button',{name:'End membership and refund'})).toBeDisabled();
 cleanup();state.get.mockClear();state.refund=false;page();expect(state.get).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('preserves the exact request and key after an unknown response and remount',async()=>{
 const user=userEvent.setup();state.run.mockRejectedValueOnce(new Error('lost_response'));const view=page();await fill(user);await user.click(screen.getByRole('button',{name:'End membership and refund'}));
 await screen.findByText(/result is unknown/);const first=state.run.mock.calls[0]!;view.unmount();page();
 expect(await screen.findByLabelText('Refund amount 1')).toHaveValue('500');expect(screen.getByLabelText('Reason')).toBeDisabled();
 await user.click(screen.getByRole('button',{name:'End membership and refund'}));await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(2));expect(state.run.mock.calls[1]).toEqual(first);
 await waitFor(()=>expect(sessionStorage.getItem('gf-membership-termination:qa-manager:paid-member')).toBeNull());
});
it('requires confirmation again after the server rejects a stale review and fetches the new cap',async()=>{
 const user=userEvent.setup();page();await fill(user);state.run.mockRejectedValueOnce({status:422,details:{reason:'membership_termination_review_changed'}});
 state.get.mockResolvedValue({...review,reviewHash:'b'.repeat(64),invoices:[{...review.invoices[0]!,refundable:40000,keep_current_refundable:31675}]});
 await user.click(screen.getByRole('button',{name:'End membership and refund'}));await screen.findByText(/review changed/);
 expect(await screen.findByText('Maximum refundable: $400.00')).toBeInTheDocument();expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:'End membership and refund'})).toBeDisabled();
});
it('waits for provider cancellation before allowing more refunds and shows settled original invoice amounts',async()=>{
 state.get.mockResolvedValue({...review,termination:{id:'termination',status:'pending',unused_benefits:'revoke_all'}});page();
 expect(await screen.findByText(/Benefits are temporarily frozen/)).toBeInTheDocument();expect(screen.queryByLabelText('Refund amount 1')).not.toBeInTheDocument();
 cleanup();state.get.mockResolvedValue({...review,termination:{id:'termination',status:'complete',unused_benefits:'revoke_all'},summary:{...review.summary,refundedCents:50000},
  invoices:[{...review.invoices[0]!,refundable:49900}],requests:[{id:'refund',amount_cents:50000,status:'succeeded'}]});
 const user=userEvent.setup();page();await fill(user,'499');await user.click(screen.getByRole('button',{name:'Refund original membership invoices'}));
 await waitFor(()=>expect(state.run).toHaveBeenCalled());expect(state.run.mock.calls[0]![0]).toBe('commerce.refundMembership');expect(state.run.mock.calls[0]![1]).toMatchObject({terminationId:'termination',refunds:[{invoiceId:'original-invoice',amountCents:49900}]});
});
