import {expect,it,vi} from 'vitest';
vi.mock('./handlers/appointment',()=>({lockBookingCapacity:vi.fn()}));
vi.mock('@gf/db',()=>({jsonb:JSON.stringify}));
import {SaveStaffTimeOff} from '@gf/contracts';
import {saveStaffTimeOff} from './staffTimeOff';
const id='11111111-1111-4111-8111-111111111111';
const input={membershipId:id,id,startDate:'2026-10-01',endDate:'2026-10-05',note:'Vacation',remove:false};
const ctx={locationId:'shop'};
it('rejects impossible, reversed and excessive date ranges',()=>{
 for(const range of [{startDate:'2026-02-30'},{endDate:'2026-09-30'},{endDate:'2028-10-01'}])expect(SaveStaffTimeOff.input.safeParse({...input,...range}).success).toBe(false);
 expect(SaveStaffTimeOff.input.safeParse(input).success).toBe(true);
});
it('does not write or audit when the staff member is outside the active shop',async()=>{
 const tx=vi.fn().mockResolvedValueOnce([]),audit=vi.fn();
 await expect(saveStaffTimeOff({input,ctx,tx,audit} as any)).rejects.toMatchObject({code:'NOT_FOUND'});
 expect(tx).toHaveBeenCalledTimes(1);expect(audit).not.toHaveBeenCalled();
});
it('does not write or audit if existing appointments conflict',async()=>{
 const tx=vi.fn().mockResolvedValueOnce([{id}]).mockResolvedValueOnce([{settings:{},timezone:'America/New_York'}]).mockResolvedValueOnce([{id:'appointment'}]);const audit=vi.fn();
 await expect(saveStaffTimeOff({input,ctx,tx,audit} as any)).rejects.toMatchObject({details:{reason:'staff_has_upcoming_appointments'}});
 expect(tx).toHaveBeenCalledTimes(3);expect(audit).not.toHaveBeenCalled();
});
it('removes only the selected leave and preserves other employees and dates',async()=>{
 const other={...input,id:'other'};const tx=vi.fn().mockResolvedValueOnce([{id}]).mockResolvedValueOnce([{settings:{staff_time_off:{[id]:[input,other],another:[other]}},timezone:'America/New_York'}]).mockResolvedValueOnce([]);const audit=vi.fn();
 await saveStaffTimeOff({input:{...input,remove:true},ctx,tx,audit} as any);
 const values=tx.mock.calls[2]!.slice(1);expect(values.some(v=>typeof v==='string'&&v.includes('another'))).toBe(true);
 expect(audit).toHaveBeenCalledWith(expect.objectContaining({after:[other]}));
});
