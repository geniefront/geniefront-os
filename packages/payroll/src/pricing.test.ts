import {it,expect} from 'vitest';
import {allocateCheckoutPriceDiscounts,membershipLineDiscountCents} from './pricing';
it('rounds membership prices per line with exact integer boundary values',()=>{
 expect(membershipLineDiscountCents(999,1000)).toBe(100);expect(membershipLineDiscountCents(5,1000)).toBe(1);
 expect(membershipLineDiscountCents(1_000_000_000,9999)).toBe(999_900_000);expect(membershipLineDiscountCents(999,10000)).toBe(999);
 expect(()=>membershipLineDiscountCents(3.5,1000)).toThrow();
});
it('keeps manual price benefits on the other uncovered lines with conserved deterministic pennies',()=>{
 const result=allocateCheckoutPriceDiscounts({items:[{id:'covered',totalCents:10000},{id:'member',totalCents:999},{id:'a',totalCents:333},{id:'b',totalCents:333}],
 coveredItemIds:new Set(['covered']),membershipDiscounts:new Map([['member',100]]),manualDiscountCents:101});
 expect(result).toEqual([{ticketItemId:'member',kind:'membership',originalCents:999,discountCents:100},
 {ticketItemId:'a',kind:'manual',originalCents:333,discountCents:51},{ticketItemId:'b',kind:'manual',originalCents:333,discountCents:50}]);
});
it('rejects double coverage, missing lines and discounts exceeding the remaining service prices',()=>{
 const base={items:[{id:'a',totalCents:100}],coveredItemIds:new Set<string>(),membershipDiscounts:new Map<string,number>(),manualDiscountCents:0};
 expect(()=>allocateCheckoutPriceDiscounts({...base,membershipDiscounts:new Map([['a',10]]),coveredItemIds:new Set(['a'])})).toThrow();
 expect(()=>allocateCheckoutPriceDiscounts({...base,membershipDiscounts:new Map([['wrong',10]])})).toThrow();
 expect(()=>allocateCheckoutPriceDiscounts({...base,membershipDiscounts:new Map([['a',10]]),manualDiscountCents:1})).toThrow();
 expect(()=>allocateCheckoutPriceDiscounts({...base,manualDiscountCents:101})).toThrow();
});
