declare const __BOOKING_ORIGIN__: string;

export function bookingPageOrigin(): string {
  const raw = typeof __BOOKING_ORIGIN__ === 'string' ? __BOOKING_ORIGIN__ : '';
  return raw.split(',')[0]?.trim().replace(/\/$/, '') ?? '';
}

/** Canonical hosted booking URL. Empty origin or slug means we must not invent a fake link. */
export function hostedBookingUrl(origin: string, slug: string): string | null {
  const o = origin.trim().replace(/\/$/, '');
  const s = slug.trim().toLowerCase();
  if (!o || !s) return null;
  return `${o}/${encodeURIComponent(s)}`;
}
