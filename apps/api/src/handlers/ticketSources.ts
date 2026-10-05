import {createHash} from 'node:crypto';
import {AppError,ERROR_CODES,type CommandContext} from '@gf/contracts';
import {allocateSourceRefund,allocateSourceItemReturns,allocateSelectedItemReturns,largestRemainderSplit,formatPackageUnitRanges,parsePackageUnitRanges,restorePackageUnits,packageRangeCount,type SettlementSourceKind,type ItemSourceReturn} from '@gf/payroll';
import {jsonb} from '@gf/db';import type {Tx} from '../commerce/model';
import {availablePackageUnits} from './packageUnits';
import {recordTicketItemGraph,ticketItemSourceBalances,ticketRefundItemOptions} from './ticketItemSources';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
export type TicketSource={id:string;kind:SettlementSourceKind;amount_cents:number;tip_cents:number;returned:number;returned_tip:number;service_cents:number;tax_cents:number;fee_cents:number;returned_service:number;returned_tax:number;returned_fee:number;
 payment_id:string|null;credit_ledger_id:string|null;membership_redemption_id:string|null;package_redemption_id:string|null;item_ids:string[]};
type RefundTotals={total_cents:number;tax_cents:number;tip_cents:number;surcharge_cents:number;service_charge_cents:number};
export function ticketRefundComponents(ticket:RefundTotals,already:{service:number;tax:number;fee:number;tip:number},amount:number,tip:number){
 const serviceTotal=ticket.total_cents-ticket.tax_cents-ticket.tip_cents-ticket.surcharge_cents-ticket.service_charge_cents;
 let remaining=amount-tip;
 const serviceCents=Math.min(remaining,Math.max(0,serviceTotal-already.service));remaining-=serviceCents;
 const taxCents=Math.min(remaining,Math.max(0,ticket.tax_cents-already.tax));remaining-=taxCents;
 const feeCents=Math.min(remaining,Math.max(0,ticket.surcharge_cents+ticket.service_charge_cents-already.fee));remaining-=feeCents;
 if(tip>amount||remaining>0||tip>ticket.tip_cents-already.tip)invalid('refund_components_exceed_remaining');
 return {serviceTotal,serviceCents,taxCents,feeCents};
}
export function ticketRefundReview(ticketId:string,amount:number,tip:number,method:string,components:{serviceCents:number;taxCents:number;feeCents:number},allocation:Awaited<ReturnType<typeof ticketSourceRefundPlan>>){
 const destinations=new Map<Exclude<SettlementSourceKind,'external'>,number>();for(const p of allocation.plan){const kind=p.destination as Exclude<SettlementSourceKind,'external'>;destinations.set(kind,(destinations.get(kind)??0)+p.amountCents);}
 const reviewHash=createHash('sha256').update(JSON.stringify({version:2,ticketId,amount,tip,method,components:allocation.components,sources:allocation.sources,plan:allocation.plan,itemPlan:allocation.itemPlan})).digest('hex');
 return {reviewHash,amountCents:amount,tipCents:tip,taxCents:allocation.components.taxCents,feeCents:allocation.components.feeCents,destinations:[...destinations].sort(([a],[b])=>a.localeCompare(b)).map(([kind,amountCents])=>({kind,amountCents})),...allocation.itemOptions};
}
/** Called inside the existing ticket transaction. Original ledger facts, never current catalog prices, define sources. */
export async function recordTicketSources(tx:Tx,ctx:CommandContext,ticketId:string,stage:'service'|'tip'|'combined'|'legacy'){
 if(stage==='legacy'&&(await tx`select id from ticket_source_receipts where ticket_id=${ticketId}`).length)return;
 const [ticket]=await tx<{total_cents:number;tip_cents:number;refund_cents:number;tax_cents:number;surcharge_cents:number;service_charge_cents:number}[]>`select total_cents,tip_cents,refund_cents,tax_cents,surcharge_cents,service_charge_cents from tickets where id=${ticketId}`;if(!ticket)invalid('source_ticket_missing');
 type Descriptor={kind:SettlementSourceKind;ref:string;amount:number;tip:number;fund:number|null;items:string[];payment?:string;credit?:string;member?:string;pkg?:string;baseline:number;baselineTip:number;service?:number;tax?:number;fee?:number;baselineService?:number;baselineTax?:number;baselineFee?:number};
 const descriptors:Descriptor[]=[];
 const payments=await tx<{id:string;method:SettlementSourceKind;amount_cents:number;tip_cents:number}[]>`select * from payments where ticket_id=${ticketId} and method in('cash','card','external','deposit') and amount_cents>0 order by id`;
 for(const p of payments)descriptors.push({kind:p.method,ref:p.id,payment:p.id,amount:p.amount_cents,tip:p.tip_cents,fund:p.amount_cents,items:[],baseline:0,baselineTip:0});
 const credits=await tx<{id:string;kind:'gift_card'|'store_credit';amount_cents:number}[]>`select id,kind,amount_cents from customer_credit_ledger where ticket_id=${ticketId} and kind in('gift_card','store_credit') and unit='cents' and entry='redeem' and amount_cents<0 order by id`;
 for(const c of credits)descriptors.push({kind:c.kind,ref:c.id,credit:c.id,amount:-c.amount_cents,tip:0,fund:null,items:[],baseline:0,baselineTip:0});
 const members=await tx<{id:string;ticket_item_id:string;covered_cents:number;value_cents:number}[]>`select id,ticket_item_id,covered_cents,value_cents from customer_membership_ledger where ticket_id=${ticketId} and entry='redeem' order by id`;
 for(const m of members)descriptors.push({kind:'membership',ref:m.id,member:m.id,amount:m.covered_cents,tip:0,fund:-m.value_cents,items:[m.ticket_item_id],baseline:0,baselineTip:0});
 const packages=await tx<{id:string;package_id:string;quantity:number;value_cents:number;total_sessions:number;meta:{ticketItemIds?:string[];unitApplications?:Array<{redemptionId:string;itemIds:string[]}>}}[]>`
  select p.id,p.package_id,p.quantity,p.value_cents,cp.total_sessions,c.meta from customer_package_ledger p join customer_packages cp on cp.id=p.package_id
  join customer_credit_ledger c on c.ticket_id=p.ticket_id and c.subject_id=p.package_id and c.kind='package' and c.entry='redeem'
  where p.ticket_id=${ticketId} and p.entry='redeem' order by p.id`;
 for(const p of packages){
  const items=p.meta.unitApplications?.find(u=>u.redemptionId===p.id)?.itemIds??(p.quantity===-1?p.meta.ticketItemIds:undefined);
  if(!items?.length)invalid('historical_package_sources_need_review');
  const [covered]=await tx<{n:number;amount:number}[]>`select count(*)::int as n,coalesce(sum(total_cents),0)::int as amount from ticket_items where ticket_id=${ticketId} and id=any(${items}::uuid[])`;
  if(covered!.n!==items.length||covered!.amount<=0)invalid('package_source_items_missing');
  descriptors.push({kind:'package',ref:p.id,pkg:p.id,amount:covered!.amount,tip:0,fund:p.total_sessions===0?null:-p.value_cents,items,baseline:0,baselineTip:0});
 }
 if(descriptors.reduce((s,d)=>s+d.amount,0)!==ticket.total_cents||descriptors.reduce((s,d)=>s+d.tip,0)!==ticket.tip_cents)invalid('original_settlement_sources_incomplete');
 const monetary=descriptors.filter(d=>d.kind!=='package'&&d.kind!=='membership'),taxParts=ticket.tax_cents?largestRemainderSplit(ticket.tax_cents,monetary.map(d=>d.amount-d.tip),{zeroWeights:'throw'}):monetary.map(()=>0);
 const feeTotal=ticket.surcharge_cents+ticket.service_charge_cents,feeParts=feeTotal?largestRemainderSplit(feeTotal,monetary.map((d,i)=>d.amount-d.tip-taxParts[i]!),{zeroWeights:'throw'}):monetary.map(()=>0);
 for(const d of descriptors){const i=monetary.indexOf(d);d.tax=i<0?0:taxParts[i]!;d.fee=i<0?0:feeParts[i]!;d.service=d.amount-d.tip-d.tax-d.fee;}
 if(stage==='legacy'&&ticket.refund_cents>0){
  const refunds=await tx<{method:string;amount_cents:number;tip_cents:number;cash_cents:number;card_cents:number;gift_card_cents:number;customer_credit_cents:number;deposit_cents:number;membership_cents:number;tax_cents:number;fee_cents:number}[]>`select * from ticket_refunds where ticket_id=${ticketId} order by created_at,id`;
  if(refunds.some(r=>r.method!=='original_payment')&&descriptors.some(d=>!['cash','card','external'].includes(d.kind)))invalid('historical_refund_sources_need_review');
  const apply=(rows:Descriptor[],amount:number,tips:number)=>{if(!amount)return;const tipShares=tips?largestRemainderSplit(tips,rows.map(d=>d.tip-d.baselineTip),{zeroWeights:'throw'}):rows.map(()=>0);
   const money=amount-tips?largestRemainderSplit(amount-tips,rows.map(d=>d.amount-d.tip-d.baseline+d.baselineTip),{zeroWeights:'throw'}):rows.map(()=>0);
   for(const [i,d] of rows.entries()){d.baseline+=money[i]!+tipShares[i]!;d.baselineTip+=tipShares[i]!;}};
  for(const r of refunds){
   if(r.method!=='original_payment'){apply(descriptors,r.amount_cents,r.tip_cents);continue;}
   const tipRows=descriptors.filter(d=>d.kind==='cash'||d.kind==='card'||d.kind==='external');
   const tipParts=r.tip_cents?largestRemainderSplit(r.tip_cents,tipRows.map(d=>d.tip-d.baselineTip),{zeroWeights:'throw'}):tipRows.map(()=>0);
   const cashTip=tipRows.reduce((s,d,i)=>s+(d.kind==='cash'?tipParts[i]!:0),0),cardTip=r.tip_cents-cashTip;
   apply(descriptors.filter(d=>d.kind==='cash'),r.cash_cents,cashTip);apply(descriptors.filter(d=>d.kind==='card'||d.kind==='external'),r.card_cents,cardTip);
   for(const [kind,value] of [['gift_card',r.gift_card_cents],['store_credit',r.customer_credit_cents],['deposit',r.deposit_cents],['membership',r.membership_cents]] as const)apply(descriptors.filter(d=>d.kind===kind),value,0);
  }
  const taxTotal=refunds.reduce((n,r)=>n+r.tax_cents,0),feeTotal=refunds.reduce((n,r)=>n+r.fee_cents,0);
  const taxes=taxTotal?largestRemainderSplit(taxTotal,descriptors.map(d=>Math.min(d.tax!,d.baseline-d.baselineTip)),{zeroWeights:'throw'}):descriptors.map(()=>0);
  const fees=feeTotal?largestRemainderSplit(feeTotal,descriptors.map((d,i)=>Math.min(d.fee!,d.baseline-d.baselineTip-taxes[i]!)),{zeroWeights:'throw'}):descriptors.map(()=>0);
  for(const [i,d] of descriptors.entries()){d.baselineTax=taxes[i]!;d.baselineFee=fees[i]!;d.baselineService=d.baseline-d.baselineTip-taxes[i]!-fees[i]!;if(d.baselineService>d.service!)invalid('historical_refund_components_need_review');}
  if(descriptors.reduce((s,d)=>s+d.baseline,0)!==ticket.refund_cents)invalid('historical_refund_sources_need_review');
 }
 for(const d of descriptors)await tx`insert into ticket_settlement_sources(org_id,location_id,ticket_id,source_key,kind,payment_id,credit_ledger_id,membership_redemption_id,package_redemption_id,amount_cents,tip_cents,funded_value_cents,item_ids,baseline_returned_cents,baseline_tip_cents,service_cents,tax_cents,fee_cents,baseline_service_cents,baseline_tax_cents,baseline_fee_cents)
  values(${ctx.orgId},${ctx.locationId},${ticketId},${`${d.kind}:${d.ref}`},${d.kind},${d.payment??null},${d.credit??null},${d.member??null},${d.pkg??null},${d.amount},${d.tip},${d.fund},${d.items}::uuid[],${d.baseline},${d.baselineTip},${d.service!},${d.tax!},${d.fee!},${d.baselineService??0},${d.baselineTax??0},${d.baselineFee??0}) on conflict(ticket_id,source_key) do nothing`;
 const [count]=await tx<{n:number}[]>`select count(*)::int as n from ticket_settlement_sources where ticket_id=${ticketId}`;
 await tx`insert into ticket_source_receipts(org_id,location_id,ticket_id,stage,origin,total_cents,tip_cents,source_count)
  values(${ctx.orgId},${ctx.locationId},${ticketId},${stage},${stage==='legacy'?'legacy_projection':'checkout'},${ticket.total_cents},${ticket.tip_cents},${count!.n}) on conflict(ticket_id,stage) do nothing`;
}
export async function ticketSourceRefundPlan(tx:Tx,ctx:CommandContext,ticketId:string,amount:number,tip:number,method:'cash'|'store_credit'|'original_payment',components:{serviceCents:number;taxCents:number;feeCents:number},selections?:readonly {ticketItemId:string;amountCents:number}[]){
 await recordTicketSources(tx,ctx,ticketId,'legacy');
 const sources=await tx<TicketSource[]>`select s.*,s.baseline_returned_cents+coalesce((select sum(amount_cents) from ticket_source_refunds where source_id=s.id),0)::int as returned,
  s.baseline_tip_cents+coalesce((select sum(tip_cents) from ticket_source_refunds where source_id=s.id),0)::int as returned_tip,
  s.baseline_service_cents+coalesce((select sum(service_cents) from ticket_source_refunds where source_id=s.id),0)::int as returned_service,
  s.baseline_tax_cents+coalesce((select sum(tax_cents) from ticket_source_refunds where source_id=s.id),0)::int as returned_tax,
  s.baseline_fee_cents+coalesce((select sum(fee_cents) from ticket_source_refunds where source_id=s.id),0)::int as returned_fee
  from ticket_settlement_sources s where ticket_id=${ticketId} order by s.id`;
 const graph=await recordTicketItemGraph(tx,ctx,ticketId,'legacy_projection'),cells=graph?await ticketItemSourceBalances(tx,ticketId):[];
 const balances=sources.map(s=>({id:s.id,kind:s.kind,amountCents:s.amount_cents,tipCents:s.tip_cents,returnedCents:s.returned,returnedTipCents:s.returned_tip,serviceCents:s.service_cents,taxCents:s.tax_cents,feeCents:s.fee_cents,returnedServiceCents:s.returned_service,returnedTaxCents:s.returned_tax,returnedFeeCents:s.returned_fee}));
 try{
  let plan:ReturnType<typeof allocateSourceRefund>,itemPlan:ItemSourceReturn[];
  if(selections){if(!graph)invalid('historical_item_refund_needs_review');itemPlan=allocateSelectedItemReturns(cells,selections.map(s=>({itemId:s.ticketItemId,amountCents:s.amountCents})));
   components={serviceCents:itemPlan.reduce((n,p)=>n+p.serviceCents,0),taxCents:itemPlan.reduce((n,p)=>n+p.taxCents,0),feeCents:itemPlan.reduce((n,p)=>n+p.feeCents,0)};
   if(components.serviceCents+components.taxCents+components.feeCents+tip!==amount)invalid('selected_refund_amount_mismatch');
   plan=tip?allocateSourceRefund(balances,tip,tip,method,{serviceCents:0,taxCents:0,feeCents:0}):[];
   for(const part of itemPlan){const source=sources.find(s=>s.id===part.sourceId)!;
    if(method!=='original_payment'&&!['cash','card','external'].includes(source.kind))invalid(source.kind==='membership'?'membership_refund_requires_original_method':source.kind==='deposit'?'deposit_refund_requires_original_method':'prepaid_refund_requires_original_method');
    let slice=plan.find(p=>p.sourceId===part.sourceId);if(!slice){slice={sourceId:source.id,kind:source.kind,amountCents:0,tipCents:0,serviceCents:0,taxCents:0,feeCents:0,destination:method==='cash'?'cash':method==='store_credit'?'store_credit':source.kind==='external'?'card':source.kind};plan.push(slice);}
    slice.serviceCents+=part.serviceCents;slice.taxCents+=part.taxCents;slice.feeCents+=part.feeCents;slice.amountCents+=part.serviceCents+part.taxCents+part.feeCents;
   }
   plan.sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
  }else{plan=allocateSourceRefund(balances,amount,tip,method,components);itemPlan=graph?allocateSourceItemReturns(cells,plan):[];}
  return {sources,plan,itemPlan,components,itemOptions:await ticketRefundItemOptions(tx,ctx,ticketId)};
 }catch(e){if(e instanceof AppError)throw e;if(method!=='original_payment'&&e instanceof Error&&e.message==='prepaid_refund_requires_original_method'){
   if(sources.some(s=>s.kind==='membership'&&s.returned<s.amount_cents))invalid('membership_refund_requires_original_method');if(sources.some(s=>s.kind==='deposit'&&s.returned<s.amount_cents))invalid('deposit_refund_requires_original_method');}
  return invalid(e instanceof Error?e.message:'source_refund_invalid');}
}
export async function recordTicketSourceRefunds(tx:Tx,ctx:CommandContext,refundId:string,plan:ReturnType<typeof allocateSourceRefund>){
 for(const p of plan)await tx`insert into ticket_source_refunds(org_id,location_id,ticket_refund_id,source_id,amount_cents,tip_cents,destination,service_cents,tax_cents,fee_cents)
  values(${ctx.orgId},${ctx.locationId},${refundId},${p.sourceId},${p.amountCents},${p.tipCents},${p.destination},${p.serviceCents},${p.taxCents},${p.feeCents})`;
}
/** Only complete original coverage restores a whole purchased unit; returned/expired funding never becomes spendable. */
export async function restoreTicketPackages(tx:Tx,ctx:CommandContext,ticketId:string,refundId:string,sources:TicketSource[],plan:ReturnType<typeof allocateSourceRefund>){
 for(const slice of plan.filter(p=>p.kind==='package')){
  const source=sources.find(s=>s.id===slice.sourceId)!;
  if(source.returned+slice.amountCents<source.amount_cents)continue;
  const [original]=await tx<{id:string;package_id:string;quantity:number;value_cents:number;unit_ranges:string}[]>`select id,package_id,quantity,value_cents,unit_ranges from customer_package_ledger where id=${source.package_redemption_id!}`;if(!original)invalid('package_return_source_missing');
  if((await tx`select id from customer_package_ledger where reversal_of_id=${original.id} and entry='restore'`).length)invalid('package_unit_already_restored');
  const [pkg]=await tx<{id:string;customer_id:string;total_sessions:number;remaining_sessions:number;reserved_sessions:number;available_units:string;status:string;expired:boolean;fully_refunded:boolean;purchase_snapshot:{unitAllocationVersion?:number}|null}[]>`
   select cp.*,cp.expires_at<=now() as expired,exists(select 1 from commerce_payments p where p.order_id=cp.purchase_order_id and p.status='refunded') as fully_refunded from customer_packages cp where cp.id=${original.package_id} for update`;
  if(!pkg||!original.unit_ranges&&pkg.total_sessions>0)invalid('historical_package_units_need_review');
  const units=-original.quantity,ranges=parsePackageUnitRanges(original.unit_ranges??'{}',pkg.total_sessions);
  if(pkg.total_sessions>0&&packageRangeCount(ranges)!==units)invalid('package_return_units_mismatch');
  const stopped=pkg.expired||pkg.fully_refunded||pkg.total_sessions===0&&pkg.status==='void';
  const available=pkg.total_sessions>0?restorePackageUnits(availablePackageUnits(pkg),ranges):[],next=pkg.total_sessions>0?pkg.remaining_sessions+units:pkg.remaining_sessions;
  await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,ticket_id,reference,reversal_of_id,unit_ranges)
   values(${ctx.orgId},${ctx.locationId},${pkg.id},'restore',${units},${-original.value_cents},${ticketId},${`service-refund:${source.id}`},${original.id},${original.unit_ranges??'{}'}::int4multirange)`;
  if(stopped)await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,ticket_id,reference,unit_ranges)
   values(${ctx.orgId},${ctx.locationId},${pkg.id},'expire',${-units},${original.value_cents},${ticketId},${`expire:service-refund:${source.id}`},${original.unit_ranges??'{}'}::int4multirange)`;
  await tx`update customer_packages set remaining_sessions=${stopped?pkg.remaining_sessions:next},available_units=${stopped?pkg.available_units:formatPackageUnitRanges(available)}::int4multirange,
   status=${stopped?pkg.status:'active'},updated_at=now() where id=${pkg.id}`;
  await tx`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,customer_id,entry,amount_cents,balance_after_cents,ticket_id,reason,actor_membership_id,idem_key,meta)
   values(${ctx.orgId},${ctx.locationId},'package',${pkg.id},${pkg.customer_id},'refund',${units},${stopped?pkg.remaining_sessions:next},${ticketId},'original_service_return',${ctx.membershipId},${`service-return:${source.id}`},${jsonb({refundId,redemptionId:original.id,returnedUnavailable:stopped,unit:'sessions'})}::jsonb)`;
 }
}
