import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {StaffTimeOff} from './StaffTimeOff';
const {runCommand}=vi.hoisted(()=>({runCommand:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'actor'})}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(k:string)=>k})}));
vi.mock('@/lib/api',()=>({runCommand,apiGet:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({data:{timeOff:{}},isPending:false}),useQueryClient:()=>({invalidateQueries:vi.fn().mockResolvedValue(undefined)})}));
it('retries the same leave with the same id and idempotency key after a network failure',async()=>{
 runCommand.mockRejectedValueOnce(new Error('network')).mockResolvedValue({saved:true});
 const {container}=render(<StaffTimeOff id="staff"/>);
 const dates=container.querySelectorAll('input[type=date]');
 fireEvent.change(dates[0]!,{target:{value:'2026-10-01'}});fireEvent.change(dates[1]!,{target:{value:'2026-10-05'}});
 fireEvent.click(screen.getByRole('button',{name:'Schedule time off'}));
 await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'Schedule time off'}));
 await waitFor(()=>expect(runCommand).toHaveBeenCalledTimes(2));
 expect(runCommand.mock.calls[1]).toEqual(runCommand.mock.calls[0]);
});
