import {describe,it,expect} from 'vitest';
import {membershipCalendarMonth,membershipBenefitPeriods} from './membershipPeriods';
describe('paid membership calendar benefits',()=>{
 it('anchors Jan 31 independently through February, leap years and March',()=>{
  const start=new Date('2024-01-31T15:12:45Z');
  expect(membershipCalendarMonth(start,1,'America/New_York').toISOString()).toBe('2024-02-29T15:12:45.000Z');
  expect(membershipCalendarMonth(start,2,'America/New_York').toISOString()).toBe('2024-03-31T14:12:45.000Z');
  expect(membershipCalendarMonth(start,12,'America/New_York').toISOString()).toBe('2025-01-31T15:12:45.000Z');
 });
 it('moves spring gaps forward and chooses the earlier autumn occurrence',()=>{
  expect(membershipCalendarMonth(new Date('2026-02-08T07:30:00Z'),1,'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  expect(membershipCalendarMonth(new Date('2026-10-01T05:30:00Z'),1,'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
 });
 it('creates 12 contiguous annual batches within actual paid coverage and apportions every cent once',()=>{
  const result=membershipBenefitPeriods({startsAt:'2024-01-31T15:12:45Z',endsAt:'2025-01-31T15:12:45Z',cadence:'year',benefitFrequency:'month',amountCents:99901,timezone:'America/New_York'});
  expect(result).toHaveLength(12);expect(result[0]!.valueCents).toBe(8326);expect(result.slice(1).every(p=>p.valueCents===8325)).toBe(true);
  expect(result.reduce((sum,p)=>sum+p.valueCents,0)).toBe(99901);
  expect(result[0]!.startsAt).toBe('2024-01-31T15:12:45.000Z');expect(result[11]!.endsAt).toBe('2025-01-31T15:12:45.000Z');
  expect(result.slice(1).every((p,i)=>p.startsAt===result[i]!.endsAt)).toBe(true);
 });
 it('uses one monthly or configured annual batch and rejects unpaid/malformed coverage',()=>{
  const input={startsAt:'2026-01-31T10:00:00Z',endsAt:'2026-02-28T10:00:00Z',cadence:'month' as const,benefitFrequency:'month' as const,amountCents:9900,timezone:'Asia/Seoul'};
  expect(membershipBenefitPeriods(input)).toHaveLength(1);
  expect(membershipBenefitPeriods({...input,cadence:'year',benefitFrequency:'billing_period',endsAt:'2027-01-31T10:00:00Z'})).toHaveLength(1);
  expect(()=>membershipBenefitPeriods({...input,amountCents:0})).toThrow();
  expect(()=>membershipBenefitPeriods({...input,endsAt:input.startsAt})).toThrow();
 });
});
