import { AppError, ERROR_CODES } from '@gf/contracts';

type GoogleText = { text?: string };
type GooglePeriodPoint = { day?: number; hour?: number; minute?: number };
export interface GooglePlaceRaw {
  id?: string;
  displayName?: GoogleText;
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  websiteUri?: string;
  businessStatus?: string;
  types?: string[];
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  regularOpeningHours?: { periods?: Array<{ open?: GooglePeriodPoint; close?: GooglePeriodPoint }> };
}

export interface GooglePlaceView {
  googlePlaceId: string;
  name: string;
  phoneE164: string | null;
  displayPhone: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null; country: string | null; display: string[] };
  businessHours: Record<string, { open: string; close: string } | null>;
  rating: number | null;
  reviewCount: number | null;
  isClosed: boolean;
  categories: string[];
  googleMapsUrl: string | null;
  websiteUrl: string | null;
}

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const time = (p?: GooglePeriodPoint) => p && Number.isInteger(p.hour)
  ? `${String(p.hour).padStart(2, '0')}:${String(p.minute ?? 0).padStart(2, '0')}` : null;

export function mapGooglePlace(place: GooglePlaceRaw): GooglePlaceView {
  const component = (type: string, short = false) => {
    const found = place.addressComponents?.find((c) => c.types?.includes(type));
    return (short ? found?.shortText : found?.longText) ?? null;
  };
  const street = [component('street_number'), component('route')].filter(Boolean).join(' ') || null;
  const hours: Record<string, { open: string; close: string } | null> = {};
  for (const period of place.regularOpeningHours?.periods ?? []) {
    const key = period.open?.day === undefined ? undefined : DAY[period.open.day];
    const open = time(period.open); const close = time(period.close);
    if (key && open && close) hours[key] = { open, close };
  }
  return {
    googlePlaceId: place.id ?? '',
    name: place.displayName?.text ?? '',
    phoneE164: place.internationalPhoneNumber
      ? `+${place.internationalPhoneNumber.replace(/\D/g, '')}`
      : null,
    displayPhone: place.nationalPhoneNumber ?? null,
    address: {
      line1: street, line2: component('subpremise'),
      city: component('locality') ?? component('postal_town'),
      state: component('administrative_area_level_1', true), zip: component('postal_code'),
      country: component('country', true), display: place.formattedAddress ? [place.formattedAddress] : [],
    },
    businessHours: hours,
    rating: typeof place.rating === 'number' ? place.rating : null,
    reviewCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    isClosed: place.businessStatus === 'CLOSED_PERMANENTLY',
    categories: place.types ?? [],
    googleMapsUrl: place.googleMapsUri ?? null,
    websiteUrl: place.websiteUri ?? null,
  };
}

const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.internationalPhoneNumber', 'places.nationalPhoneNumber', 'places.rating',
  'places.userRatingCount', 'places.googleMapsUri', 'places.websiteUri',
  'places.businessStatus', 'places.types', 'places.regularOpeningHours',
].join(',');

async function googleFetch(url: string, init: RequestInit, apiKey: string): Promise<any> {
  const res = await fetch(url, { ...init, headers: { ...init.headers, 'X-Goog-Api-Key': apiKey } });
  if (!res.ok) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'google_places', status: res.status } });
  return res.json();
}

export async function searchGooglePlaces(textQuery: string, apiKey: string): Promise<GooglePlaceView[]> {
  const body = await googleFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ textQuery, pageSize: 8 }),
  }, apiKey) as { places?: GooglePlaceRaw[] };
  return (body.places ?? []).map(mapGooglePlace).filter((p) => p.googlePlaceId && p.name);
}

export async function getGooglePlace(id: string, apiKey: string): Promise<GooglePlaceView> {
  const fields = FIELDS.replaceAll('places.', '');
  const body = await googleFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
    method: 'GET', headers: { 'X-Goog-FieldMask': fields },
  }, apiKey) as GooglePlaceRaw;
  return mapGooglePlace(body);
}
