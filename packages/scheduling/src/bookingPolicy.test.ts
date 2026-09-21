import { describe, it, expect } from 'vitest';
import { readBookingPolicy, bookingLimits } from './bookingPolicy';
import { checkCapacity } from './capacity';

describe('booking capacity buffers', () => {
  const at = (h: number) => new Date(`2030-01-01T${String(h).padStart(2, '0')}:00:00Z`);
  const iv = { startsAt: at(10), endsAt: at(11) };
  it('defaults off and fails closed for malformed settings', () => {
    for (const settings of [null, {}, { capacity: { buffer_enabled: 'true', buffer_extra: 999 } }]) {
      expect(bookingLimits(readBookingPolicy(settings), 2, false).locationLimit).toBe(2);
    }
  });
  it('two staff plus one buffer admits the third but not the fourth', () => {
    const p = readBookingPolicy({ capacity: { buffer_enabled: true, buffer_extra: 1 } });
    const limit = bookingLimits(p, 2, false).locationLimit;
    const check = (count: number) => checkCapacity({ proposed: iv, staff: null,
      location: { maxConcurrentPerSlot: limit, onDutyBookableCount: 2, existing: Array(count).fill(iv) } });
    expect(check(2)).toEqual([]);
    expect(check(3)[0]?.code).toBe('LOCATION_OVER_CAPACITY');
  });
  it('normal buffer does not overbook a requested therapist', () => {
    const p = readBookingPolicy({ capacity: { buffer_enabled: true } });
    expect(bookingLimits(p, 2, true)).toEqual({ locationLimit: 2, staffLimit: 1 });
  });
  it('requested buffer works independently and remains bounded', () => {
    const p = readBookingPolicy({ capacity: { request_buffer_enabled: true, request_buffer_extra: 1 } });
    expect(bookingLimits(p, 2, true)).toEqual({ locationLimit: 3, staffLimit: 2 });
    expect(bookingLimits(p, 2, false)).toEqual({ locationLimit: 2, staffLimit: 1 });
  });
  it('a closed staff roster cannot be opened by a buffer', () => {
    const p = readBookingPolicy({ capacity: { buffer_enabled: true } });
    expect(bookingLimits(p, 0, false).locationLimit).toBe(0);
  });
});

it('scheduled voice offers assign another free staff member before using a pending slot',async()=>{
 const {findBookingOffers}=await import('./bookingOffers');
 const startsAt=new Date('2026-09-24T10:00:00Z'),endsAt=new Date('2026-09-24T11:00:00Z');
 const input={date:'2026-09-24',timezone:'UTC',openMin:600,closeMin:660,step:30,durationMin:60,earliest:new Date('2026-09-20'),partySize:1,assignStaff:true,preferredMembershipId:null,
 policy:readBookingPolicy({capacity:{booking_mode:'staff',buffer_enabled:true,buffer_extra:1}}),staff:['a','b'].map(id=>({id,startMin:600,endMin:660,maxConcurrent:1})),existing:[{startsAt,endsAt,membershipId:'a' as string|null,groupKey:'a'}]};
 expect(findBookingOffers(input)[0]?.membershipId).toBe('b');
 input.existing.push({startsAt,endsAt,membershipId:'b',groupKey:'b'});
 expect(findBookingOffers(input)[0]?.membershipId).toBeNull();
 expect(findBookingOffers({...input,preferredMembershipId:'a'})).toEqual([]);
 input.existing.push({startsAt,endsAt,membershipId:null,groupKey:'extra'});
 expect(findBookingOffers(input)).toEqual([]);
});
it('assigns separate staff for voice groups and leaves only the extra guest unassigned',async()=>{
 const {findBookingOffers}=await import('./bookingOffers');
 const base={date:'2026-09-24',timezone:'UTC',openMin:600,closeMin:660,step:30,durationMin:60,earliest:new Date('2026-09-20'),partySize:3,assignStaff:true,preferredMembershipId:null,policy:readBookingPolicy({capacity:{booking_mode:'staff',buffer_enabled:true,buffer_extra:1}}),staff:['a','b'].map(id=>({id,startMin:600,endMin:660,maxConcurrent:1})),existing:[]};
 expect(findBookingOffers(base)[0]?.membershipIds).toEqual(['a','b',null]);
 expect(findBookingOffers({...base,partySize:4})).toEqual([]);
});

it('automatic assignment is strictly opt-in',()=>{
 for(const settings of [null,{}, {capacity:{}},{capacity:{auto_assign:false}},{capacity:{auto_assign:'true'}}]) expect(readBookingPolicy(settings).autoAssign).toBe(false);
 expect(readBookingPolicy({capacity:{auto_assign:true}}).autoAssign).toBe(true);
});
