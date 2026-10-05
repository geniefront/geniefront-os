import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MembershipChangeWithdrawal} from './MembershipChangeWithdrawal';
import {commerceApi} from '../lib/commerceApi';
vi.mock('../lib/commerceApi',()=>({commerceApi:vi.fn()}));
vi.mock('../lib/i18n',()=>({useLanguage:()=>({locale:'en'})}));
const memberId='11111111-2222-4222-8222-111111111111',changeId='11111111-2222-4222-8222-222222222222',token=`cm_${'x'.repeat(43)}`;
const props={slug:'qa',memberId,change:{id:changeId,status:'scheduled'},onSaved:vi.fn()};
afterEach(()=>{cleanup();sessionStorage.clear();vi.mocked(commerceApi).mockReset();vi.restoreAllMocks();});
function show(status='scheduled'){sessionStorage.setItem(`gf-membership:qa:${memberId}`,token);return render(<MembershipChangeWithdrawal {...props} change={{...props.change,status}}/>);}
it('requires confirmation to keep current renewal and restores a lost withdrawal after reload even when already withdrawn',async()=>{
 vi.mocked(commerceApi).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({changeId,status:'withdrawn',replayed:true});const first=show(),user=userEvent.setup();
 expect(screen.getByRole('button',{name:'Withdraw this plan change'})).toBeDisabled();await user.click(screen.getByRole('checkbox',{name:/Keep my current plan/}));await user.click(screen.getByRole('button',{name:'Withdraw this plan change'}));await screen.findByRole('alert');first.unmount();
 show('withdrawn');await user.click(screen.getByRole('button',{name:'Retry saved withdrawal'}));await waitFor(()=>expect(props.onSaved).toHaveBeenCalled());expect(vi.mocked(commerceApi).mock.calls[1]).toEqual(vi.mocked(commerceApi).mock.calls[0]);
 expect(sessionStorage.getItem(`gf-membership-withdraw:qa:${memberId}:${changeId}`)).toBeNull();
});
it('retains unknown requests through authorization failures and never submits offline',async()=>{
 vi.mocked(commerceApi).mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce({status:403,code:'PERMISSION_DENIED'});show();const user=userEvent.setup();await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Withdraw this plan change'}));await screen.findByRole('alert');
 await user.click(screen.getByRole('button',{name:'Retry saved withdrawal'}));expect(sessionStorage.getItem(`gf-membership-withdraw:qa:${memberId}:${changeId}`)).not.toBeNull();
 cleanup();vi.spyOn(navigator,'onLine','get').mockReturnValue(false);show();expect(screen.getByRole('button',{name:'Retry saved withdrawal'})).toBeDisabled();
});
it('hides new withdrawal controls for an applied plan',()=>{show('applied');expect(screen.queryByRole('button')).not.toBeInTheDocument();});
