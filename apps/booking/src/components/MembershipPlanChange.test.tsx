import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MembershipPlanChange} from './MembershipPlanChange';
import {commerceApi} from '../lib/commerceApi';
vi.mock('../lib/commerceApi',()=>({commerceApi:vi.fn()}));
vi.mock('../lib/i18n',()=>({useLanguage:()=>({locale:'en'})}));
const memberId='11111111-2222-4222-8222-111111111111',versionId='11111111-2222-4222-8222-222222222222',token=`cm_${'x'.repeat(43)}`;
const plan={versionId,currency:'usd',terms:{name:{en:'Next care'},amountCents:14900,cadence:'month' as const,benefitFrequency:'month' as const,quantity:2,serviceIds:[],discountBps:0,discountServiceIds:[],commissionBasis:'sale_price' as const}};
const props={slug:'qa',memberId,periodEnd:'2026-11-01T07:00:00Z',timezone:'America/Los_Angeles',plans:[plan],services:[],changes:[],allowed:true,onSaved:vi.fn()};
afterEach(()=>{cleanup();sessionStorage.clear();vi.mocked(commerceApi).mockReset();vi.restoreAllMocks();});
function show(over:Partial<typeof props>={}){sessionStorage.setItem(`gf-membership:qa:${memberId}`,token);return render(<MembershipPlanChange {...props} {...over}/>);}
async function select(){const user=userEvent.setup();await user.selectOptions(screen.getByLabelText('New plan'),versionId);return user;}
it('requires the displayed future date, recurring price and explicit consent, then invalidates consent if that date changes',async()=>{
 const page=show(),user=await select();expect(screen.getByRole('button',{name:'Confirm next-period plan'})).toBeDisabled();expect(screen.getByText(/No immediate charge/)).toBeInTheDocument();
 await user.click(screen.getByRole('checkbox'));expect(screen.getByRole('button',{name:'Confirm next-period plan'})).toBeEnabled();
 page.rerender(<MembershipPlanChange {...props} periodEnd="2026-12-01T07:00:00Z"/>);expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:'Confirm next-period plan'})).toBeDisabled();
});
it('recovers an unknown request after remount with the same consent and business key even if the live period and pending status changed',async()=>{
 vi.mocked(commerceApi).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({changeId:'change',status:'scheduled',replayed:true});
 const first=show(),user=await select();await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Confirm next-period plan'}));await screen.findByRole('alert');first.unmount();
 show({allowed:false,periodEnd:'2026-12-01T07:00:00Z'});expect(screen.queryByLabelText('New plan')).not.toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Retry saved plan change'}));
 await waitFor(()=>expect(props.onSaved).toHaveBeenCalled());const calls=vi.mocked(commerceApi).mock.calls;expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
 expect(calls[0]![2]).toMatchObject({token,body:{versionId,expectedPeriodEnd:'2026-11-01T07:00:00.000Z',consent:{accepted:true,versionId,amountCents:14900,cadence:'month',effectiveAt:'2026-11-01T07:00:00.000Z'}}});
});
it('keeps an unknown result through denied retries and prevents sending while offline',async()=>{
 vi.mocked(commerceApi).mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce({status:403,code:'PERMISSION_DENIED'});show();const user=await select();await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Confirm next-period plan'}));await screen.findByRole('alert');
 await user.click(screen.getByRole('button',{name:'Retry saved plan change'}));expect(sessionStorage.getItem(`gf-membership-change:qa:${memberId}`)).not.toBeNull();
 cleanup();vi.spyOn(navigator,'onLine','get').mockReturnValue(false);show();expect(screen.getByRole('button',{name:'Retry saved plan change'})).toBeDisabled();
});
