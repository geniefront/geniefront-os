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
