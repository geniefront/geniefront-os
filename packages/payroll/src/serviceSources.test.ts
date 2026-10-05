import {it,expect} from 'vitest';import {allocateSourceRefund,type RefundSourceBalance} from './serviceSources';
const balance=(id:string,kind:RefundSourceBalance['kind'],amountCents:number,tipCents=0):RefundSourceBalance=>({id,kind,amountCents,tipCents,returnedCents:0,returnedTipCents:0});
it('conserves all original sources and returns tips only to the actually funded money channels',()=>{
 const rows=[balance('a','package',10000),balance('b','membership',10000),balance('c','deposit',2000),balance('d','gift_card',3000),balance('e','store_credit',1000),balance('f','cash',2000,1000),balance('g','card',2000,1000),balance('h','external',1000)];
 const full=allocateSourceRefund(rows,31000,2000,'original_payment');expect(full.reduce((s,r)=>s+r.amountCents,0)).toBe(31000);expect(full.filter(s=>s.tipCents).map(s=>s.kind)).toEqual(['cash','card']);expect(full.find(s=>s.kind==='package')).toMatchObject({amountCents:10000,destination:'package'});
});
it('conserves cents through repeated partial returns without exceeding any original source',()=>{
 const rows=[balance('a','package',10003),balance('b','gift_card',7001),balance('c','cash',4027,1011)];
 for(const [amount,tip] of [[7000,333],[9000,444],[5031,234]] as const){const plan=allocateSourceRefund(rows,amount,tip,'original_payment');for(const p of plan){const row=rows.find(s=>s.id===p.sourceId)!;row.returnedCents+=p.amountCents;row.returnedTipCents+=p.tipCents;}}
 expect(rows.map(s=>s.returnedCents)).toEqual(rows.map(s=>s.amountCents));expect(()=>allocateSourceRefund(rows,1,0,'original_payment')).toThrow();
});
it('rejects conversion of service rights or stored assets into newly minted cash/credit',()=>{
 for(const kind of ['package','membership','deposit','gift_card','store_credit'] as const)for(const method of ['cash','store_credit'] as const)expect(()=>allocateSourceRefund([balance('a',kind,10000)],5000,0,method)).toThrow('prepaid_refund_requires_original_method');
 expect(allocateSourceRefund([balance('a','card',1000)],1000,0,'cash')[0]).toMatchObject({kind:'card',destination:'cash'});
});
it('returns stored service, tax and fee components without charging uncovered tax to an untaxed service right',()=>{
 const rows=[{...balance('a','package',10000),serviceCents:10000,taxCents:0,feeCents:0},
  {...balance('b','card',1200,100),serviceCents:1000,taxCents:75,feeCents:25}];
 const first=allocateSourceRefund(rows,5500,0,'original_payment',{serviceCents:5500,taxCents:0,feeCents:0});expect(first.map(p=>[p.kind,p.serviceCents,p.taxCents])).toEqual([['package',5000,0],['card',500,0]]);
 const tax=allocateSourceRefund(rows,75,0,'original_payment',{serviceCents:0,taxCents:75,feeCents:0});expect(tax).toHaveLength(1);expect(tax[0]).toMatchObject({kind:'card',taxCents:75});
});
it('keeps tip channel reversals consistent with cumulative original tip allocations',()=>{
 const rows=[balance('a','cash',1005,5),balance('b','card',1002,2)];
 for(let i=0;i<2;i++){for(const part of allocateSourceRefund(rows,1,1,'original_payment')){const r=rows.find(s=>s.id===part.sourceId)!;r.returnedCents+=part.amountCents;r.returnedTipCents+=part.tipCents;}}
 expect(rows.map(r=>r.returnedTipCents)).toEqual([1,1]);
});
