import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../queries/bookingStaff',()=>({loadBookingStaff:vi.fn()}));
import { loadBookingStaff } from '../queries/bookingStaff';
import { loadPartyAvailability } from './partyAvailability';
afterEach(() => vi.useRealTimers());
async function slots(mode: 'location' | 'staff', busy = false, split = false) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
  vi.mocked(loadBookingStaff).mockResolvedValue(mode==='location'?[{id:'employee',startMin:540,endMin:660,startsAt:new Date('2026-09-24T13:00:00Z'),endsAt:new Date('2026-09-24T15:00:00Z')}]:[]);
  const rows = [
    [{id:'service',duration_min:60,base_price_cents:6000,is_addon:false,buffer_before_min:0,buffer_after_min:0,staff_count:1}],
    [{id:'employee',name:{en:'Sophie'},avatar:null,bio:null}],
    [], [], // requirements, skills
    busy ? [{starts_at:'2026-09-24T13:00:00Z',ends_at:'2026-09-24T15:00:00Z',membership_id:'employee',group_key:'existing'}] : [],
  ];
  const tx = ((strings: TemplateStringsArray) => strings.join('').trim() === '' ? '' : Promise.resolve(rows.shift() ?? [])) as any;
  return loadPartyAvailability(tx, {
    locationId:'shop',timezone:'America/New_York',businessDayCutoff:'03:00',
    onlineBooking:{maxDaysAhead:60,minMinutesAhead:30,slotIntervalMinutes:15} as any,
    settings:{capacity:{booking_mode:mode,max_concurrent_per_slot:3}},
    businessHours:{thu:{open:'09:00',close:'11:00',...(split?{periods:[{open:'09:00',close:'09:30'},{open:'10:00',close:'11:00'}]}:{})}},
  }, {date:'2026-09-24',items:[{guestIndex:0,serviceId:'service',addonIds:[],staffId:null}]});
}
it('offers times during business hours for capacity mode without shifts', async () => {
  const result = await slots('location');
  expect(result.plans.map(p=>p.startsAt)).toEqual(['2026-09-24T13:00:00.000Z','2026-09-24T13:15:00.000Z','2026-09-24T13:30:00.000Z','2026-09-24T13:45:00.000Z','2026-09-24T14:00:00.000Z']);
});
it('still requires shifts in staff mode', async () => expect((await slots('staff')).plans).toEqual([]));
it('still excludes occupied staff in capacity mode', async () => expect((await slots('location',true)).plans).toEqual([]));

it('does not offer a booking spanning a closure even when staff work continuously',async()=>{expect((await slots('location',false,true)).plans.map(p=>p.startsAt)).toEqual(['2026-09-24T14:00:00.000Z']);});
