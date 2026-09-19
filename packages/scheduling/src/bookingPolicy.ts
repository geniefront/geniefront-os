/** Explicit extra concurrent bookings, not a time gap or an unlimited override. */
export interface BookingPolicy {
  mode: 'staff' | 'location';
  baseCapacity: number | null;
  bufferEnabled: boolean;
  bufferExtra: number;
  requestBufferEnabled: boolean;
  requestBufferExtra: number;
}

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const integer = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

export function readBookingPolicy(settings: unknown): BookingPolicy {
  const raw = object(object(settings).capacity);
  return {
    mode: raw.booking_mode === 'location' ? 'location' : 'staff',
    baseCapacity: raw.max_concurrent_per_slot == null ? null
      : integer(raw.max_concurrent_per_slot, 1, 100, 1),
    bufferEnabled: raw.buffer_enabled === true,
    bufferExtra: integer(raw.buffer_extra, 1, 10, 1),
    requestBufferEnabled: raw.request_buffer_enabled === true,
    requestBufferExtra: integer(raw.request_buffer_extra, 1, 5, 1),
  };
}

/** A requested therapist has an independent opt-in. Store and staff limits both apply. */
export function bookingLimits(policy: BookingPolicy, onDuty: number, requested: boolean, staffLimit = 1) {
  const extra = requested
    ? policy.requestBufferEnabled ? policy.requestBufferExtra : 0
    : policy.bufferEnabled ? policy.bufferExtra : 0;
  const base = policy.baseCapacity ?? (policy.mode === 'location' ? 1 : onDuty);
  return {
    locationLimit: base > 0 ? base + extra : 0,
    staffLimit: staffLimit + (requested && policy.requestBufferEnabled ? policy.requestBufferExtra : 0),
  };
}
