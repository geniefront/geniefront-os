import {it,expect} from 'vitest';
import {isUnansweredGreeting} from './transcript';
it('excludes only a short positively identified opening, not failed booking inquiries',()=>{
 expect(isUnansweredGreeting(5,[{role:'assistant',text:'ZZ Massage, how can I help?'}])).toBe(true);
 expect(isUnansweredGreeting(5,[{role:'assistant',text:'How may I assist you?'}])).toBe(true);
 for(const role of ['user','system']) expect(isUnansweredGreeting(5,[{role,text:'ZZ Massage, how can I help?'}])).toBe(false);
 expect(isUnansweredGreeting(15,[{role:'assistant',text:'How can I help?'},{role:'user',text:'Book please.'}])).toBe(false);
 expect(isUnansweredGreeting(5,[{role:'assistant',text:'Your appointment is cancelled.'}])).toBe(true);
});

it('handles custom and multilingual greetings while keeping unknown speech and longer calls billable', () => {
 const turns = [{role:'assistant',text:'Hi, thanks for calling GZmassage. How can I help, or would you like to speak with a manager?'}];
 expect(isUnansweredGreeting(9, turns)).toBe(true);
 expect(isUnansweredGreeting(15, [{role:'assistant',text:'您好，请问有什么可以帮您？'}])).toBe(true);
 expect(isUnansweredGreeting(16, turns)).toBe(false);
 expect(isUnansweredGreeting(9, [...turns, {role:'user',text:'Hi'}])).toBe(false);
 expect(isUnansweredGreeting(9, [{role:'system',text:'Hello'}])).toBe(false);
 expect(isUnansweredGreeting(9, [])).toBe(false);
 expect(isUnansweredGreeting(9, undefined)).toBe(false);
 expect(isUnansweredGreeting(9, [{role:'assistant',text:' '}])).toBe(false);
});
