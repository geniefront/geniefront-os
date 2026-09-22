import {expect,it} from 'vitest';
import {recurringWindows} from './bookingStaff';
const hours={thu:{open:'09:00',close:'22:00'}};
const settings={capacity:{use_recurring_staff:true},staff_booking_schedules:{b:{thu:{open:'12:00',close:'18:00'}},c:{thu:null}}};
it('defaults to business hours, honors custom shifts and days off',()=>{
 expect(recurringWindows(settings,hours,'2026-09-24',['a','b','c'],[])).toEqual([{id:'a',startMin:540,endMin:1320},{id:'b',startMin:720,endMin:1080}]);
});
it('date-specific time off overrides recurring hours',()=>{
 expect(recurringWindows(settings,hours,'2026-09-24',['a'],[{membership_id:'a',start_min:540,end_min:1320,status:'cancelled'}])).toEqual([]);
});
it('handles overnight shifts',()=>{
 expect(recurringWindows({capacity:{use_recurring_staff:true}},{thu:{open:'20:00',close:'02:00'}},'2026-09-24',['a'],[])[0]?.endMin).toBe(1560);
});

it('keeps staff breaks as separate availability windows',()=>{
 expect(recurringWindows({capacity:{use_recurring_staff:true}},{thu:{open:'09:00',close:'18:00',periods:[{open:'09:00',close:'12:00'},{open:'13:00',close:'18:00'}]}},'2026-09-24',['a'],[])).toEqual([{id:'a',startMin:540,endMin:720},{id:'a',startMin:780,endMin:1080}]);
});

it('time off overrides recurring and published shifts, preserves other staff, and ends inclusively',()=>{
 const config={...settings,staff_time_off:{a:[{startDate:'2026-09-24',endDate:'2026-09-25'}]}};
 expect(recurringWindows(config,hours,'2026-09-24',['a','b'],[{membership_id:'a',start_min:540,end_min:1000,status:'published'}])).toEqual([{id:'b',startMin:720,endMin:1080}]);
 expect(recurringWindows(config,{fri:{open:'09:00',close:'18:00'}},'2026-09-25',['a'],[])).toEqual([]);
 expect(recurringWindows(config,{sat:{open:'09:00',close:'18:00'}},'2026-09-26',['a'],[])).toEqual([{id:'a',startMin:540,endMin:1080}]);
});
it('clips the previous overnight shift at the start of a day off',()=>{
 expect(recurringWindows({capacity:{use_recurring_staff:true},staff_time_off:{a:[{startDate:'2026-09-25',endDate:'2026-09-25'}]}},{thu:{open:'20:00',close:'02:00'}},'2026-09-24',['a'],[])).toEqual([{id:'a',startMin:1200,endMin:1440}]);
});
