import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MembershipAccess} from './MembershipAccess';
const state=vi.hoisted(()=>({online:true,allowed:true,get:vi.fn(),run:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'qa-manager',isOnline:state.online,can:()=>state.allowed})}));
vi.mock('@/lib/api',()=>({apiGet:state.get,runCommand:state.run}));
vi.mock('@/components/ui/Modal',()=>({Modal:({children,title,footer}:{children:React.ReactNode;title:string;footer:React.ReactNode})=><div role="dialog" aria-label={title}>{children}{footer}</div>}));
const id='11111111-2222-4222-8222-111111111111',review={id,name:'Annual member',email:'member@example.test',version:1,expires_at:'2028-03-02T00:00:00Z',revoked:false};
function page(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MembershipAccess id={id} language="en" onClose={()=>{}}/></QueryClientProvider>);}
beforeEach(()=>{sessionStorage.clear();state.online=true;state.allowed=true;state.get.mockResolvedValue(review);state.run.mockResolvedValue({result:{accessVersion:2,noticeQueued:true}});});
afterEach(()=>{cleanup();state.get.mockReset();state.run.mockReset();});
async function confirm(){const user=userEvent.setup();await user.type(await screen.findByLabelText('Reason'),'Verified original member email');await user.click(screen.getByRole('checkbox'));return user;}
it('submits the reviewed recipient and version with the authenticated operator and requires explicit confirmation',async()=>{
 page();await screen.findByText('Annual member');expect(screen.getByRole('button',{name:'Replace link and email customer'})).toBeDisabled();const user=await confirm();await user.click(screen.getByRole('button',{name:'Replace link and email customer'}));
 await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(1));expect(state.run.mock.calls[0]!.slice(0,3)).toEqual(['commerce.manageMembershipAccess',{membershipId:id,action:'reissue',expectedVersion:1,expectedEmail:'member@example.test',reason:'Verified original member email',confirmed:true},'qa-manager']);expect(state.run.mock.calls[0]![3]).toMatch(/^[a-f0-9-]{36}$/);
});
it('replays the exact unknown access request after remount even if the live email and version changed',async()=>{
 state.run.mockRejectedValueOnce(new Error('lost'));const first=page(),user=await confirm();await user.click(screen.getByRole('button',{name:'Replace link and email customer'}));await screen.findByText(/result is unknown/);const saved=state.run.mock.calls[0];first.unmount();
 state.get.mockResolvedValue({...review,email:'new@example.test',version:2});page();await screen.findByText('Annual member');expect(screen.getByText('Membership email: member@example.test')).toBeInTheDocument();expect(screen.getByRole('checkbox')).toBeChecked();await user.click(screen.getByRole('button',{name:'Retry saved access request'}));await waitFor(()=>expect(state.run).toHaveBeenCalledTimes(2));expect(state.run.mock.calls[1]).toEqual(saved);
});
it('keeps offline and unauthorized access read-only and invalidates consent after a stale review',async()=>{
 state.online=false;page();expect(await screen.findByLabelText('Reason')).toBeDisabled();cleanup();state.allowed=false;state.get.mockClear();page();expect(state.get).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();cleanup();
 state.online=true;state.allowed=true;state.run.mockRejectedValueOnce({code:'VALIDATION_FAILED'});page();const user=await confirm();state.get.mockResolvedValue({...review,version:2});await user.click(screen.getByRole('button',{name:'Replace link and email customer'}));await screen.findByText(/version or email changed/);expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:'Replace link and email customer'})).toBeDisabled();
});
