import { expect, it } from 'vitest';
import { serviceGuestCount } from './serviceParty';
it('recognizes existing couples services without treating every two-therapist service as two guests', () => {
 expect(serviceGuestCount({en:'Couples Massage 60 min'},2)).toBe(2);
 expect(serviceGuestCount({en:'Four hands massage'},2)).toBe(1);
 expect(serviceGuestCount({en:'Couples Massage'},2,1)).toBe(1);
 expect(serviceGuestCount({en:'Family massage'},3,3)).toBe(3);
});
