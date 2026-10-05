import type postgres from 'postgres';
import {AppError,ERROR_CODES,type CommerceDaySummary,type CommerceDayCurrency} from '@gf/contracts';
import {businessDayStart} from '@gf/scheduling';
import {ts} from '@gf/db';

export async function dayBounds(tx:postgres.TransactionSql,locationId:string,date:string){
 const [loc]=await tx<{timezone:string;cutoff:string;currency:string}[]>`select timezone,business_day_cutoff::text as cutoff,lower(currency) as currency from locations where id=${locationId}`;
 if(!loc)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [y,m,d]=date.split('-').map(Number),next=new Date(Date.UTC(y!,m!-1,d!+1)).toISOString().slice(0,10);
 return {...loc,from:businessDayStart(date,loc.timezone,loc.cutoff),to:businessDayStart(next,loc.timezone,loc.cutoff)};
}
/** Read original money facts; fulfillment and bank transfers never add a second receipt. */
export async function loadCommerceDay(tx:postgres.TransactionSql,locationId:string,date:string,throughDate=date):Promise<CommerceDaySummary>{
 const bounds=await dayBounds(tx,locationId,date);if(throughDate!==date)bounds.to=(await dayBounds(tx,locationId,throughDate)).to;
 const from=ts(bounds.from),to=ts(bounds.to),buckets=new Map<string,CommerceDayCurrency>();
 const bucket=(currency:string)=>{currency=currency.toLowerCase();let value=buckets.get(currency);if(!value){value={currency,sales:[],offlineCashReceivedCents:0,offlineCashRefundedCents:0,offlineCardReceivedCents:0,offlineCardRefundedCents:0,stripeReceivedCents:0,stripeRefundedCents:0,redemptions:[],giftFaceRemainingCents:0,packageUnitsRemaining:0,unlimitedPackageCount:0,packageFundedRemainingCents:0,membershipUnitsRemaining:0,membershipPlannedUnits:0,membershipPlannedValueCents:0,depositRemainingCents:0,depositRetainedCents:0,serviceRefundCreditIssuedCents:0};buckets.set(currency,value);}return value;};
 const receipts=await tx<{currency:string;kind:string;provider:string;method:string;received:number;refunded:number;payment_count:number;refund_count:number}[]>`
  select currency,kind,provider,method,sum(received)::int as received,sum(refunded)::int as refunded,sum(payment_count)::int as payment_count,sum(refund_count)::int as refund_count from (
   select p.currency,o.kind,p.provider,p.method,p.amount_cents as received,0 as refunded,1 as payment_count,0 as refund_count
   from commerce_payments p join commerce_orders o on o.id=p.order_id where p.location_id=${locationId} and p.paid_at>=${from}::timestamptz and p.paid_at<${to}::timestamptz
   union all
   select p.currency,o.kind,p.provider,p.method,0,r.amount_cents,0,1 from commerce_refunds r join commerce_payments p on p.id=r.payment_id join commerce_orders o on o.id=p.order_id
   where r.location_id=${locationId} and r.status='succeeded' and r.completed_at>=${from}::timestamptz and r.completed_at<${to}::timestamptz
  )facts group by currency,kind,provider,method order by currency,kind,provider,method`;
 for(const row of receipts){const b=bucket(row.currency);let sale=b.sales.find(s=>s.kind===row.kind);if(!sale){sale={kind:row.kind,receivedCents:0,refundedCents:0,paymentCount:0,refundCount:0};b.sales.push(sale);}sale.receivedCents+=row.received;sale.refundedCents+=row.refunded;sale.paymentCount+=row.payment_count;sale.refundCount+=row.refund_count;
  if(row.provider==='stripe'){b.stripeReceivedCents+=row.received;b.stripeRefundedCents+=row.refunded;}
  else if(row.method==='cash'){b.offlineCashReceivedCents+=row.received;b.offlineCashRefundedCents+=row.refunded;}
  else {b.offlineCardReceivedCents+=row.received;b.offlineCardRefundedCents+=row.refunded;}
 }
 const uses=await tx<{kind:string;applied:number;returned:number}[]>`
  select kind,sum(applied)::int as applied,sum(returned)::int as returned from (
   select c.kind,-c.amount_cents as applied,0 as returned from customer_credit_ledger c left join tickets t on t.id=c.ticket_id
    where c.location_id=${locationId} and c.kind in('gift_card','store_credit') and c.entry='redeem' and c.unit='cents'
     and ((t.business_date between ${date} and ${throughDate} and t.status<>'voided') or(t.id is null and c.created_at>=${from}::timestamptz and c.created_at<${to}::timestamptz))
   union all
   select 'package',case when c.meta->>'coveredCents' ~ '^[0-9]+$' then (c.meta->>'coveredCents')::int else 0 end,0
    from customer_credit_ledger c join tickets t on t.id=c.ticket_id where c.location_id=${locationId} and c.kind='package' and c.entry='redeem' and t.status<>'voided' and t.business_date between ${date} and ${throughDate}
   union all
   select 'membership',m.covered_cents,0 from customer_membership_ledger m join tickets t on t.id=m.ticket_id
    where m.location_id=${locationId} and m.entry='redeem' and t.status<>'voided' and t.business_date between ${date} and ${throughDate}
   union all
   select 'deposit',p.amount_cents,0 from payments p join tickets t on t.id=p.ticket_id where p.location_id=${locationId} and p.method='deposit' and t.status<>'voided' and t.business_date between ${date} and ${throughDate}
   union all
   select x.kind,0,x.amount from ticket_refunds r cross join lateral(values('gift_card',r.gift_card_cents),('store_credit',case when r.method='original_payment' then r.customer_credit_cents else 0 end),('package',r.package_cents),('membership',r.membership_cents),('deposit',r.deposit_cents))x(kind,amount)
    where r.location_id=${locationId} and r.business_date between ${date} and ${throughDate} and x.amount>0
  )facts group by kind order by kind`;
 const [legacy]=await tx<{count:number}[]>`select count(*)::int as count from customer_credit_ledger c join tickets t on t.id=c.ticket_id where c.location_id=${locationId} and c.kind='package' and c.entry='redeem' and t.business_date between ${date} and ${throughDate} and not coalesce(c.meta->>'coveredCents' ~ '^[0-9]+$',false)`;
 const [creditIssued]=await tx<{amount:number}[]>`select coalesce(sum(customer_credit_cents),0)::int as amount from ticket_refunds where location_id=${locationId} and business_date between ${date} and ${throughDate} and method='store_credit'`;bucket(bounds.currency).serviceRefundCreditIssuedCents=creditIssued!.amount;
 bucket(bounds.currency).redemptions=uses.map(r=>({kind:r.kind,appliedCents:r.applied,returnedCents:r.returned}));
 // Balances use append-only ledgers through the selected day, including returned assets.
 const gift=await tx<{currency:string;value:number}[]>`select lower(coalesce(g.purchase_snapshot->>'currency',l.currency)) as currency,sum(c.amount_cents)::int as value
  from customer_credit_ledger c join gift_cards g on g.id=c.subject_id join locations l on l.id=g.location_id
  where g.location_id=${locationId} and c.kind='gift_card' and c.unit='cents' and c.created_at<${to}::timestamptz group by 1`;
 for(const r of gift)bucket(r.currency).giftFaceRemainingCents=r.value;
 const packages=await tx<{currency:string;quantity:number;value:number}[]>`select lower(coalesce(p.purchase_snapshot->>'currency',l.currency)) as currency,coalesce(sum(c.quantity) filter(where p.total_sessions>0),0)::int as quantity,coalesce(sum(c.value_cents) filter(where p.total_sessions>0),0)::int as value
  from customer_package_ledger c join customer_packages p on p.id=c.package_id join locations l on l.id=p.location_id
  where p.location_id=${locationId} and c.created_at<${to}::timestamptz group by 1`;
 for(const r of packages){bucket(r.currency).packageUnitsRemaining=r.quantity;bucket(r.currency).packageFundedRemainingCents=r.value;}
 const unlimited=await tx<{currency:string;count:number}[]>`select lower(coalesce(p.purchase_snapshot->>'currency',l.currency)) as currency,count(*)::int as count from customer_packages p join locations l on l.id=p.location_id where p.location_id=${locationId} and p.total_sessions=0 and p.created_at<${to}::timestamptz and (p.expires_at is null or p.expires_at>=${to}::timestamptz) and not exists(select 1 from customer_package_ledger x where x.package_id=p.id and x.entry='purchase_refund' and x.created_at<${to}::timestamptz) group by 1`;for(const r of unlimited)bucket(r.currency).unlimitedPackageCount=r.count;
 const members=await tx<{currency:string;quantity:number}[]>`select m.snapshot->>'currency' as currency,sum(l.quantity)::int as quantity from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id join customer_paid_memberships m on m.id=c.membership_id
  where m.location_id=${locationId} and l.created_at<${to}::timestamptz group by 1`;
 for(const r of members)bucket(r.currency).membershipUnitsRemaining=r.quantity;
 const planned=await tx<{currency:string;quantity:number;value:number}[]>`select m.snapshot->>'currency' as currency,sum(c.quantity)::int as quantity,sum(c.value_cents)::int as value from customer_membership_cycles c join customer_paid_memberships m on m.id=c.membership_id
  where m.location_id=${locationId} and c.created_at<${to}::timestamptz and c.starts_at>=${to}::timestamptz
   and not exists(select 1 from customer_membership_ledger stopped where stopped.cycle_id=c.id and stopped.entry='stop' and stopped.created_at<${to}::timestamptz)
  group by 1`;
 for(const r of planned){bucket(r.currency).membershipPlannedUnits=r.quantity;bucket(r.currency).membershipPlannedValueCents=r.value;}
 const deposits=await tx<{currency:string;balance:number;retained:number}[]>`select h.currency,sum(l.amount_cents)::int as balance,coalesce(-sum(l.amount_cents) filter(where l.entry in('retained','retention_released') and l.created_at>=${from}::timestamptz),0)::int as retained
  from commerce_deposit_ledger l join commerce_appointment_holds h on h.id=l.hold_id where h.location_id=${locationId} and l.created_at<${to}::timestamptz group by h.currency`;
 for(const r of deposits){bucket(r.currency).depositRemainingCents=r.balance;bucket(r.currency).depositRetainedCents=r.retained;}
 const settlements=await tx<{currency:string;gross:number;fee:number;net:number;payment_count:number;refund_count:number}[]>`
  select currency,sum(gross)::int as gross,sum(fee)::int as fee,sum(net)::int as net,sum(payment_count)::int as payment_count,sum(refund_count)::int as refund_count from (
   select settlement_currency as currency,settlement_gross_cents as gross,fee_cents as fee,net_cents as net,1 as payment_count,0 as refund_count from commerce_payments where location_id=${locationId} and balance_transaction_id is not null and paid_at>=${from}::timestamptz and paid_at<${to}::timestamptz
   union all select settlement_currency,settlement_gross_cents,fee_cents,net_cents,0,1 from commerce_refunds where location_id=${locationId} and status='succeeded' and balance_transaction_id is not null and completed_at>=${from}::timestamptz and completed_at<${to}::timestamptz
  )facts group by currency order by currency`;
 const [pending]=await tx<{count:number}[]>`select count(*)::int as count from (
  select id from commerce_payments where location_id=${locationId} and provider='stripe' and paid_at>=${from}::timestamptz and paid_at<${to}::timestamptz and balance_transaction_id is null
  union all select r.id from commerce_refunds r join commerce_payments p on p.id=r.payment_id where r.location_id=${locationId} and p.provider='stripe' and r.status='succeeded' and r.completed_at>=${from}::timestamptz and r.completed_at<${to}::timestamptz and r.balance_transaction_id is null
 )facts`;
 const payouts=await tx<{id:string;currency:string;amount_cents:number;status:string;automatic:boolean;arrival_at:string}[]>`select p.id,p.currency,p.amount_cents,p.automatic,o.status,o.arrival_at::text from commerce_payouts p
  join lateral(select status,arrival_at from commerce_payout_observations where payout_id=p.id order by observed_at desc,created_at desc,id desc limit 1)o on true
  where p.location_id=${locationId} and p.business_date between ${date} and ${throughDate} order by p.provider_created_at,p.id`;
 return {version:1,businessDate:date,throughDate,timezone:bounds.timezone,cutoff:bounds.cutoff,from:bounds.from.toISOString(),to:bounds.to.toISOString(),currencies:[...buckets.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),settlements:settlements.map(r=>({currency:r.currency,grossCents:r.gross,feeCents:r.fee,netCents:r.net,paymentCount:r.payment_count,refundCount:r.refund_count})),unclassifiedRedemptionCount:legacy!.count,pendingSettlementCount:pending!.count,payouts:payouts.map(r=>({id:r.id,currency:r.currency,amountCents:r.amount_cents,status:r.status,automatic:r.automatic,arrivalAt:r.arrival_at}))};
}
