import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReceiptDocument, type ReceiptData } from './ReceiptDocument';
const data: ReceiptData = {
  store: {name:'Real Salon', timezone:'America/New_York', phone:null, address:[], footer:'Thank you'},
  order: {ticketId:'test', businessDate:'2026-09-09', status:'closed', customerName:'Guest', customerPhone:null, customerId:null,
    openedAt:'2026-09-10T02:00:00Z', closedAt:'2026-09-10T03:00:00Z', subtotalCents:10000, discountCents:0, taxCents:800,
    surchargeCents:0, tipCents:2000, totalCents:12800, refundCents:1000, refundTipCents:0, refundTaxCents:0, refundFeeCents:0,
    items:[{itemId:'1',name:'Massage',kind:'service',quantity:2,unitPriceCents:5000,totalCents:10000,staffName:null,membershipId:null}],
    payments:[{paymentId:'p',method:'card',amountCents:12800,cardLast4:null}],tipAllocations:[{staffName:'Private staff split',amountCents:2000}]},
};
describe('customer receipt', () => {
 it('explains a service return as original benefits plus actual other payment sources',()=>{
  render(<ReceiptDocument data={{...data,membershipCreditCents:10000,membershipReturnedCents:10000,order:{...data.order,
   totalCents:18500,refundCents:18500,payments:[{paymentId:'cash',method:'cash',amountCents:8500,cardLast4:null}]}}}/>);
  expect(screen.getByText('Returned total').parentElement).toHaveTextContent('$185.00');
  expect(screen.getByText('Membership benefits returned').parentElement).toHaveTextContent('$100.00');
  expect(screen.getByText('Other payment sources returned').parentElement).toHaveTextContent('$85.00');
  expect(screen.getByText('Net paid / credit').parentElement).toHaveTextContent('$0.00');
 });
 it('separates paid membership service coverage from newly collected payments',()=>{
  render(<ReceiptDocument data={{...data,membershipCreditCents:10000,order:{...data.order,totalCents:10000,refundCents:0,tipCents:0,taxCents:0,payments:[]}}}/>);
  expect(screen.getByText('Paid membership benefits applied')).toBeInTheDocument();
  expect(screen.getByText('Payments received').parentElement).toHaveTextContent('$0.00');
 });
 it('uses actual store, local date, quantities and refunds without internal staff allocations', () => {
  render(<ReceiptDocument data={data}/>);
  expect(screen.getByText('Real Salon')).toBeInTheDocument();
  expect(screen.getByText(/Sep 9, 2026/)).toBeInTheDocument();
  expect(screen.getByText('Massage × 2')).toBeInTheDocument();
  expect(screen.getByText('$118.00')).toBeInTheDocument();
  expect(screen.queryByText('Private staff split')).not.toBeInTheDocument();
 });
 it('shows prepaid credit separately from cash tendered and change', () => {
  render(<ReceiptDocument data={{...data, packageCreditCents:5000, order:{...data.order, refundCents:0,
    payments:[{paymentId:'cash',method:'cash',amountCents:7800,cardLast4:null,tenderedCents:10000,changeCents:2200}]}}}/>);
  expect(screen.getByText('Prepaid package credit')).toBeInTheDocument();
  expect(screen.getByText('$50.00')).toBeInTheDocument();
  expect(screen.getByText('Tendered: $100.00 · Change: $22.00')).toBeInTheDocument();
 });
 it('keeps an already-paid $20 deposit separate from the new $80 receipt',()=>{
  render(<ReceiptDocument data={{...data,order:{...data.order,subtotalCents:10000,totalCents:10000,taxCents:0,tipCents:0,refundCents:0,
    payments:[{paymentId:'cash',method:'cash',amountCents:8000,cardLast4:null},{paymentId:'deposit',method:'deposit',amountCents:2000,cardLast4:null}]}}}/>);
  expect(screen.getByText('Payments received').parentElement).toHaveTextContent('$80.00');
  expect(screen.getByText('Previously paid deposit applied').parentElement).toHaveTextContent('$20.00');
  expect(screen.getByText('Order total').parentElement).toHaveTextContent('$100.00');
 });

});
