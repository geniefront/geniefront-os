import { expect, it } from 'vitest';
import { normalizePhonePayload } from './phonePayload';
it('normalizes nested party contacts and phone settings before submission', () => {
 expect(normalizePhonePayload({guests:[{phoneE164:'6676606667'}],forwardPhoneNumber:'+44 7911 123456',phone:null,repPhone:''})).toEqual({guests:[{phoneE164:'+16676606667'}],forwardPhoneNumber:'+447911123456',phone:null,repPhone:''});
});
it('rejects incomplete phone fields and leaves ordinary text alone', () => {
 expect(()=>normalizePhonePayload({phone:'12345'})).toThrow('phone');
 expect(normalizePhonePayload({notes:'call 12345',name:'Nancy'})).toEqual({notes:'call 12345',name:'Nancy'});
});
