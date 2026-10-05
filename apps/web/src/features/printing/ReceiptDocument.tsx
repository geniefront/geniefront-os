import { formatPhoneDisplay } from '@gf/contracts';
import type { OrderRowDto } from '@/features/tickets/types';

export interface ReceiptData {
  order: OrderRowDto;
  packageCreditCents?: number;
  membershipCreditCents?:number;
  membershipReturnedCents?:number;
  store: { name: string; timezone: string; phone: string | null; address: string[]; footer: string };
}
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export function ReceiptDocument({data}: {data: ReceiptData}) {
  const {order, store} = data;
  const packageCredit = data.packageCreditCents ?? 0;
  const membershipCredit=data.membershipCreditCents??0;
  const prepaidMethods=['deposit','gift_card','customer_credit'];
  const collected=order.payments.filter(p=>!prepaidMethods.includes(p.method)).reduce((sum,p)=>sum+p.amountCents,0);
  const prepaid=prepaidMethods.map(method=>({method,amount:order.payments.filter(p=>p.method===method).reduce((sum,p)=>sum+p.amountCents,0)}));
  const prepaidTotal=prepaid.reduce((sum,p)=>sum+p.amount,0)+packageCredit+membershipCredit;
  const date = new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short', timeZone: store.timezone});
  const line = (label: string, cents: number) => <div className="flex justify-between gap-4"><span>{label}</span><strong>{usd(cents)}</strong></div>;
  return <article className="receipt-document space-y-4" lang="en">
    <header className="text-center space-y-1">
      <h1 className="text-xl font-bold">{store.name}</h1>
      {store.address.map((part, index) => <p key={index}>{part}</p>)}
      {store.phone && <p>{formatPhoneDisplay(store.phone)}</p>}
      <h2 className="font-bold">Customer receipt</h2>
    </header>
    <section>
      <p>Receipt: {order.ticketId}</p>
      <p>Customer: {order.customerName}</p>
      <p>{order.closedAt ? 'Closed' : 'Opened'}: {date.format(new Date(order.closedAt ?? order.openedAt))} ({store.timezone})</p>
      <p>Status: {order.status === 'closed' ? 'Paid' : order.status.replaceAll('_', ' ')}</p>
    </section>
    <table className="w-full"><thead><tr><th className="pr-4 text-left">Item / Qty</th><th className="whitespace-nowrap text-right">Amount (USD)</th></tr></thead>
      <tbody>{order.items.map(item => <tr key={item.itemId}><td className="pr-4">{item.name} × {item.quantity}</td><td className="whitespace-nowrap text-right">{usd(item.totalCents)}</td></tr>)}</tbody>
    </table>
    <section className="space-y-1">
      {line('Subtotal', order.subtotalCents)}
      {order.discountCents !== 0 && line('Discount', -order.discountCents)}
      {line('Sales tax', order.taxCents)}
      {order.surchargeCents !== 0 && line('Card surcharge', order.surchargeCents)}
      {line('Tip', order.tipCents)}
      {line('Order total', order.totalCents)}
      {line('Payments received', collected)}
      {prepaid.filter(p=>p.amount>0).map(p=><div key={p.method}>{line(p.method==='deposit'?'Previously paid deposit applied':p.method==='gift_card'?'Gift card applied':'Customer credit applied',p.amount)}</div>)}
      {packageCredit > 0 && line('Prepaid package credit', packageCredit)}
      {membershipCredit>0&&line('Paid membership benefits applied',membershipCredit)}
      {order.refundCents > 0 && <>{line(membershipCredit>0?'Returned total':'Refunded', order.refundCents)}
       {(data.membershipReturnedCents??0)>0&&<>{line('Membership benefits returned',data.membershipReturnedCents!)}{line('Other payment sources returned',order.refundCents-data.membershipReturnedCents!)}</>}
       {line(prepaidTotal > 0 ? 'Net paid / credit' : 'Net paid', collected + prepaidTotal - order.refundCents)}</>}
    </section>
    <section>{order.payments.map(payment => <div key={payment.paymentId}><p>{payment.method.replaceAll('_',' ')}{payment.cardLast4 ? ` •••• ${payment.cardLast4}` : ''}: {usd(payment.amountCents)}</p>{payment.method === 'cash' && payment.tenderedCents != null && <p>Tendered: {usd(payment.tenderedCents)} · Change: {usd(payment.changeCents ?? 0)}</p>}</div>)}</section>
    {order.status !== 'closed' && order.status !== 'refunded' && <p>Interim receipt. This order is not finalized.</p>}
    <footer className="whitespace-pre-wrap text-center">{store.footer}</footer>
  </article>;
}
