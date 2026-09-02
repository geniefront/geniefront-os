/**
 * Reconstruct a guest manage URL for transactional notifications.
 *
 * Prefer the in-memory raw token at issuance. Later events unwrap
 * `manage_token_wrapped`. Never mint a replacement token.
 */

import { hostedManageBookingUrl } from '../links';
import { unwrapManageToken } from '../public/bookingToken';

export function guestManageLink(args: {
  shopSlug: string | null | undefined;
  rawToken?: string | null;
  wrapped?: Buffer | Uint8Array | null;
  digest?: string | null;
}): string | null {
  if (!args.shopSlug) return null;
  const raw = args.rawToken
    ?? (args.wrapped && args.digest
      ? unwrapManageToken(args.wrapped, args.digest)
      : null);
  if (!raw) return null;
  return hostedManageBookingUrl({ shopSlug: args.shopSlug, manageToken: raw });
}

/** Template value. Empty when the link must be omitted. */
export function manageUrlVar(url: string | null): string {
  return url ?? '';
}
