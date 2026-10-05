import {it,expect} from 'vitest';
import {balancedComponentAllocation,allocateSelectedItemReturns,allocateSourceItemReturns,allocateItemCommissionReturns,type ItemSourceBalance,type ItemCommissionBalance} from './itemSources';
const cell=(id:string,sourceId:string,itemId:string,serviceCents:number,taxCents=0,feeCents=0):ItemSourceBalance=>({id,sourceId,itemId,serviceCents,taxCents,feeCents,returnedServiceCents:0,returnedTaxCents:0,returnedFeeCents:0});
it('preserves both original source and item margins even for single-cent remainders',()=>{
 for(let n=0;n<50;n++){const rows=[n,37,63],cols=[13,17,n+70],matrix=balancedComponentAllocation(rows,cols);expect(matrix.map(c=>c.reduce((s,v)=>s+v,0))).toEqual(cols);expect(rows.map((_,i)=>matrix.reduce((s,c)=>s+c[i]!,0))).toEqual(rows);}
 expect(()=>balancedComponentAllocation([1],[2])).toThrow('item_source_margins_mismatch');
});
it('returns one selected package execution without returning another item cash or fees',()=>{
 const cells=[cell('a','package','one',10000),cell('b','cash','one',0,0,100),cell('c','cash','two',20000,1300,200)];
 expect(allocateSelectedItemReturns(cells,[{itemId:'one',amountCents:10000}])).toEqual([{allocationId:'a',sourceId:'package',itemId:'one',serviceCents:10000,taxCents:0,feeCents:0}]);
 expect(allocateSelectedItemReturns(cells,[{itemId:'one',amountCents:10100}]).reduce((n,r)=>n+r.feeCents,0)).toBe(100);
 expect(()=>allocateSelectedItemReturns(cells,[{itemId:'one',amountCents:10101}])).toThrow('item_refund_exceeds_original');
});
it('keeps amount-only source returns within the original item service, tax and fee components',()=>{
 const cells=[cell('a','gift','one',3000,300,30),cell('b','gift','two',6000,600,60)];
 const rows=allocateSourceItemReturns(cells,[{sourceId:'gift',serviceCents:4500,taxCents:0,feeCents:0}]);expect(rows.map(r=>r.serviceCents)).toEqual([1500,3000]);expect(rows.every(r=>r.taxCents===0&&r.feeCents===0)).toBe(true);
});
it('claws back the selected original funded item rather than a ticket-wide catalog ratio',()=>{
 const rows:ItemCommissionBalance[]=[{id:'a',itemId:'pkg',membershipId:'staff',baseCents:5000,amountCents:2500,returnedBaseCents:0,returnedAmountCents:0},{id:'b',itemId:'cash',membershipId:'staff',baseCents:20000,amountCents:10000,returnedBaseCents:0,returnedAmountCents:0}];
 expect(allocateItemCommissionReturns(rows,[{itemId:'pkg',serviceCents:10000,returnedServiceCents:10000},{itemId:'cash',serviceCents:20000,returnedServiceCents:0}])).toEqual([{commissionSourceId:'a',itemId:'pkg',membershipId:'staff',baseCents:5000,amountCents:2500}]);
});
it('never issues a negative or excessive staff correction over repeated cent-sized service returns',()=>{
 const rows:ItemCommissionBalance[]=[{id:'a',itemId:'one',membershipId:'a',baseCents:2,amountCents:1,returnedBaseCents:0,returnedAmountCents:0},{id:'b',itemId:'one',membershipId:'b',baseCents:5,amountCents:2,returnedBaseCents:0,returnedAmountCents:0}];
 for(let amount=1;amount<=11;amount++){const plan=allocateItemCommissionReturns(rows,[{itemId:'one',serviceCents:11,returnedServiceCents:amount}]);for(const p of plan){expect(p.baseCents).toBeGreaterThanOrEqual(0);expect(p.amountCents).toBeGreaterThanOrEqual(0);const r=rows.find(r=>r.id===p.commissionSourceId)!;r.returnedBaseCents+=p.baseCents;r.returnedAmountCents+=p.amountCents;}}
 expect(rows.map(r=>[r.returnedBaseCents,r.returnedAmountCents])).toEqual([[2,1],[5,2]]);
});
