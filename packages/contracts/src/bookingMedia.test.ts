import {expect,it} from 'vitest';
import {defaultBookingMedia,bookingMediaUrl} from './bookingMedia';
it('matches addons before general massage and falls back for unknown services',()=>{
 expect(defaultBookingMedia('Hot Stones Massage')).toBe(bookingMediaUrl('hot-stones'));
 expect(defaultBookingMedia('Swedish Massage 60 min')).toBe(bookingMediaUrl('massage'));
 expect(defaultBookingMedia('精油')).toBe(bookingMediaUrl('essential-oils'));
 expect(defaultBookingMedia('New treatment')).toBe(bookingMediaUrl('spa'));
});
