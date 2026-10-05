import {beforeEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,waitFor,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {LanguageProvider} from '../lib/i18n';
import {MembershipsPage} from './MembershipsPage';
const {call}=vi.hoisted(()=>({call:vi.fn()}));vi.mock('../lib/commerceApi',()=>({commerceApi:call}));
const memberId='10000000-0000-4000-8000-000000000002';
const plan={id:'10000000-0000-4000-8000-000000000001',versionId:'10000000-0000-4000-8000-000000000003',name:'Monthly care',currency:'usd',
 terms:{name:{en:'Monthly care'},amountCents:9900,cadence:'month',benefitFrequency:'month',quantity:1,serviceIds:[],discountBps:0,discountServiceIds:[],commissionBasis:'sale_price'}};
const catalog={shopName:'Commerce QA',available:true,currency:'usd',timezone:'America/Los_Angeles',plans:[plan]};
const status={membership:{id:memberId,provider_status:'active',cancel_at_period_end:false,current_period_end:'2026-11-01T00:00:00Z',commerce_frozen:false,terminated_at:null,
 snapshot:{terms:plan.terms,currency:'usd',timezone:'America/Los_Angeles'}},timezone:'America/Los_Angeles',checkoutUrl:null,cycles:[],invoices:[]};
function page(path='/golden-foot/memberships'){return render(<LanguageProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="/:slug/memberships" element={<MembershipsPage/>}/></Routes></MemoryRouter></LanguageProvider>);}
beforeEach(()=>{cleanup();sessionStorage.clear();localStorage.clear();localStorage.setItem('booking_locale','en');window.history.replaceState(null,'','/');call.mockReset();
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.includes(`/memberships/${memberId}`)?status:catalog));});
it('requires explicit renewal consent and displays recurring fee and non-rollover terms',async()=>{
 const user=userEvent.setup();page();await user.click(await screen.findByRole('button',{name:'Monthly'}));
 expect(screen.getByRole('button',{name:'Continue to payment'})).toBeDisabled();expect(screen.getByText(/Unused services expire/)).toBeInTheDocument();
 await user.type(screen.getByLabelText('Customer name'),'QA member');await user.type(screen.getByLabelText('Email'),'member@example.test');
 await user.click(screen.getByRole('checkbox'));expect(screen.getByRole('button',{name:'Continue to payment'})).toBeEnabled();
 expect(call.mock.calls.filter(c=>c[2]?.body)).toHaveLength(0);
});
it('shows the purchased discount and services on private status even after the current catalog price benefit changes',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.includes(`/memberships/${memberId}`)?{
  ...status,membership:{...status.membership,snapshot:{...status.membership.snapshot,terms:{...plan.terms,discountBps:1000,discountServiceIds:['member-service']}}}
 }:{...catalog,plans:[{...plan,terms:{...plan.terms,discountBps:5000}}],services:[{id:'member-service',name:'Purchased eligible massage'}]}));
 page(`/golden-foot/memberships?member=${memberId}`);
 expect(await screen.findByText('Member discount (%): 10%')).toBeInTheDocument();
 expect(await screen.findByText('Discounted services: Purchased eligible massage')).toBeInTheDocument();
 expect(screen.queryByText(/50%/)).not.toBeInTheDocument();
});
it('keeps the original consent, plan and purchase key across a lost response and remount',async()=>{
 const user=userEvent.setup();let fail=true;call.mockImplementation((_slug:string,path:string)=>{
  if(path==='/memberships'){if(fail){fail=false;return Promise.reject(new Error('network'));}return Promise.resolve({membershipId:memberId,orderId:memberId,token:`cm_${'x'.repeat(43)}`,url:null});}
  return Promise.resolve(path.startsWith('/memberships?')?catalog:status);
 });
 const view=page();await user.click(await screen.findByRole('button',{name:'Monthly'}));await user.type(screen.getByLabelText('Customer name'),'QA member');
 await user.type(screen.getByLabelText('Email'),'member@example.test');await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Continue to payment'}));
 await screen.findByRole('alert');view.unmount();page();expect(await screen.findByDisplayValue('QA member')).toHaveAttribute('readonly');
 await user.click(screen.getByRole('button',{name:'Continue to payment'}));await screen.findByRole('heading',{name:'Payment pending'});
 const posts=call.mock.calls.filter(c=>c[2]?.body);expect(posts).toHaveLength(2);expect(posts[0][2].body).toEqual(posts[1][2].body);
 expect(sessionStorage.getItem('gf-membership-attempt:golden-foot')).toBeNull();
});
it('does not call a subscription active before a confirmed paid invoice, and scopes private access',async()=>{
 page(`/golden-foot/memberships?member=${memberId}`);await screen.findByRole('alert');expect(call.mock.calls.some(c=>String(c[1]).includes(`/memberships/${memberId}`))).toBe(false);
 cleanup();sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);page(`/golden-foot/memberships?member=${memberId}`);
 expect(await screen.findByRole('heading',{name:'Payment pending'})).toBeInTheDocument();expect(screen.queryByRole('heading',{name:'Active'})).not.toBeInTheDocument();
});
it('shows paid benefits independently of overdue renewal and renders simplified Chinese in store timezone',async()=>{
 localStorage.setItem('booking_locale','zh-Hans');sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/memberships?')?catalog:{...status,membership:{...status.membership,provider_status:'past_due'},
  cycles:[{id:'cycle',starts_at:'2026-10-01T00:00:00Z',ends_at:'2026-11-01T00:00:00Z',quantity:1,available_quantity:1,status:'issued'}],
  invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z'}]}));
 page(`/golden-foot/memberships?member=${memberId}`);expect(await screen.findByRole('heading',{name:'付款逾期'})).toBeInTheDocument();
 expect(screen.getByText('可用次数: 1')).toBeInTheDocument();expect(screen.getByText(/未用次数/)).toBeInTheDocument();
 await waitFor(()=>expect(screen.getAllByText(/2026年9月30日/)).toHaveLength(2));
});
it('opens management only using this private membership token and does not replace paid status when opening fails',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 call.mockImplementation((_slug:string,path:string)=>path.endsWith('/portal')?Promise.reject(new Error('network')):Promise.resolve(path.startsWith('/memberships?')?catalog:{...status,portalAvailable:true,
  invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z'}]}));
 page(`/golden-foot/memberships?member=${memberId}`);await userEvent.setup().click(await screen.findByRole('button',{name:'Payment method, invoices and renewal'}));
 await screen.findByRole('alert');expect(screen.getByRole('heading',{name:'Active'})).toBeInTheDocument();
 const request=call.mock.calls.find(c=>c[1]===`/memberships/${memberId}/portal`)!;expect(request[2]).toMatchObject({token:`cm_${'x'.repeat(43)}`,body:{locale:'en'}});
 expect(Object.keys(request[2].body).sort()).toEqual(['businessKey','locale']);
});
it('shows paid expiry instead of another charge when cancellation is scheduled, and signals disconnected accounts',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/memberships?')?catalog:{...status,accountDisconnected:true,portalAvailable:false,
  membership:{...status.membership,cancel_at_period_end:true},invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z'}]}));
 page(`/golden-foot/memberships?member=${memberId}`);await screen.findByText('Renewal canceled at period end');expect(screen.queryByText(/Next billing period:/)).not.toBeInTheDocument();
 expect(screen.getByText(/store payment account needs attention/)).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Payment method, invoices and renewal'})).not.toBeInTheDocument();
});
it('shows protected membership consumption and restoration without treating a restoration as a cash payment',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/memberships?')?catalog:{...status,
  invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z'}],ledger:[
   {id:'use',entry:'redeem',quantity:-1,created_at:'2026-10-01T00:00:00Z'},
   {id:'return',entry:'restore',quantity:1,created_at:'2026-10-01T01:00:00Z'}]}));
 page(`/golden-foot/memberships?member=${memberId}`);await screen.findByRole('heading',{name:'Benefit history'});
 expect(screen.getByText(/Service used/)).toHaveTextContent('-1');expect(screen.getByText(/Service restored/)).toHaveTextContent('+1');
 expect(screen.getByRole('heading',{name:'Paid invoices: 1'})).toBeInTheDocument();
});
it('shows termination and original invoice refunds without suggesting another charge or an active discount',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/memberships?')?catalog:{...status,portalAvailable:true,benefitsActive:false,
  termination:{status:'complete',unused_benefits:'revoke_all'},membership:{...status.membership,provider_status:'canceled',terminated_at:'2026-10-02T00:00:00Z',snapshot:{...status.membership.snapshot,terms:{...plan.terms,discountBps:1000}}},
  invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z',refunded_cents:5000,pending_refund_cents:0}],
  ledger:[{id:'stop',entry:'stop',quantity:0,planned_quantity:11,created_at:'2026-10-02T00:00:00Z'},{id:'revoke',entry:'revoke',quantity:-1,created_at:'2026-10-02T00:00:00Z'}]}));
 page(`/golden-foot/memberships?member=${memberId}`);await screen.findByRole('heading',{name:'Subscription ended'});
 expect(screen.queryByText(/Next billing period:/)).not.toBeInTheDocument();expect(screen.getByText('Refunded: $50.00')).toBeInTheDocument();
 expect(screen.getByText(/purchased benefits are no longer available/)).toBeInTheDocument();expect(screen.getByText(/Future benefit period stopped/)).toHaveTextContent('11');
 expect(screen.getByText(/Unused services revoked/)).toHaveTextContent('-1');expect(screen.getByRole('button',{name:'View invoices'})).toBeInTheDocument();
});

it('labels funded periods and invoices with their own purchased contract',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);
 const snapshot={...status.membership.snapshot,terms:{...plan.terms,name:{en:'Original funded care'}}};
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/memberships?')?catalog:{...status,
  cycles:[{id:'cycle',starts_at:'2026-10-01T07:00:00Z',ends_at:'2026-11-01T07:00:00Z',quantity:1,available_quantity:1,status:'issued',snapshot}],
  invoices:[{id:'invoice',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T07:00:00Z',period_start:'2026-10-01T07:00:00Z',period_end:'2026-11-01T07:00:00Z',snapshot}]}));
 page(`/golden-foot/memberships?member=${memberId}`);expect(await screen.findAllByText('Original funded care')).toHaveLength(2);
 expect(screen.getByText(/Available services: 1 \/ 1/)).toBeInTheDocument();
});

it('recovers a failed protected read with the existing token instead of requiring a new purchase or browser reload',async()=>{
 sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);let reads=0;
 call.mockImplementation((_slug:string,path:string)=>path.includes(`/memberships/${memberId}`)?(++reads===1?Promise.reject(new Error('Temporary read failure')):Promise.resolve(status)):Promise.resolve(catalog));
 page(`/golden-foot/memberships?member=${memberId}`);await screen.findByRole('alert');await userEvent.setup().click(screen.getByRole('button',{name:'Refresh'}));
 await screen.findByText('Available services: 0');expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(reads).toBe(2);
 const attempts=call.mock.calls.filter(c=>c[1]===`/memberships/${memberId}`);expect(attempts.every(c=>c[2].token===`cm_${'x'.repeat(43)}`&&c[2].body===undefined)).toBe(true);
});

it('clears previously loaded membership details when its private credential is revoked and explains how to recover access',async()=>{
 vi.useFakeTimers();
 try{
  sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,`cm_${'x'.repeat(43)}`);let denied=false;
  call.mockImplementation((_slug:string,path:string)=>path.startsWith('/memberships?')?Promise.resolve(catalog):denied?Promise.reject({status:404}):Promise.resolve({...status,portalAvailable:true,invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z'}]}));
  await act(async()=>{page(`/golden-foot/memberships?member=${memberId}`);});expect(screen.getByRole('heading',{name:'Active'})).toBeInTheDocument();
  denied=true;await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});
  expect(screen.queryByRole('heading',{name:'Active'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Payment method, invoices and renewal'})).not.toBeInTheDocument();expect(screen.getByRole('alert')).toHaveTextContent('Contact the shop to verify your identity');
 }finally{cleanup();vi.useRealTimers();}
});

it('accepts a replacement private link in the same open browser without a full page reload',async()=>{
 const old=`cm_${'x'.repeat(43)}`,next=`cm_${'y'.repeat(43)}`;sessionStorage.setItem(`gf-membership:golden-foot:${memberId}`,old);
 call.mockImplementation((_slug:string,path:string,options?:{token?:string})=>path.startsWith('/memberships?')?Promise.resolve(catalog):options?.token===next?Promise.resolve({...status,invoices:[{id:'bill',amount_cents:9900,currency:'usd',paid_at:'2026-10-01T00:00:00Z'}]}):Promise.reject({status:404}));
 page(`/golden-foot/memberships?member=${memberId}`);expect(await screen.findByRole('alert')).toHaveTextContent('Contact the shop');
 await act(async()=>{window.history.replaceState(null,'',`/#m/${next}`);window.dispatchEvent(new HashChangeEvent('hashchange'));});
 expect(await screen.findByRole('heading',{name:'Active'})).toBeInTheDocument();expect(sessionStorage.getItem(`gf-membership:golden-foot:${memberId}`)).toBe(next);expect(window.location.hash).toBe('');
});
