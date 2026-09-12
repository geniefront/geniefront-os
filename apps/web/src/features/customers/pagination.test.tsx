import { renderHook,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { expect,it,vi } from 'vitest';
import { useCustomerList } from './api';
import { apiGet } from '@/lib/api';
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'member',status:'ready'})}));
vi.mock('@/lib/api',()=>({apiGet:vi.fn(),runCommand:vi.fn()}));
it('#19 sends the selected segment and page to the server and preserves server totals',async()=>{
 const metrics={total:501,vipCount:225,active30:200,sleep30:301,sleep90:180};
 vi.mocked(apiGet).mockResolvedValue({rows:[],total:225,metrics});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const {result,rerender}=renderHook(({offset})=>useCustomerList({filterType:'vip',limit:100,offset}),{
  initialProps:{offset:0},wrapper:({children})=><QueryClientProvider client={client}>{children}</QueryClientProvider>,
 });
 await waitFor(()=>expect(result.current.isSuccess).toBe(true));
 expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toContain('filterType=vip');
 rerender({offset:200});
 await waitFor(()=>expect(vi.mocked(apiGet).mock.calls.at(-1)?.[0]).toContain('offset=200'));
 expect(result.current.data?.total).toBe(225);expect(result.current.data?.metrics).toEqual(metrics);
 client.clear();
});
