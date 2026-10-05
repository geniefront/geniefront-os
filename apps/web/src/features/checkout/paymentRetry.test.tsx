import {act,renderHook,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useCloseTicket,useCloseGroup} from './api';
import {runCommand,ApiError} from '@/lib/api';
const session=vi.hoisted(()=>({membershipId:'payment-owner',status:'ready',isOnline:true}));
vi.mock('@/lib/session',()=>({useSession:()=>session}));
vi.mock('@/lib/api',()=>({runCommand:vi.fn(),apiGet:vi.fn(),ApiError:class extends Error{constructor(readonly code:string,readonly details:Record<string,unknown>,readonly overridable:boolean,readonly status:number){super(code);}}}));
const input={ticketId:'11111111-2222-4222-8222-111111111111',discountCents:0,expectedQuoteHash:'a'.repeat(64),idempotencyKey:'original-payment-key',payments:[{method:'cash' as const,amountCents:5000,tipCents:0,changeCents:0,keepChange:false}]};
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return renderHook(useCloseTicket,{wrapper:({children})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});}
beforeEach(()=>{sessionStorage.clear();session.membershipId='payment-owner';vi.mocked(runCommand).mockReset();});afterEach(cleanup);
it('replays an unknown payment with the original quote and key after remount without requiring another quote',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({result:{ticketId:input.ticketId,totalCents:5000,allocations:[]},replayed:true});
 const first=mount();await act(async()=>{await expect(first.result.current.mutateAsync(input)).rejects.toThrow('response lost');});first.unmount();
 const second=mount();expect(second.result.current.pendingPayment).toEqual(input);
 await act(async()=>{await expect(second.result.current.mutateAsync({...input,expectedQuoteHash:'b'.repeat(64)})).rejects.toMatchObject({details:{reason:'checkout_result_unknown'}});});expect(runCommand).toHaveBeenCalledTimes(1);
 await act(async()=>{await second.result.current.mutateAsync(second.result.current.pendingPayment!);});
 expect(vi.mocked(runCommand).mock.calls[1]).toEqual(vi.mocked(runCommand).mock.calls[0]);expect(second.result.current.pendingPayment).toBeNull();expect(sessionStorage.getItem('gf-ticket-payment:payment-owner')).toBeNull();
});
it('retains an unknown payment through denied retries and isolates the active membership',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockRejectedValueOnce(new ApiError('PERMISSION_DENIED',{},false,403));
 const hook=mount();await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow('response lost');});
 await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toMatchObject({status:403});});expect(hook.result.current.pendingPayment).toEqual(input);
 session.membershipId='other-owner';hook.rerender();expect(hook.result.current.pendingPayment).toBeNull();expect(sessionStorage.getItem('gf-ticket-payment:payment-owner')).not.toBeNull();
});
it('releases a definitively rejected quote so the current price can be confirmed',async()=>{
 vi.mocked(runCommand).mockRejectedValue(new ApiError('VALIDATION_FAILED',{reason:'checkout_quote_changed'},false,400));
 const hook=mount();await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toMatchObject({details:{reason:'checkout_quote_changed'}});});expect(hook.result.current.pendingPayment).toBeNull();
});

it('shares the saved request between the queue and its embedded workbench',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({result:{ticketId:input.ticketId,totalCents:5000,allocations:[]},replayed:true});
 const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});
 const hook=renderHook(()=>({queue:useCloseTicket(),workbench:useCloseTicket()}),{wrapper:({children})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});
 await act(async()=>{await expect(hook.result.current.workbench.mutateAsync(input)).rejects.toThrow('response lost');});
 expect(hook.result.current.queue.pendingPayment).toEqual(input);
 await act(async()=>{await hook.result.current.queue.mutateAsync(hook.result.current.queue.pendingPayment!);});
 expect(hook.result.current.queue.pendingPayment).toBeNull();expect(hook.result.current.workbench.pendingPayment).toBeNull();
 expect(vi.mocked(runCommand).mock.calls[1]).toEqual(vi.mocked(runCommand).mock.calls[0]);
});

it('keeps a group settlement separate from another payment and replays all original ticket choices after remount',async()=>{
 const groupInput={groupId:'33333333-3333-4333-8333-333333333333',ticketIds:[input.ticketId],payments:input.payments,expectedQuoteHash:'b'.repeat(64),idempotencyKey:'saved-group'};
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({result:{groupId:groupInput.groupId,tickets:[{ticketId:input.ticketId,totalCents:5000,tipCents:0}],allocations:[]},replayed:true});
 const wrapper=({children}:React.PropsWithChildren)=><QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
 const first=renderHook(useCloseGroup,{wrapper});await act(async()=>{await expect(first.result.current.mutateAsync(groupInput)).rejects.toThrow('response lost');});first.unmount();
 const single=mount();expect(single.result.current.hasPendingSettlement).toBe(true);expect(single.result.current.pendingPayment).toBeNull();
 await act(async()=>{await expect(single.result.current.mutateAsync(input)).rejects.toMatchObject({details:{reason:'checkout_result_unknown'}});});expect(runCommand).toHaveBeenCalledTimes(1);
 const second=renderHook(useCloseGroup,{wrapper});expect(second.result.current.pendingGroupPayment).toEqual(groupInput);
 await act(async()=>{await second.result.current.mutateAsync(second.result.current.pendingGroupPayment!);});
 expect(vi.mocked(runCommand).mock.calls[1]).toEqual(vi.mocked(runCommand).mock.calls[0]);expect(single.result.current.hasPendingSettlement).toBe(false);
});
