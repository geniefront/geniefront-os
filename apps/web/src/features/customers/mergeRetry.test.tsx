import {act,renderHook,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useMergeCustomers} from './api';
import {runCommand,ApiError} from '@/lib/api';
const session=vi.hoisted(()=>({membershipId:'merge-owner'}));
vi.mock('@/lib/session',()=>({useSession:()=>session}));
vi.mock('@/lib/api',()=>({apiGet:vi.fn(),runCommand:vi.fn(),ApiError:class extends Error{constructor(readonly code:string,readonly details:Record<string,unknown>,readonly overridable:boolean,readonly status:number){super(code);}}}));
const input={sourceCustomerId:'11111111-1111-4111-8111-111111111111',targetCustomerId:'22222222-2222-4222-8222-222222222222'};
function mount(){return renderHook(useMergeCustomers,{wrapper:({children})=><QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}>{children}</QueryClientProvider>});}
beforeEach(()=>{sessionStorage.clear();session.membershipId='merge-owner';vi.mocked(runCommand).mockReset();});afterEach(cleanup);
it('recovers the exact source/target selection and original key after an unknown result and remount',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({result:input,replayed:true});
 const first=mount();await act(async()=>{await expect(first.result.current.mutateAsync(input)).rejects.toThrow('response lost');});first.unmount();
 const second=mount();expect(second.result.current.pendingMerge).toEqual(input);
 await act(async()=>{await expect(second.result.current.mutateAsync({...input,targetCustomerId:'33333333-3333-4333-8333-333333333333'})).rejects.toMatchObject({details:{reason:'customer_merge_result_unknown'}});});expect(runCommand).toHaveBeenCalledTimes(1);
 await act(async()=>{await second.result.current.mutateAsync(second.result.current.pendingMerge!);});expect(vi.mocked(runCommand).mock.calls[1]).toEqual(vi.mocked(runCommand).mock.calls[0]);expect(second.result.current.pendingMerge).toBeNull();
});
it('keeps an unknown merge through denied retries and separates staff sessions',async()=>{
 vi.mocked(runCommand).mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new ApiError('PERMISSION_DENIED',{},false,403));
 const hook=mount();await act(async()=>{await hook.result.current.mutateAsync(input).catch(()=>{});});await act(async()=>{await hook.result.current.mutateAsync(input).catch(()=>{});});expect(hook.result.current.pendingMerge).toEqual(input);
 session.membershipId='other-owner';hook.rerender();expect(hook.result.current.pendingMerge).toBeNull();expect(sessionStorage.getItem('gf-customer-merge:merge-owner')).not.toBeNull();
});
it('does not discard a pending merge when the response identifies different profiles',async()=>{
 vi.mocked(runCommand).mockResolvedValue({result:{...input,targetCustomerId:input.sourceCustomerId},replayed:false});const hook=mount();
 await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow('CUSTOMER_MERGE_RESPONSE_MISMATCH');});expect(hook.result.current.pendingMerge).toEqual(input);
});
