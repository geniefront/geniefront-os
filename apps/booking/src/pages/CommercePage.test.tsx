import {act,render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {beforeEach,it,expect,vi} from 'vitest';
import {LanguageProvider} from '../lib/i18n';
import {CommercePage} from './CommercePage';
const {call,tokens}=vi.hoisted(()=>({call:vi.fn(),tokens:new Map<string,string>()}));
vi.mock('../lib/commerceApi',()=>({commerceApi:call,
  savePurchaseAccess:(_slug:string,id:string,token:string)=>tokens.set(id,token),loadPurchaseAccess:(_slug:string,id:string)=>tokens.get(id)??null}));
const catalog={shopName:'Commerce QA',currency:'USD',available:true,gifts:[{id:'10000000-0000-4000-8000-000000000001',name:'Gift card',priceCents:8000,faceValueCents:10000}],packages:[]};
const orderId='10000000-0000-4000-8000-000000000002';
const pending={order:{id:orderId,status:'pending',kind:'gift_card',amount_cents:8000,currency:'usd'},paymentStatus:'pending',checkoutUrl:null,asset:null};
function page(path='/golden-foot/shop'){render(<LanguageProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="/:slug/shop" element={<CommercePage/>}/></Routes></MemoryRouter></LanguageProvider>);}
beforeEach(()=>{cleanup();tokens.clear();localStorage.clear();sessionStorage.clear();localStorage.setItem('booking_locale','en');window.history.replaceState(null,'','/');call.mockReset();
  call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/orders/')?pending:catalog));});
it('shows price separately from gift face value and disables purchasing for an unavailable account',async()=>{
  call.mockResolvedValue({...catalog,available:false});page();
  expect(await screen.findByText('$80.00')).toBeInTheDocument();expect(screen.getByText(/Gift card value: \$100.00/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Buy'})).toBeDisabled();
});
it('keeps one purchase key through a failed POST and displays pending after a retry, without claiming completion',async()=>{
  let fail=true;
  call.mockImplementation((_slug:string,path:string)=>{
    if(path==='/orders'){if(fail){fail=false;return Promise.reject(new Error('network'));}return Promise.resolve({orderId,token:'t'.repeat(43),url:null});}
    return Promise.resolve(path.startsWith('/orders/')?pending:catalog);
  });
  const user=userEvent.setup();page();await user.click(await screen.findByRole('button',{name:'Buy'}));
  await user.type(screen.getByLabelText('Customer name'),'Commerce QA');await user.type(screen.getByLabelText('Email'),'commerce@example.test');
  await user.click(screen.getByRole('button',{name:'Buy · $80.00'}));await screen.findByRole('alert');
  await user.click(screen.getByRole('button',{name:'Buy · $80.00'}));await screen.findByRole('heading',{name:'Awaiting payment'});
  const posts=call.mock.calls.filter(c=>c[1]==='/orders');expect(posts).toHaveLength(2);expect(posts[0][2].body.businessKey).toBe(posts[1][2].body.businessKey);
  expect(screen.queryByText('Purchase completed')).not.toBeInTheDocument();
});
it('requires private access before querying any purchase by ID',async()=>{
  page(`/golden-foot/shop?order=${orderId}&checkout=returned`);await screen.findByText(/private purchase link/);
  expect(call.mock.calls.filter(c=>String(c[1]).startsWith('/orders/'))).toHaveLength(0);
  expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument();
  expect(screen.queryByText('Processing')).not.toBeInTheDocument();
  await userEvent.setup().selectOptions(screen.getByRole('combobox',{name:'Language'}),'zh-Hans');
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('专属购买链接'));
  expect(screen.queryByText('等待付款')).not.toBeInTheDocument();
  expect(screen.queryByText('处理中')).not.toBeInTheDocument();
});
it('does not treat a paid-but-unfulfilled order as completed',async()=>{
  tokens.set(orderId,'t'.repeat(43));call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/orders/')?{...pending,order:{...pending.order,status:'paid'},paymentStatus:'paid'}:catalog));
  page(`/golden-foot/shop?order=${orderId}`);await screen.findByRole('heading',{name:'Processing'});expect(screen.queryByText('Purchase completed')).not.toBeInTheDocument();
});
it('shows the confirmed partial refund and remaining sessions without claiming a fresh completed purchase',async()=>{
 tokens.set(orderId,'t'.repeat(43));call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/orders/')?
  {order:{...pending.order,status:'fulfilled',kind:'package',amount_cents:50000},paymentStatus:'paid',refundedCents:45000,pendingRefundCents:0,asset:{status:'void',total_sessions:10,remaining_sessions:0}}:catalog));
 page(`/golden-foot/shop?order=${orderId}`);await screen.findByRole('heading',{name:'Partially refunded'});expect(screen.getByText('Refunded: $450.00')).toBeInTheDocument();expect(screen.getByText('0 sessions')).toBeInTheDocument();expect(screen.queryByText('Purchase completed')).not.toBeInTheDocument();
});
it('recovers the protected purchase status after a temporary server failure',async()=>{
 tokens.set(orderId,'t'.repeat(43));let failed=false;call.mockImplementation((_slug:string,path:string)=>{
  if(path.startsWith('/orders/')){if(!failed){failed=true;return Promise.reject({status:503});}return Promise.resolve({...pending,order:{...pending.order,status:'fulfilled'},paymentStatus:'paid'});}
  return Promise.resolve(catalog);
 });
 vi.useFakeTimers();try{
  await act(async()=>{page(`/golden-foot/shop?order=${orderId}`);});expect(screen.getByRole('alert')).toBeInTheDocument();expect(screen.queryByText('Purchase completed')).not.toBeInTheDocument();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(screen.getByRole('heading',{name:'Purchase completed'})).toBeInTheDocument();expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 }finally{cleanup();vi.useRealTimers();}
});
it('renders Traditional Chinese commerce copy without missing keys',async()=>{
  localStorage.setItem('booking_locale','zh-Hant');page();expect(await screen.findByRole('heading',{name:'禮品卡 & 次卡'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'購買'})).toBeInTheDocument();
});
it('shows a review state instead of purchase completion when the funded asset is frozen',async()=>{
  tokens.set(orderId,'t'.repeat(43));call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/orders/')?
    {...pending,order:{...pending.order,status:'review'},paymentStatus:'disputed',asset:{status:'review',balance_cents:0}}:catalog));
  page(`/golden-foot/shop?order=${orderId}`);await screen.findByRole('heading',{name:'Under review. Contact the store for assistance.'});
  expect(screen.queryByText('Purchase completed')).not.toBeInTheDocument();
});
it('shows the purchased service, validity and visit rule and submits the server quote',async()=>{
 const product={id:orderId,name:'Ten care visits',priceCents:50000,sessions:10,validDays:365,serviceNames:['Foot care'],coverageMode:'any_included',scope:'location',quoteHash:'a'.repeat(64)};
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path==='/orders'?{orderId,token:'t'.repeat(43),url:null}:path.startsWith('/orders/')?pending:{...catalog,gifts:[],packages:[product]}));
 const user=userEvent.setup();page();await user.click(await screen.findByRole('button',{name:'Buy'}));
 expect(screen.getAllByText('Valid for 365 days after payment')).toHaveLength(2);expect(screen.getAllByText('Included services: Foot care')).toHaveLength(2);
 await user.type(screen.getByLabelText('Customer name'),'Package QA');await user.type(screen.getByLabelText('Email'),'package@example.test');await user.click(screen.getByRole('button',{name:'Buy · $500.00'}));
 await waitFor(()=>expect(call.mock.calls.some(c=>c[1]==='/orders')).toBe(true));expect(call.mock.calls.find(c=>c[1]==='/orders')![2].body.expectedQuoteHash).toBe(product.quoteHash);
});
it('preserves the original request and key after a lost response and remount, even when the catalog changes',async()=>{
 const user=userEvent.setup();let fail=true;call.mockImplementation((_slug:string,path:string)=>{
  if(path==='/orders'){if(fail){fail=false;return Promise.reject(new Error('lost_response'));}return Promise.resolve({orderId,token:'t'.repeat(43),url:null});}
  return Promise.resolve(path.startsWith('/orders/')?pending:catalog);
 });
 page();await user.click(await screen.findByRole('button',{name:'Buy'}));await user.type(screen.getByLabelText('Customer name'),'Original buyer');await user.type(screen.getByLabelText('Email'),'original@example.test');await user.click(screen.getByRole('button',{name:'Buy · $80.00'}));await screen.findByRole('alert');
 cleanup();page();expect(await screen.findByDisplayValue('Original buyer')).toHaveAttribute('readonly');await user.click(screen.getByRole('button',{name:'Buy · $80.00'}));await screen.findByRole('heading',{name:'Awaiting payment'});
 const posts=call.mock.calls.filter(c=>c[1]==='/orders');expect(posts).toHaveLength(2);expect(posts[0][2].body).toEqual(posts[1][2].body);expect(sessionStorage.getItem('gf-commerce-attempt:golden-foot')).toBeNull();
});
it('refreshes changed purchase terms for review before allowing another request',async()=>{
 let changed=false;const product={id:orderId,name:'Ten visits',priceCents:50000,sessions:10,validDays:365,scope:'location',coverageMode:'any_included',serviceNames:['Foot care'],quoteHash:'a'.repeat(64)};
 call.mockImplementation((_slug:string,path:string)=>{
  if(path==='/orders'){changed=true;return Promise.reject({status:422,details:{reason:'commerce_purchase_quote_changed'}});}
  return Promise.resolve({...catalog,gifts:[],packages:[changed?{...product,priceCents:60000,sessions:12,quoteHash:'b'.repeat(64)}:product]});
 });
 const user=userEvent.setup();page();await user.click(await screen.findByRole('button',{name:'Buy'}));await user.type(screen.getByLabelText('Customer name'),'Original buyer');await user.type(screen.getByLabelText('Email'),'original@example.test');await user.click(screen.getByRole('button',{name:'Buy · $500.00'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('The product price or terms changed');expect(await screen.findByText('$600.00')).toBeInTheDocument();expect(screen.getByText('12 sessions')).toBeInTheDocument();
 expect(sessionStorage.getItem('gf-commerce-attempt:golden-foot')).toBeNull();expect(screen.queryByRole('button',{name:'Buy · $500.00'})).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Buy'}));expect(screen.getByLabelText('Customer name')).toHaveValue('Original buyer');expect(screen.getByRole('button',{name:'Buy · $600.00'})).toBeEnabled();expect(call.mock.calls.filter(c=>c[1]==='/orders')).toHaveLength(1);
});

it('shows the availability and store-time expiry of unlimited rights instead of implying refunded or expired rights are usable',async()=>{
 tokens.set(orderId,'u'.repeat(43));
 const asset={total_sessions:0,remaining_sessions:0,status:'void',can_redeem:false,expires_at:'2026-10-04T01:00:00Z'};
 call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/orders/')?{...pending,timezone:'America/Los_Angeles',order:{...pending.order,kind:'package',status:'refunded'},paymentStatus:'refunded',refundedCents:50000,asset}:catalog));
 page(`/golden-foot/shop?order=${orderId}`);expect(await screen.findByText('This package cannot be used.')).toBeInTheDocument();expect(screen.queryByText('Unlimited')).not.toBeInTheDocument();expect(screen.getByText(/Expires: Oct 3, 2026/)).toBeInTheDocument();
 cleanup();call.mockImplementation((_slug:string,path:string)=>Promise.resolve(path.startsWith('/orders/')?{...pending,order:{...pending.order,kind:'package',status:'fulfilled'},paymentStatus:'paid',asset:{...asset,status:'active',can_redeem:true}}:catalog));page(`/golden-foot/shop?order=${orderId}`);expect(await screen.findByText('Unlimited')).toBeInTheDocument();
});
