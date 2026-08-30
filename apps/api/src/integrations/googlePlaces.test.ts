import { describe, expect, it } from 'vitest';
import { mapGooglePlace } from './googlePlaces';

describe('Google Places onboarding mapper', () => {
  it('maps address, E.164 phone, reviews and weekly hours', () => {
    const mapped = mapGooglePlace({
      id: 'places/abc', displayName: { text: 'Queen Spa' },
      formattedAddress: '12 Main St, Boston, MA 02110',
      internationalPhoneNumber: '+1 617-555-0199', nationalPhoneNumber: '(617) 555-0199',
      rating: 4.7, userRatingCount: 82, businessStatus: 'OPERATIONAL', types: ['spa'],
      addressComponents: [
        { longText: '12', types: ['street_number'] },
        { longText: 'Main Street', types: ['route'] },
        { longText: 'Boston', types: ['locality'] },
        { shortText: 'MA', types: ['administrative_area_level_1'] },
        { longText: '02110', types: ['postal_code'] },
        { shortText: 'US', types: ['country'] },
      ],
      regularOpeningHours: { periods: [{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 18, minute: 30 } }] },
    });

    expect(mapped).toMatchObject({
      googlePlaceId: 'places/abc', name: 'Queen Spa', phoneE164: '+16175550199',
      address: { line1: '12 Main Street', city: 'Boston', state: 'MA', zip: '02110', country: 'US' },
      businessHours: { mon: { open: '09:00', close: '18:30' } },
      rating: 4.7, reviewCount: 82, isClosed: false,
    });
  });
});
