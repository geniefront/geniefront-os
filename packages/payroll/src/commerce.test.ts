import { describe,it,expect } from 'vitest';
import { giftPurchaseRefundLimit,giftFaceForRefund,packageUnitValue,packageRefundUnits,commerceFingerprint,
  parsePackageUnitRanges,formatPackageUnitRanges,takePackageUnits,refundPackageUnits,restorePackageUnits,packageRangeValue,quoteAppointmentDeposit,allocateDepositServiceRefund,allocateAppointmentDepositByGuest,allocateDepositRefundByGuest } from './commerce';
describe('customer commerce integer allocation',()=>{
  it('refunds a selected guest without taking another guest deposit and keeps general partial-refund cents deterministic',()=>{
    const balances=[{guestIndex:1,amountCents:824},{guestIndex:0,amountCents:1176}];
    expect(allocateDepositRefundByGuest(balances,1176,[0])).toEqual([{guestIndex:0,amountCents:1176}]);
    expect(allocateDepositRefundByGuest(balances,800)).toEqual([{guestIndex:0,amountCents:470},{guestIndex:1,amountCents:330}]);
    expect(allocateDepositRefundByGuest([{guestIndex:4,amountCents:5},{guestIndex:1,amountCents:5},{guestIndex:0,amountCents:5}],7))
      .toEqual([{guestIndex:0,amountCents:3},{guestIndex:1,amountCents:2},{guestIndex:4,amountCents:2}]);
    expect(()=>allocateDepositRefundByGuest(balances,825,[1])).toThrow();
    expect(()=>allocateDepositRefundByGuest(balances,1,[0,0])).toThrow();
    expect(()=>allocateDepositRefundByGuest(balances,1,[2])).toThrow();
  });
  it('allocates the rounded group deposit by guest service value while conserving every cent',()=>{
    const split=allocateAppointmentDepositByGuest(2,[{groupKey:'a',priceCents:6003,guestIndices:[0]},{groupKey:'b',priceCents:4000,guestIndices:[1]}],2001);
    expect(split).toEqual({method:'service_price',guests:[{guestIndex:0,serviceTotalCents:6003,amountCents:1201},{guestIndex:1,serviceTotalCents:4000,amountCents:800}]});
    expect(allocateAppointmentDepositByGuest(2,[{groupKey:'legacy',priceCents:10003}],2001).guests.map(g=>g.amountCents)).toEqual([1001,1000]);
  });
  it('collapses multi-staff execution prices before splitting shared guest services',()=>{
    const rows=[34,33,33].map(priceCents=>({groupKey:'shared-service',priceCents,guestIndices:[1,0]}));
    expect(allocateAppointmentDepositByGuest(2,rows,51).guests).toEqual([
      {guestIndex:0,serviceTotalCents:50,amountCents:26},{guestIndex:1,serviceTotalCents:50,amountCents:25}]);
  });
  it('rejects inconsistent guest mappings and deposits above the service allocation',()=>{
    for(const rows of [[{groupKey:'x',priceCents:1,guestIndices:[2]}],[{groupKey:'x',priceCents:1,guestIndices:[0,0]}],
      [{groupKey:'x',priceCents:1,guestIndices:[0]},{groupKey:'x',priceCents:1,guestIndices:[1]}]])expect(()=>allocateAppointmentDepositByGuest(2,rows,1)).toThrow();
    expect(()=>allocateAppointmentDepositByGuest(2,[{groupKey:'x',priceCents:1}],2)).toThrow();
  });
  it('restores deposit service value across partial refunds while keeping cash tips out of the deposit',()=>{
    const paid=[9500,0,0,0,2000],paidTips:[number,number]=[1500,0];
    const tip=allocateDepositServiceRefund({paid,paidTips,refunded:[0,0,0,0,0],refundedTipCents:0,amountCents:1500,tipCents:1500});
    expect(tip).toEqual([1500,0,0,0,0]);
    const part=allocateDepositServiceRefund({paid,paidTips,refunded:tip,refundedTipCents:1500,amountCents:2000,tipCents:0});
    expect(part).toEqual([1600,0,0,0,400]);
    const refunded=tip.map((n,i)=>n+part[i]!);
    const rest=allocateDepositServiceRefund({paid,paidTips,refunded,refundedTipCents:1500,amountCents:8000,tipCents:0});
    expect(rest).toEqual([6400,0,0,0,1600]);
    expect(refunded.map((n,i)=>n+rest[i]!)).toEqual(paid);
    expect(()=>allocateDepositServiceRefund({paid,paidTips,refunded:paid,refundedTipCents:1500,amountCents:1,tipCents:0})).toThrow();
  });
  it('caps one booking deposit at its service subtotal, without multiplying by party size',()=>{
    expect(quoteAppointmentDeposit(10000,{fixedAmountCents:2000})).toBe(2000);
    expect(quoteAppointmentDeposit(1500,{fixedAmountCents:2000})).toBe(1500);
    expect(quoteAppointmentDeposit(0,{fixedAmountCents:2000})).toBe(0);
    expect(quoteAppointmentDeposit(10003,{percentBps:2000})).toBe(2001);
    expect(quoteAppointmentDeposit(1_000_000_000,{percentBps:9999})).toBe(999_900_000);
    expect(quoteAppointmentDeposit(7,{percentBps:5000})).toBe(4);
  });
  it('rejects ambiguous, fractional, negative, or over-100-percent deposit policies',()=>{
    for(const policy of [{},{fixedAmountCents:2000,percentBps:2000},{fixedAmountCents:0},{fixedAmountCents:2.5},
      {percentBps:-1},{percentBps:10001},{percentBps:0.5}])expect(()=>quoteAppointmentDeposit(10000,policy)).toThrow();
    expect(()=>quoteAppointmentDeposit(-1,{fixedAmountCents:20})).toThrow();
  });
  it('refunds $80/$100 cards by unused face value, never promotional face as cash',()=>{
    expect(giftPurchaseRefundLimit(8000,10000,7000)).toBe(5600);
    expect(giftFaceForRefund(5600,8000,10000)).toBe(7000);
    expect(giftPurchaseRefundLimit(0,10000,10000)).toBe(0);
  });
  it('keeps cent remainders deterministic and conserves the whole package purchase',()=>{
    const values=Array.from({length:10},(_,i)=>packageUnitValue(50003,10,i,1));
    expect(values.reduce((a,b)=>a+b,0)).toBe(50003);
    expect(packageRefundUnits(50003,10,9,45003)).toBe(9);
    expect(()=>packageRefundUnits(50003,10,9,45002)).toThrow();
  });
  it('does not divide unlimited packages by zero',()=>expect(()=>packageUnitValue(50000,0,0,1)).toThrow());
  it('finds whole-session refund allocations without iterating over huge quantities',()=>{
    expect(packageRefundUnits(50000,1_000_000_000,1_000_000_000,50000)).toBe(1_000_000_000);
  });
  it('handles large amounts with integer arithmetic',()=>{
    expect(giftPurchaseRefundLimit(1_000_000_000,1_000_000_000,999_999_999)).toBe(999_999_999);
    expect(giftFaceForRefund(999_999_999,1_000_000_000,1_000_000_000)).toBe(999_999_999);
  });
  it('canonicalizes keys without losing array order',()=>{
    expect(commerceFingerprint({b:2,a:{d:4,c:3}})).toBe(commerceFingerprint({a:{c:3,d:4},b:2}));
    expect(commerceFingerprint([1,2])).not.toBe(commerceFingerprint([2,1]));
  });
  it('preserves purchased cent allocation through consume, refund, restore, and another consume',()=>{
    const original=parsePackageUnitRanges('{[0,10)}',10),price=50003;
    const first=takePackageUnits(price,10,original,1);
    const second=takePackageUnits(price,10,first.remaining,2);
    const refunded=refundPackageUnits(price,10,second.remaining,5001);
    const returned=restorePackageUnits(refunded.remaining,first.taken);
    const rest=takePackageUnits(price,10,returned,7);
    expect(first.valueCents+second.valueCents+refunded.valueCents+rest.valueCents-first.valueCents).toBe(price);
    expect(formatPackageUnitRanges(rest.remaining)).toBe('{}');
    expect(packageRangeValue(price,10,returned)).toBe(rest.valueCents);
    expect(()=>restorePackageUnits(returned,first.taken)).toThrow();
  });
  it('represents a billion sessions compactly and rejects malformed or overlapping ranges',()=>{
    const all=parsePackageUnitRanges('{[0,1000000000)}',1_000_000_000);
    expect(takePackageUnits(50000,1_000_000_000,all,1_000_000_000).valueCents).toBe(50000);
    expect(()=>parsePackageUnitRanges('{[0,5),[4,8)}',10)).toThrow();
    expect(()=>parsePackageUnitRanges('{[-1,5)}',10)).toThrow();
  });
});
