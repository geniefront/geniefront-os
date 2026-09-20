import {expect,it} from 'vitest';
import {fitsShape} from './managedAvailability';
it('reschedules a named employee into either split shift, but never their break',()=>{
 const staff=[{membershipId:'s1',name:'Sophie',shiftStartMin:540,shiftEndMin:720,maxConcurrent:1,busy:[]},{membershipId:'s1',name:'Sophie',shiftStartMin:780,shiftEndMin:1080,maxConcurrent:1,busy:[]}];
 const shape=[{membershipId:'s1',offsetMin:0,durationMin:60}];
 const check=(minute:number)=>fitsShape(shape,minute,'2026-09-24','America/New_York',staff,new Map(staff.map(s=>[s.membershipId,s])),[],2,'booking',false);
 expect(check(600)).toBe(true);expect(check(840)).toBe(true);expect(check(690)).toBe(false);expect(check(720)).toBe(false);
});
