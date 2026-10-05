import {AppError,ERROR_CODES,type CommandContext,pickText} from '@gf/contracts';
import {balancedComponentAllocation,largestRemainderSplit,allocateItemCommissionReturns,type ItemSourceBalance,type ItemSourceReturn} from '@gf/payroll';
import {jsonb} from '@gf/db';
import type {Tx} from '../commerce/model';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
/** Only original ticket, price adjustments, redemption and earning facts enter this graph. */
export async function recordTicketItemGraph(tx:Tx,ctx:CommandContext,ticketId:string,origin:'checkout'|'legacy_projection'='checkout'){
 if((await tx`select ticket_id from ticket_item_graph_receipts where ticket_id=${ticketId}`).length)return true;
 const [t]=await tx<{id:string;total_cents:number;tip_cents:number;discount_cents:number;tax_cents:number;surcharge_cents:number;service_charge_cents:number;refund_cents:number;settlement_tax_mode:'inclusive'|'exclusive'|null}[]>`select * from tickets where id=${ticketId}`;
 if(!t)invalid('source_ticket_missing');
 const items=await tx<{id:string;total_cents:number;discount:number;name_snapshot:unknown}[]>`select i.id,i.total_cents,i.name_snapshot,coalesce((select sum(discount_cents) from ticket_price_adjustments where ticket_item_id=i.id),0)::int as discount from ticket_items i where ticket_id=${ticketId} order by seq,id`;
 const sources=await tx<{id:string;kind:string;service_cents:number;tax_cents:number;fee_cents:number;item_ids:string[]}[]>`select * from ticket_settlement_sources where ticket_id=${ticketId} order by source_key`;
 type Line={ticketItemId:string;baseCents:number;amountCents:number;rateBp:number};
 const earnings=await tx<{id:string;membership_id:string;base_cents:number;amount_cents:number;basis:{itemLines?:Line[];rateBp?:number}}[]>`select id,membership_id,base_cents,amount_cents,basis from earnings where ticket_id=${ticketId} and kind='commission' and base_cents>=0 and amount_cents>=0 and reversed_at is null and basis->>'refund' is distinct from 'true' order by id`;
 const net=items.map(i=>i.total_cents-i.discount),netTotal=net.reduce((n,v)=>n+v,0),due=t.total_cents-t.tip_cents-t.surcharge_cents-t.service_charge_cents;
 const mode=t.settlement_tax_mode??(due===netTotal+t.tax_cents?'exclusive':due===netTotal?'inclusive':null);
 const exactEarnings=earnings.every(e=>e.basis.itemLines?.length?e.basis.itemLines.reduce((n,l)=>n+l.baseCents,0)===e.base_cents&&e.basis.itemLines.reduce((n,l)=>n+l.amountCents,0)===e.amount_cents&&e.basis.itemLines.every(l=>items.some(i=>i.id===l.ticketItemId)):items.length===1);
 if(!mode||items.reduce((n,i)=>n+i.discount,0)!==t.discount_cents||!exactEarnings||origin==='legacy_projection'&&t.refund_cents>0){if(origin==='legacy_projection'&&t.settlement_tax_mode===null)return false;invalid('original_item_graph_incomplete');}
 const quotas=sources.filter(s=>s.kind==='package'||s.kind==='membership'),money=sources.filter(s=>s.kind!=='package'&&s.kind!=='membership');
 const covered=new Set(quotas.flatMap(s=>s.item_ids));
 if(quotas.flatMap(s=>s.item_ids).length!==covered.size)invalid('original_quota_items_overlap');
 const taxWeights=items.map((i,index)=>covered.has(i.id)?0:net[index]!);
 const taxShares=t.tax_cents?largestRemainderSplit(t.tax_cents,taxWeights,{zeroWeights:'throw'}):items.map(()=>0);
 const serviceShares=net.map((n,index)=>n-(mode==='inclusive'?taxShares[index]!:0)),feeTotal=t.surcharge_cents+t.service_charge_cents;
 const feeWeights=net.some(n=>n>0)?net:items.map(i=>i.total_cents);
 const feeShares=feeTotal?largestRemainderSplit(feeTotal,feeWeights):items.map(()=>0);
 if(serviceShares.some(n=>n<0))invalid('original_item_tax_incomplete');
 for(const [index,item] of items.entries())await tx`insert into ticket_item_settlements(ticket_item_id,org_id,location_id,ticket_id,original_cents,discount_cents,service_cents,tax_cents,fee_cents,tax_mode)
  values(${item.id},${ctx.orgId},${ctx.locationId},${ticketId},${item.total_cents},${item.discount},${serviceShares[index]!},${taxShares[index]!},${feeShares[index]!},${mode})`;
 const cells=new Map<string,{sourceId:string;itemId:string;service:number;tax:number;fee:number}>();
 const add=(sourceId:string,itemId:string,key:'service'|'tax'|'fee',amount:number)=>{if(!amount)return;const id=`${sourceId}:${itemId}`,cell=cells.get(id)??{sourceId,itemId,service:0,tax:0,fee:0};cell[key]+=amount;cells.set(id,cell);};
 for(const source of quotas){const selected=items.flatMap((item,index)=>source.item_ids.includes(item.id)?[{item,index}]:[]);if(selected.reduce((n,r)=>n+serviceShares[r.index]!,0)!==source.service_cents)invalid('quota_item_source_mismatch');for(const row of selected)add(source.id,row.item.id,'service',serviceShares[row.index]!);}
 for(const [key,weights,values] of [
  ['service',items.map((i,index)=>covered.has(i.id)?0:serviceShares[index]!),money.map(s=>s.service_cents)],
  ['tax',taxShares,money.map(s=>s.tax_cents)],['fee',feeShares,money.map(s=>s.fee_cents)],
 ] as const){const matrix=balancedComponentAllocation(weights,values);money.forEach((s,column)=>items.forEach((i,row)=>add(s.id,i.id,key,matrix[column]![row]!)));}
 for(const cell of cells.values())await tx`insert into ticket_item_source_allocations(org_id,location_id,source_id,ticket_item_id,service_cents,tax_cents,fee_cents) values(${ctx.orgId},${ctx.locationId},${cell.sourceId},${cell.itemId},${cell.service},${cell.tax},${cell.fee})`;
 let commissionCount=0;
 for(const earning of earnings){const lines=earning.basis.itemLines?.length?earning.basis.itemLines:[{ticketItemId:items[0]!.id,baseCents:earning.base_cents,amountCents:earning.amount_cents,rateBp:earning.basis.rateBp??0}];
  for(const line of lines){await tx`insert into ticket_item_commission_sources(org_id,location_id,earning_id,ticket_item_id,membership_id,base_cents,amount_cents,rate_bp)
   values(${ctx.orgId},${ctx.locationId},${earning.id},${line.ticketItemId},${earning.membership_id},${line.baseCents},${line.amountCents},${line.rateBp})`;commissionCount++;}}
 await tx`insert into ticket_item_graph_receipts(ticket_id,org_id,location_id,origin,item_count,allocation_count,commission_count) values(${ticketId},${ctx.orgId},${ctx.locationId},${origin},${items.length},${cells.size},${commissionCount})`;
 return true;
}
export async function ticketItemSourceBalances(tx:Tx,ticketId:string):Promise<ItemSourceBalance[]>{
 const rows=await tx<{id:string;source_id:string;ticket_item_id:string;service_cents:number;tax_cents:number;fee_cents:number;returned_service:number;returned_tax:number;returned_fee:number}[]>`select a.*,
  coalesce((select sum(service_cents) from ticket_item_source_returns where allocation_id=a.id),0)::int as returned_service,
  coalesce((select sum(tax_cents) from ticket_item_source_returns where allocation_id=a.id),0)::int as returned_tax,
  coalesce((select sum(fee_cents) from ticket_item_source_returns where allocation_id=a.id),0)::int as returned_fee
  from ticket_item_source_allocations a join ticket_settlement_sources s on s.id=a.source_id where s.ticket_id=${ticketId} order by a.id`;
 return rows.map(r=>({id:r.id,sourceId:r.source_id,itemId:r.ticket_item_id,serviceCents:r.service_cents,taxCents:r.tax_cents,feeCents:r.fee_cents,returnedServiceCents:r.returned_service,returnedTaxCents:r.returned_tax,returnedFeeCents:r.returned_fee}));
}
export async function ticketRefundItemOptions(tx:Tx,ctx:CommandContext,ticketId:string){
 const available=(await tx`select ticket_id from ticket_item_graph_receipts where ticket_id=${ticketId}`).length>0;if(!available)return {itemGraphAvailable:false,items:[]};
 const cells=await ticketItemSourceBalances(tx,ticketId),items=await tx<{id:string;name_snapshot:unknown}[]>`select id,name_snapshot from ticket_items where ticket_id=${ticketId} order by seq,id`;
 return {itemGraphAvailable:true,items:items.map(item=>{const rows=cells.filter(c=>c.itemId===item.id);return {ticketItemId:item.id,name:pickText(item.name_snapshot,ctx.locale),remainingCents:rows.reduce((n,c)=>n+c.serviceCents+c.taxCents+c.feeCents-c.returnedServiceCents-c.returnedTaxCents-c.returnedFeeCents,0)};})};
}
export async function recordTicketItemReturns(tx:Tx,ctx:CommandContext,refundId:string,plan:readonly ItemSourceReturn[]){
 for(const part of plan)await tx`insert into ticket_item_source_returns(org_id,location_id,ticket_refund_id,source_id,allocation_id,service_cents,tax_cents,fee_cents)
  values(${ctx.orgId},${ctx.locationId},${refundId},${part.sourceId},${part.allocationId},${part.serviceCents},${part.taxCents},${part.feeCents})`;
}
export async function returnTicketItemCommissions(tx:Tx,ctx:CommandContext,ticketId:string,refundId:string,businessDate:string){
 if(!(await tx`select ticket_id from ticket_item_graph_receipts where ticket_id=${ticketId}`).length)return false;
 const original=await tx<{id:string;ticket_item_id:string;membership_id:string;base_cents:number;amount_cents:number;returned_base:number;returned_amount:number}[]>`select s.*,
  coalesce((select sum(base_cents) from ticket_item_commission_returns where commission_source_id=s.id),0)::int as returned_base,
  coalesce((select sum(amount_cents) from ticket_item_commission_returns where commission_source_id=s.id),0)::int as returned_amount
  from ticket_item_commission_sources s join ticket_item_settlements i on i.ticket_item_id=s.ticket_item_id where i.ticket_id=${ticketId} order by s.id`;
 const coverage=await tx<{ticket_item_id:string;service_cents:number;returned_service:number}[]>`select i.ticket_item_id,i.service_cents,
  coalesce((select sum(r.service_cents) from ticket_item_source_returns r join ticket_item_source_allocations a on a.id=r.allocation_id where a.ticket_item_id=i.ticket_item_id),0)::int as returned_service from ticket_item_settlements i where ticket_id=${ticketId}`;
 const plan=allocateItemCommissionReturns(original.map(r=>({id:r.id,itemId:r.ticket_item_id,membershipId:r.membership_id,baseCents:r.base_cents,amountCents:r.amount_cents,returnedBaseCents:r.returned_base,returnedAmountCents:r.returned_amount})),coverage.map(c=>({itemId:c.ticket_item_id,serviceCents:c.service_cents,returnedServiceCents:c.returned_service})));
 for(const p of plan)await tx`insert into ticket_item_commission_returns(org_id,location_id,ticket_refund_id,commission_source_id,base_cents,amount_cents) values(${ctx.orgId},${ctx.locationId},${refundId},${p.commissionSourceId},${p.baseCents},${p.amountCents})`;
 const staff=new Set(plan.map(p=>p.membershipId));for(const id of staff){const parts=plan.filter(p=>p.membershipId===id),base=parts.reduce((n,p)=>n+p.baseCents,0),amount=parts.reduce((n,p)=>n+p.amountCents,0);
  await tx`insert into earnings(org_id,location_id,membership_id,business_date,kind,amount_cents,base_cents,ticket_id,basis)
   values(${ctx.orgId},${ctx.locationId},${id},${businessDate},'commission',${-amount},${-base},${ticketId},${jsonb({refund:true,refundId,itemSourceGraph:true,itemReturns:parts})}::jsonb)`;}
 return true;
}
