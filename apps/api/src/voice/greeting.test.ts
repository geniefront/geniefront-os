import {it,expect} from 'vitest';
import {isUnansweredGreeting} from './transcript';
it('excludes only a short positively identified opening, not failed booking inquiries',()=>{
 expect(isUnansweredGreeting(5,[{role:'assistant',text:'ZZ Massage, how can I help?'}])).toBe(true);
 expect(isUnansweredGreeting(5,[{role:'assistant',text:'How may I assist you?'}])).toBe(true);
 for(const role of ['user','system']) expect(isUnansweredGreeting(5,[{role,text:'ZZ Massage, how can I help?'}])).toBe(false);
 expect(isUnansweredGreeting(15,[{role:'assistant',text:'How can I help?'},{role:'user',text:'Book please.'}])).toBe(false);
 expect(isUnansweredGreeting(5,[{role:'assistant',text:'Your appointment is cancelled.'}])).toBe(false);
});
