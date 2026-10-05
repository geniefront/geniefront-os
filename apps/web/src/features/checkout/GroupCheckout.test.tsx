import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {GroupCheckoutEntry} from './GroupCheckout';
import {runCommand} from '@/lib/api';
const state=vi.hoisted(()=>({close:vi.fn(),lastInput:null as any,groupId:'33333333-3333-4333-8333-333333333333',ids:['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en',t:(key:string)=>key})}));
vi.mock('@/lib/permissions',()=>({useCanWrite:()=>true,useWriteBlockReason:()=>()=>null}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'owner',status:'ready',isOnline:true})}));
vi.mock('@/lib/api',()=>({runCommand:vi.fn(),apiGet:vi.fn(),ApiError:class extends Error{}}));
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),
 useOpenTickets:()=>({data:{tickets:state.ids.map((id,i)=>({ticketId:id,customerName:`Guest ${i+1}`,subtotalCents:(i+1)*10000,groupId:null,checkoutTiming:'after_service_combined',serviceSettledAt:null,tipSettledAt:null,serviceCompleted:true}))}}),
 useCloseGroup:()=>({mutateAsync:state.close,isPending:false,hasPendingSettlement:false,pendingGroupPayment:null}),
 useGroupQuote:(input:any)=>{state.lastInput=input;const stored=(input?.ticketSelections??[]).reduce((n:number,s:any)=>n+(s.storedValuePayments??[]).reduce((m:number,p:any)=>m+p.amountCents,0),0),tip=input?.tipCents??0,due=30000-stored+tip;
  return {isFetching:false,error:null,refetch:vi.fn(),data:input?{quoteHash:'c'.repeat(64),amountDueCents:due,readyToPay:input.payments.reduce((n:number,p:any)=>n+p.amountCents,0)===due,tickets:state.ids.map(id=>({ticketId:id,totalCents:15000,tipCents:0}))}:undefined};},
}));
beforeEach(()=>{state.close.mockReset().mockResolvedValue({groupId:state.groupId,tickets:state.ids.map(ticketId=>({ticketId,totalCents:15000,tipCents:0})),allocations:[]});vi.mocked(runCommand).mockReset().mockResolvedValue({result:{groupId:state.groupId},replayed:false});state.lastInput=null;});afterEach(cleanup);
function mount(){return render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><GroupCheckoutEntry renderSelection={(id,_initial,save)=><button onClick={()=>save({ticketId:id,tipCents:1000,tipSplits:[{staffMembershipId:'55555555-5555-4555-8555-555555555555',amountCents:900},{staffMembershipId:'66666666-6666-4666-8666-666666666666',amountCents:100}],storedValuePayments:[{method:'gift_card',giftCardId:'44444444-4444-4444-8444-444444444444',amountCents:3000}]},{quoteHash:'x'} as any)}>Save fixture selection</button>}/></MemoryRouter></QueryClientProvider>);}
async function prepare(){fireEvent.click(screen.getByRole('button',{name:'Group checkout'}));fireEvent.click(await screen.findByRole('checkbox',{name:/Guest 1/}));fireEvent.click(screen.getByRole('checkbox',{name:/Guest 2/}));fireEvent.click(screen.getByRole('button',{name:'Review group checkout'}));await screen.findByRole('button',{name:'Confirm group payment'});}
it('confirms the server group amount and preserves per-ticket benefit choices in one command',async()=>{
 mount();await prepare();fireEvent.click(screen.getAllByRole('button',{name:'Choose benefits and tips'})[0]!);fireEvent.click(screen.getByRole('button',{name:'Save fixture selection'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Confirm group payment'})).not.toBeDisabled());
 fireEvent.click(screen.getByRole('button',{name:'Confirm group payment'}));await waitFor(()=>expect(state.close).toHaveBeenCalled());
 const sent=state.close.mock.calls[0]![0];expect(sent).toMatchObject({groupId:state.groupId,expectedQuoteHash:'c'.repeat(64),payments:[{method:'card',amountCents:28000,tipCents:1000}]});expect(sent.ticketSelections[0]).toMatchObject({ticketId:state.ids[0],tipCents:1000,storedValuePayments:[{amountCents:3000}]});
 expect(await screen.findAllByRole('link',{name:/View receipt/})).toHaveLength(2);expect(runCommand).toHaveBeenCalledTimes(1);
});
it('blocks a mismatched split and accepts only the balanced group draft',async()=>{
 mount();await prepare();await waitFor(()=>expect(screen.getByRole('button',{name:'Confirm group payment'})).not.toBeDisabled());
 fireEvent.click(screen.getByRole('button',{name:'Add payment channel'}));fireEvent.change(screen.getByRole('spinbutton',{name:'Amount including tip 1'}),{target:{value:'200'}});
 expect(screen.getByRole('button',{name:'Confirm group payment'})).toBeDisabled();fireEvent.change(screen.getByRole('spinbutton',{name:'Amount including tip 2'}),{target:{value:'100'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Confirm group payment'})).not.toBeDisabled());expect(state.close).not.toHaveBeenCalled();
});

it('retains cash change once and preserves the paying guest’s chosen staff proportions',async()=>{
 mount();await prepare();fireEvent.click(screen.getAllByRole('button',{name:'Choose benefits and tips'})[0]!);fireEvent.click(screen.getByRole('button',{name:'Save fixture selection'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Confirm group payment'})).not.toBeDisabled());
 fireEvent.change(screen.getByRole('combobox',{name:'Group payment channels 1'}),{target:{value:'cash'}});
 fireEvent.change(screen.getByRole('spinbutton',{name:'Cash tendered 1'}),{target:{value:'300'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Keep change as tip for the paying guest'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Confirm group payment'})).not.toBeDisabled());
 fireEvent.click(screen.getByRole('button',{name:'Confirm group payment'}));await waitFor(()=>expect(state.close).toHaveBeenCalled());
 const input=state.close.mock.calls[0]![0];expect(input.payments).toEqual([expect.objectContaining({method:'cash',amountCents:30000,tipCents:3000,tenderedCents:30000,changeCents:0,keepChange:true})]);
 expect(input.ticketSelections[0]).toMatchObject({tipCents:3000,tipSplits:[{amountCents:2700},{amountCents:300}]});
});
it('blocks an invalid additional fee instead of silently replacing it with zero',async()=>{
 mount();await prepare();fireEvent.change(screen.getByRole('spinbutton',{name:'Approved additional group fee'}),{target:{value:'-1'}});
 expect(screen.getByRole('alert')).toHaveTextContent('valid.moneyNegative');expect(screen.getByRole('button',{name:'Confirm group payment'})).toBeDisabled();expect(state.lastInput).toBeNull();
});
