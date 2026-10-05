import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { Checkout,CheckoutWorkbench } from './Checkout';
import type {CheckoutPackage} from '@/features/checkout/types';

const state = vi.hoisted(() => ({
  close: vi.fn(),
  canCommerce:true,quoteUnavailable:false,quoteOverride:null as number|null,
  data: { tickets: [{
    ticketId: 'ticket-A', customerName: 'Guest A', customerId: 'customer-A', status: 'ready_to_pay',
    subtotalCents: 5000, checkoutTiming: 'after_service_combined', serviceSettledAt: null,
    tipSettledAt: null, serviceCompleted: true, groupId: null, groupLabel: null,
    businessDate: '2026-09-12', daysAgo: 0, availablePackages: [] as CheckoutPackage[],
    availableStoreCreditCents:1000,
    availableDeposit:null as {holdId:string;availableCents:number;currency:string}|null,
    availableMemberships:[] as Array<{cycleId:string;name:string;serviceIds:string[];availableQuantity:number;expiresAt:string;timezone:string}>,
    availableMembershipDiscounts:[] as Array<{membershipId:string;cycleId:string;planVersionId:string;name:string;discountBps:number;expiresAt:string;timezone:string;
      items:Array<{ticketItemId:string;expectedTotalCents:number;expectedDiscountCents:number}>}>,
    items: [{ ticketItemId: 'item-A', serviceId: 'service-A', name: 'Massage', totalCents: 5000,
      durationMin: 30, staffName: 'Amy', membershipId: 'staff-A' }],
  }] },
}));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ language: 'en', t: (key: string) => key }) }));
vi.mock('@/lib/permissions', () => ({ useCanWrite: (permission:string) => permission!=='commerce.sell'||state.canCommerce, useWriteBlockReason: () => () => null }));
vi.mock('@/context/ScheduleContext', () => ({ useSchedule: () => ({ staff: [], services: [] }), UNASSIGNED_STAFF_ID: 'unassigned' }));
vi.mock('@/features/checkout/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/checkout/api')>(),
  useOpenTickets: () => ({ data: state.data, isLoading: false }),
  useCloseTicket: () => ({ mutateAsync: state.close, isPending: false }),
  useCloseGroup:()=>({hasPendingSettlement:false,pendingGroupPayment:null,isPending:false}),
  // UI fixtures provide server responses; production quote arithmetic is covered by real DB tests.
  useCheckoutQuote:(input:import('@/features/checkout/api').CheckoutQuoteInput|null)=>({
    data:input&&!state.quoteUnavailable?{quoteHash:'f'.repeat(64),tipCents:input.tipCents??0,
      amountDueCents:state.quoteOverride??5000-(input.discountCents??0)-(input.packageRedemptions?.length||input.membershipRedemptions?.length?5000:0)
       -(input.membershipDiscount?.items.reduce((n,i)=>n+i.expectedDiscountCents,0)??0)-(input.depositApplication?.amountCents??0)+(input.surchargeCents??0)+(input.tipCents??0)}:undefined,
    isFetching:state.quoteUnavailable,error:null,refetch:vi.fn(),
  }),
  useVoidTicket: () => ({ isPending: false }),
}));
beforeEach(() => { state.quoteUnavailable=false;state.quoteOverride=null;state.canCommerce=true;state.data.tickets[0]!.availablePackages=[];state.data.tickets[0]!.availableMemberships=[];state.data.tickets[0]!.availableMembershipDiscounts=[];state.data.tickets[0]!.availableDeposit=null;state.close.mockReset().mockResolvedValue({ ticketId: 'ticket-A', allocations: [], totalCents: 6000 }); });
function inputAfterLabel(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('label')).find(el => el.textContent === text);
  if (!label) throw new Error(`Missing label ${text}`);
  return label.parentElement!.querySelector('input')!;
}
it('uses the purchased one-service coverage even when the current store fallback requires the entire bundle',async()=>{
 state.data.tickets[0]!.availablePackages=[{customerPackageId:'package-A',name:'Purchased two-service card',serviceIds:['service-A','service-B'],remainingSessions:9,totalSessions:10,expiresAt:null,coverageMode:'any_included'}];
 render(<MemoryRouter><Checkout/></MemoryRouter>);await screen.findByText('checkout.confirmCheckout ($50.00)');
 fireEvent.change(screen.getByRole('combobox',{name:'checkout.packageRedemption'}),{target:{value:'package-A'}});await screen.findByText('checkout.confirmCheckout ($0.00)');
 fireEvent.click(screen.getByRole('button',{name:'checkout.confirmCheckout ($0.00)'}));await waitFor(()=>expect(state.close).toHaveBeenCalled());
 expect(state.close.mock.calls[0]![0]).toMatchObject({packageRedemptions:[{customerPackageId:'package-A',units:1}],payments:[{amountCents:0,tipCents:0}]});
});
function withDiscountOffer(){state.data.tickets[0]!.availableMembershipDiscounts=[{membershipId:'paid-member-A',cycleId:'cycle-A',planVersionId:'version-A',name:'Purchased discount',discountBps:1000,
 expiresAt:'2030-01-01T00:00:00Z',timezone:'America/New_York',items:[{ticketItemId:'item-A',expectedTotalCents:5000,expectedDiscountCents:500}]}];}
it('submits the server quoted member price and keeps discounted-service tips in the new money channel',async()=>{
 withDiscountOffer();render(<MemoryRouter><Checkout/></MemoryRouter>);await screen.findByText('checkout.confirmCheckout ($50.00)');
 fireEvent.change(screen.getByRole('combobox',{name:'Paid membership discount'}),{target:{value:'cycle-A'}});
 await screen.findByText('checkout.confirmCheckout ($45.00)');expect(screen.getByRole('button',{name:/15%\s*\$6\.75/})).toBeInTheDocument();
 fireEvent.change(inputAfterLabel('tip'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'checkout.confirmCheckout ($55.00)'}));
 await waitFor(()=>expect(state.close).toHaveBeenCalled());expect(state.close.mock.calls[0]![0]).toMatchObject({discountCents:0,
  membershipDiscount:{membershipId:'paid-member-A',cycleId:'cycle-A',planVersionId:'version-A',items:[{ticketItemId:'item-A',expectedTotalCents:5000,expectedDiscountCents:500}]},
  payments:[{amountCents:5500,tipCents:1000}]});
});
it('requires choosing one line price benefit before an additional authorized discount can be submitted',async()=>{
 withDiscountOffer();render(<MemoryRouter><Checkout/></MemoryRouter>);await screen.findByText('checkout.confirmCheckout ($50.00)');
 fireEvent.change(screen.getByRole('combobox',{name:'Paid membership discount'}),{target:{value:'cycle-A'}});await screen.findByText('checkout.confirmCheckout ($45.00)');
 const label=screen.getByText('checkout.ticketDiscount');fireEvent.change(label.closest('div')!.parentElement!.querySelector('input')!,{target:{value:'1'}});
 expect(await screen.findByRole('alert')).toHaveTextContent('Review the selected price benefits');expect(screen.getByRole('button',{name:/checkout.confirmCheckout/})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:/Massage/}));await screen.findByText('checkout.confirmCheckout ($49.00)');
 fireEvent.click(screen.getByRole('button',{name:'checkout.confirmCheckout ($49.00)'}));await waitFor(()=>expect(state.close).toHaveBeenCalled());
 expect(state.close.mock.calls[0]![0]).toMatchObject({discountCents:100});expect(state.close.mock.calls[0]![0].membershipDiscount).toBeUndefined();
});
it('keeps membership price choice read-only without the commerce benefit permission',async()=>{
 withDiscountOffer();state.canCommerce=false;render(<MemoryRouter><Checkout/></MemoryRouter>);
 expect(await screen.findByRole('combobox',{name:'Paid membership discount'})).toBeDisabled();
});
it('#23 submits matching channel tips, total and staff splits', async () => {
  render(<MemoryRouter><Checkout /></MemoryRouter>);
  await screen.findByText('checkout.confirmCheckout ($50.00)');
  fireEvent.change(inputAfterLabel('tip'), { target: { value: '10' } });
  fireEvent.change(inputAfterLabel('tip'), { target: { value: '-5' } });
  expect(inputAfterLabel('tip').value).toBe('10.00');
  fireEvent.click(screen.getByRole('button', { name: 'checkout.confirmCheckout ($60.00)' }));
  await waitFor(() => expect(state.close).toHaveBeenCalled());
  expect(state.close.mock.calls[0]![0]).toMatchObject({
    payments: [{ amountCents: 6000, tipCents: 1000 }], tipTotalCents: 1000,
    tipSplits: [{ staffMembershipId: 'staff-A', amountCents: 1000 }],
  });
});
it('#22 and #23 keep cash change and retained-tip allocations consistent', async () => {
  render(<MemoryRouter><Checkout /></MemoryRouter>);
  await screen.findByText('checkout.confirmCheckout ($50.00)');
  const method = screen.getAllByRole('combobox').find(el => (el as HTMLSelectElement).value === 'card')!;
  fireEvent.change(method, { target: { value: 'cash' } });
  fireEvent.change(inputAfterLabel('tip'), { target: { value: '10' } });
  fireEvent.change(inputAfterLabel('amountReceived'), { target: { value: '70' } });
  expect(inputAfterLabel('amountReceived').value).toBe('70');
  fireEvent.click(screen.getByRole('checkbox', { name: 'checkout.keepChange' }));
  fireEvent.click(screen.getByRole('button', { name: 'checkout.confirmCheckout ($70.00)' }));
  await waitFor(() => expect(state.close).toHaveBeenCalled());
  expect(state.close.mock.calls[0]![0]).toMatchObject({
    payments: [{ method: 'cash', amountCents: 7000, tipCents: 2000, changeCents: 0, tenderedCents: 7000 }],
    tipTotalCents: 2000, tipSplits: [{ amountCents: 2000 }],
  });
});
it('requires frontdesk confirmation to apply a paid deposit and charges the tip through the new payment channel',async()=>{
  state.data.tickets[0]!.availableDeposit={holdId:'deposit-A',availableCents:2000,currency:'usd'};
  render(<MemoryRouter><Checkout/></MemoryRouter>);
  await screen.findByText('checkout.confirmCheckout ($50.00)');
  const apply=screen.getByRole('checkbox',{name:/Apply paid deposit/});expect(apply).not.toBeChecked();
  fireEvent.click(apply);await screen.findByText('checkout.confirmCheckout ($30.00)');
  fireEvent.change(inputAfterLabel('tip'),{target:{value:'10'}});
  fireEvent.click(screen.getByRole('button',{name:'checkout.confirmCheckout ($40.00)'}));
  await waitFor(()=>expect(state.close).toHaveBeenCalled());
  expect(state.close.mock.calls[0]![0]).toMatchObject({depositApplication:{holdId:'deposit-A',amountCents:2000},discountCents:0,
    payments:[{amountCents:4000,tipCents:1000}],tipTotalCents:1000});
});
it('keeps deposit application read-only without commerce permission',async()=>{
  state.canCommerce=false;state.data.tickets[0]!.availableDeposit={holdId:'deposit-A',availableCents:2000,currency:'usd'};
  render(<MemoryRouter><Checkout/></MemoryRouter>);await screen.findByText('checkout.confirmCheckout ($50.00)');
  expect(screen.getByRole('checkbox',{name:/Apply paid deposit/})).toBeDisabled();
});
it('selects specific paid membership service coverage while collecting tips through the new payment channel',async()=>{
 state.data.tickets[0]!.availableMemberships=[{cycleId:'cycle-A',name:'Monthly care',serviceIds:['service-A'],availableQuantity:1,expiresAt:'2026-11-01T14:00:00Z',timezone:'America/Los_Angeles'}];
 render(<MemoryRouter><Checkout/></MemoryRouter>);await screen.findByText('checkout.confirmCheckout ($50.00)');
 fireEvent.change(screen.getByRole('combobox',{name:'Benefit periods'}),{target:{value:'cycle-A'}});
 fireEvent.click(screen.getByRole('checkbox',{name:/Massage/}));await screen.findByText('checkout.confirmCheckout ($0.00)');
 expect(screen.getByRole('button',{name:/15%\s*\$7\.50/})).toBeInTheDocument();
 fireEvent.change(inputAfterLabel('tip'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'checkout.confirmCheckout ($10.00)'}));
 await waitFor(()=>expect(state.close).toHaveBeenCalled());expect(state.close.mock.calls[0]![0]).toMatchObject({
  membershipRedemptions:[{cycleId:'cycle-A',ticketItemIds:['item-A']}],discountCents:0,payments:[{amountCents:1000,tipCents:1000}]});
});
it('does not grant membership use without commerce permission',async()=>{
 state.canCommerce=false;state.data.tickets[0]!.availableMemberships=[{cycleId:'cycle-A',name:'Monthly care',serviceIds:['service-A'],availableQuantity:1,expiresAt:'2026-11-01T14:00:00Z',timezone:'America/Los_Angeles'}];
 render(<MemoryRouter><Checkout/></MemoryRouter>);await screen.findByText('checkout.confirmCheckout ($50.00)');
 expect(screen.getByRole('combobox',{name:'Benefit periods'})).toBeDisabled();
});

it('charges the confirmed server amount and sends its exact quote hash',async()=>{
 state.quoteOverride=5666;render(<MemoryRouter><Checkout/></MemoryRouter>);
 const button=await screen.findByRole('button',{name:'checkout.confirmCheckout ($56.66)'});fireEvent.click(button);
 await waitFor(()=>expect(state.close).toHaveBeenCalled());expect(state.close.mock.calls[0]![0]).toMatchObject({expectedQuoteHash:'f'.repeat(64),payments:[{amountCents:5666}]});
});
it('does not accept payment while the server quote is unavailable',async()=>{
 state.quoteUnavailable=true;render(<MemoryRouter><Checkout/></MemoryRouter>);
 expect(screen.getByRole('button',{name:/checkout.confirmCheckout/})).toBeDisabled();
 expect(screen.getByText('Checking the current checkout total…')).toBeInTheDocument();expect(state.close).not.toHaveBeenCalled();
});

it('uses the same server quote, benefits and tender inside a pinned inline checkout',async()=>{
 const onSettled=vi.fn();state.quoteOverride=5666;
 render(<MemoryRouter initialEntries={['/queue']}><CheckoutWorkbench ticketId="ticket-A" embedded onSettled={onSettled}/></MemoryRouter>);
 expect(screen.queryByRole('heading',{name:'openTickets'})).not.toBeInTheDocument();
 fireEvent.click(await screen.findByRole('button',{name:'checkout.confirmCheckout ($56.66)'}));
 await waitFor(()=>expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ticketId:'ticket-A'})));
 expect(state.close.mock.calls[0]![0]).toMatchObject({ticketId:'ticket-A',expectedQuoteHash:'f'.repeat(64),payments:[{amountCents:5666}]});
});
it('never switches an inline checkout to another customer when its pinned ticket is unavailable',()=>{
 render(<MemoryRouter><CheckoutWorkbench ticketId="missing-ticket" embedded/></MemoryRouter>);
 expect(screen.getByText('checkout.stageUnavailable')).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:/checkout.confirmCheckout/})).not.toBeInTheDocument();expect(state.close).not.toHaveBeenCalled();
});

it('saves a group member selection without charging the ticket',async()=>{
 const save=vi.fn();render(<MemoryRouter><CheckoutWorkbench ticketId="ticket-A" embedded onSelection={save}/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'Save this ticket selection ($50.00)'}));
 expect(save).toHaveBeenCalledWith(expect.objectContaining({ticketId:'ticket-A',tipCents:0}),expect.objectContaining({quoteHash:'f'.repeat(64)}));expect(state.close).not.toHaveBeenCalled();
});
it('restores an edited group selection rather than resetting it to the standalone defaults',async()=>{
 withDiscountOffer();const initial={ticketId:'ticket-A',discountCents:0,tipCents:1000,membershipDiscount:{membershipId:'paid-member-A',cycleId:'cycle-A',planVersionId:'version-A',items:state.data.tickets[0]!.availableMembershipDiscounts[0]!.items}};
 render(<MemoryRouter><CheckoutWorkbench ticketId="ticket-A" embedded initialSelection={initial} onSelection={vi.fn()}/></MemoryRouter>);
 expect(await screen.findByRole('combobox',{name:'Paid membership discount'})).toHaveValue('cycle-A');expect(await screen.findByRole('button',{name:'Save this ticket selection ($55.00)'})).toBeInTheDocument();
});
it('keeps a partial stored-value selection and sends tips to a separate money channel',async()=>{
 const save=vi.fn();render(<MemoryRouter><CheckoutWorkbench ticketId="ticket-A" embedded onSelection={save}/></MemoryRouter>);
 await screen.findByRole('button',{name:'Save this ticket selection ($50.00)'});
 const method=screen.getAllByRole('combobox').find(el=>(el as HTMLSelectElement).value==='card')!;
 fireEvent.change(method,{target:{value:'customer_credit'}});
 const amount=inputAfterLabel('baseAmount');fireEvent.change(amount,{target:{value:'10'}});
 expect(amount).toHaveValue('10.00');
 fireEvent.change(inputAfterLabel('checkout.tipCustomTotal'),{target:{value:'5'}});
 fireEvent.click(await screen.findByRole('button',{name:'Save this ticket selection ($55.00)'}));
 expect(save).toHaveBeenCalledWith(expect.objectContaining({tipCents:500,storedValuePayments:[expect.objectContaining({method:'customer_credit',amountCents:1000,tipCents:0})]}),expect.anything());
 expect(state.close).not.toHaveBeenCalled();
});

it('restores and preserves custom staff tips when editing a group selection',async()=>{
 const save=vi.fn(),initial={ticketId:'ticket-A',tipCents:900,tipSplits:[{staffMembershipId:'staff-A',amountCents:900}]};
 render(<MemoryRouter><CheckoutWorkbench ticketId="ticket-A" embedded initialSelection={initial} onSelection={save}/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'Save this ticket selection ($59.00)'}));
 expect(save).toHaveBeenCalledWith(expect.objectContaining({tipSplits:[expect.objectContaining({staffMembershipId:'staff-A',amountCents:900})]}),expect.anything());
});
