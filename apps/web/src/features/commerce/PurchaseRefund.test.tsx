import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {PurchaseRefund} from './PurchaseRefund';
const state=vi.hoisted(()=>({online:true,allowed:true,run:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-desk',isOnline:state.online,can:()=>state.allowed})}));
vi.mock('@/lib/api',()=>({runCommand:state.run}));
const order={payment_id:'11111111-2222-4222-8222-111111111111',name:'Unlimited care',amount_cents:50000,currency:'usd',refunded_cents:0,unlimited_package:true};
const onClose=vi.fn(),onSaved=vi.fn(async()=>{});
function page(selected:typeof order|null=order){return render(<PurchaseRefund selected={selected} language="en" onClose={onClose} onSaved={onSaved}/>);}
beforeEach(()=>{sessionStorage.clear();state.online=true;state.allowed=true;state.run.mockReset().mockResolvedValue({result:{refundId:'r'}});onClose.mockClear();onSaved.mockClear();});
afterEach(cleanup);
async function fill(){const user=userEvent.setup();await user.type(screen.getByLabelText('Amount'),'200');await user.type(screen.getByLabelText('Reason'),'Manual refund of remaining validity');return user;}
it('requires explicit termination consent for an unlimited manual refund',async()=>{
 page();const user=await fill();expect(screen.getByRole('button',{name:'Refund purchase'})).toBeDisabled();await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Refund purchase'}));
 await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(1));expect(state.run.mock.calls[0]!.slice(0,3)).toEqual(['commerce.requestRefund',{paymentId:order.payment_id,amountCents:20000,reason:'Manual refund of remaining validity',unlimitedTerminationConfirmed:true},'qa-desk']);
});
it('recovers an unknown refund across reload without a selected order and replays the original request once',async()=>{
 state.run.mockRejectedValueOnce(new Error('lost'));const first=page(),user=await fill();await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Refund purchase'}));await screen.findByRole('alert');const original=state.run.mock.calls[0];first.unmount();
 page(null);expect(screen.getByLabelText('Amount')).toHaveValue('200');expect(screen.getByLabelText('Amount')).toBeDisabled();expect(screen.getByRole('checkbox')).toBeChecked();await user.click(screen.getByRole('button',{name:/Retry saved refund request/}));await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(2));expect(state.run.mock.calls[1]).toEqual(original);
});
it('keeps unknown requests through denied retry and disables offline or unauthorized actions',async()=>{
 state.run.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce({code:'PERMISSION_DENIED'});page();const user=await fill();await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Refund purchase'}));await screen.findByRole('alert');await user.click(screen.getByRole('button',{name:/Retry saved refund request/}));expect(sessionStorage.getItem('gf-commerce-purchase-refund:qa-desk')).not.toBeNull();
 cleanup();state.online=false;page(null);expect(screen.getByRole('button',{name:/Retry saved refund request/})).toBeDisabled();cleanup();state.allowed=false;page();expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('does not require unlimited termination consent for finite packages or gift purchases',async()=>{
 page({...order,unlimited_package:false});const user=await fill();expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Refund purchase'}));await waitFor(()=>expect(state.run).toHaveBeenCalled());expect(state.run.mock.calls[0]![1]).not.toHaveProperty('unlimitedTerminationConfirmed');
});
