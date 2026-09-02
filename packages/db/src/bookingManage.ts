/**
 * Appointment management-token resolution.
 *
 * Documented exception to "every read is withTenant()": the guest URL has
 * only a slug and a raw token. We hash the token, look up the digest via a
 * SECURITY DEFINER function, then switch to withTenant() for any further
 * reads. The raw token never enters this module.
 */

import { sql } from './client';

export interface ManagedBookingRef {
  appointmentId: string;
  orgId: string;
  locationId: string;
  slug: string;
  appointmentStatus: string;
  locationStatus: string;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export async function lookupByManageDigest(
  digest: string,
): Promise<ManagedBookingRef | null> {
  if (!DIGEST_RE.test(digest)) return null;

  const rows = await sql<{
    appointment_id: string;
    org_id: string;
    location_id: string;
    slug: string;
    appointment_status: string;
    location_status: string;
  }[]>`
    select appointment_id, org_id, location_id, slug,
           appointment_status, location_status
      from gf_booking_by_manage_digest(${digest})`;

  const r = rows[0];
  if (!r) return null;
  return {
    appointmentId: r.appointment_id,
    orgId: r.org_id,
    locationId: r.location_id,
    slug: r.slug,
    appointmentStatus: r.appointment_status,
    locationStatus: r.location_status,
  };
}
