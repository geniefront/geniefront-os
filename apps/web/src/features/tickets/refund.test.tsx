import {act,renderHook,waitFor,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useRefundTicket,useTicketRefundReview} from './api';
import {runCommand,ApiError} from '@/lib/api';
const session=vi.hoisted(()=>({membershipId:'refund-owner',status:'ready',isOnline:true}));
vi.mock('@/lib/session',()=>({useSession:()=>session}));
vi.mock('@/lib/api',()=>({runCommand:vi.fn(),apiGet:vi.fn(),ApiError:class extends Error{constructor(readonly code:string,readonly details:Record<string,unknown>,readonly overridable:boolean,readonly status:number){super(code);}}}));
const input={ticketId:'11111111-2222-4222-8222-111111111111',amountCents:4000,refundTipCents:0,method:'original_payment' as const,reason:'other' as const,reviewHash:'a'.repeat(64)};
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return renderHook(()=>useRefundTicket(),{wrapper:({children})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});}
beforeEach(()=>{sessionStorage.clear();session.isOnline=true;vi.mocked(runCommand).mockReset();});afterEach(cleanup);
it('replays a committed refund with the original preview and key after a page remount and refuses a changed intent',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({result:{ticketId:input.ticketId,status:'closed'},replayed:true});
 const first=mount();await act(async()=>{await expect(first.result.current.mutateAsync(input)).rejects.toThrow('response lost');});
 const key=vi.mocked(runCommand).mock.calls[0]![3];expect(key).toBeTruthy();expect(first.result.current.pendingRefund).toEqual(input);first.unmount();
 const second=mount();expect(second.result.current.pendingRefund).toEqual(input);
 await act(async()=>{await expect(second.result.current.mutateAsync({...input,amountCents:6000})).rejects.toMatchObject({details:{reason:'refund_result_unknown'}});});expect(runCommand).toHaveBeenCalledTimes(1);
 await act(async()=>{await second.result.current.mutateAsync(second.result.current.pendingRefund!);});
 expect(vi.mocked(runCommand).mock.calls[1]![3]).toBe(key);expect(vi.mocked(runCommand).mock.calls[1]![1]).toEqual(vi.mocked(runCommand).mock.calls[0]![1]);
 expect(second.result.current.pendingRefund).toBeNull();expect(sessionStorage.getItem('gf-service-refund:refund-owner')).toBeNull();
});
it('clears a server-rejected stale review so the current destinations can be reviewed again',async()=>{
 vi.mocked(runCommand).mockRejectedValue(new ApiError('VALIDATION_FAILED',{reason:'refund_review_changed'},false,400));
 const hook=mount();await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toMatchObject({details:{reason:'refund_review_changed'}});});expect(hook.result.current.pendingRefund).toBeNull();
});
it('retains an unknown committed request when a later retry is denied before idempotency lookup',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockRejectedValueOnce(new ApiError('PERMISSION_DENIED',{},false,403));
 const hook=mount();await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow('response lost');});
 await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toMatchObject({status:403});});
 expect(hook.result.current.pendingRefund).toEqual(input);expect(vi.mocked(runCommand).mock.calls[0]![3]).toBe(vi.mocked(runCommand).mock.calls[1]![3]);
});
it('loads server destinations for the requested amount and prevents offline review calls',async()=>{
 vi.mocked(runCommand).mockResolvedValue({result:{reviewHash:input.reviewHash,amountCents:4000,tipCents:0,taxCents:0,feeCents:0,destinations:[{kind:'package',amountCents:4000}]},replayed:false});
 const client=new QueryClient(),wrapper=({children}:React.PropsWithChildren)=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 const hook=renderHook(()=>useTicketRefundReview(input),{wrapper});await waitFor(()=>expect(hook.result.current.data?.destinations).toEqual([{kind:'package',amountCents:4000}]));
 expect(runCommand).toHaveBeenCalledWith('ticket.reviewRefund',{ticketId:input.ticketId,refundAmountCents:4000,refundTipCents:0,refundMethod:'original_payment'},'refund-owner');
 cleanup();vi.mocked(runCommand).mockClear();session.isOnline=false;renderHook(()=>useTicketRefundReview({...input,amountCents:6000}),{wrapper});expect(runCommand).not.toHaveBeenCalled();
});
it('preserves selected execution items and their immutable preview through an unknown result and remount',async()=>{
 const selected={...input,refundItems:[{ticketItemId:'11111111-3333-4333-8333-111111111111',amountCents:4000}]};
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({result:{ticketId:input.ticketId,status:'closed'},replayed:true});
 const first=mount();await act(async()=>{await expect(first.result.current.mutateAsync(selected)).rejects.toThrow('response lost');});first.unmount();
 const second=mount();await act(async()=>{await second.result.current.mutateAsync(second.result.current.pendingRefund!);});
 expect(vi.mocked(runCommand).mock.calls[0]![1]).toMatchObject({refundItems:selected.refundItems,reviewHash:input.reviewHash});
 expect(vi.mocked(runCommand).mock.calls[1]![1]).toEqual(vi.mocked(runCommand).mock.calls[0]![1]);expect(vi.mocked(runCommand).mock.calls[1]![3]).toBe(vi.mocked(runCommand).mock.calls[0]![3]);
});
