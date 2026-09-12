import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { issueStaffSession } from './staffSession';

type Match = { orgId: string; locationId: string; membershipId: string };
const ISSUER = 'geniefront-os:phone-verification';
const AUDIENCE = 'staff-location-selection';
const secret = () => {
  const value = process.env['APP_JWT_SECRET'];
  if (!value || value.length < 32) throw new Error('APP_JWT_SECRET must contain at least 32 characters');
  return new TextEncoder().encode(value);
};
const denied = () => new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'invalid_phone_selection' } });

export async function issuePhoneSelection(phone: string, matches: Match[]): Promise<string> {
  return new SignJWT({ phone, anchor: matches[0], memberships: matches.map(m => m.membershipId) })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setJti(randomUUID()).setIssuedAt().setExpirationTime('5m').sign(secret());
}

export async function verifyPhoneSelection(token: string): Promise<{
  phone: string; anchor: Match; memberships: string[]; jti: string;
}> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    const anchor = payload['anchor'] as Match | undefined;
    const memberships = payload['memberships'];
    if (typeof payload['phone'] !== 'string' || !payload.jti || !anchor?.orgId || !anchor.locationId
      || !anchor.membershipId || !Array.isArray(memberships) || !memberships.every(x => typeof x === 'string')) throw denied();
    return { phone: payload['phone'], anchor, memberships, jti: payload.jti };
  } catch { throw denied(); }
}

/** One use across API nodes. Consumption and the selected session commit together. */
export async function redeemPhoneSelection(
  selection: Awaited<ReturnType<typeof verifyPhoneSelection>>, picked: Match, deviceLabel: string | null,
) {
  if (!selection.memberships.includes(picked.membershipId)) throw denied();
  return withTenant(selection.anchor, async tx => {
    const key = `phone-selection:${selection.jti}`;
    await tx`select pg_advisory_xact_lock(hashtext(${selection.anchor.locationId}), hashtext(${key}))`;
    const [used] = await tx`select key from command_idempotency where location_id = ${selection.anchor.locationId} and key = ${key}`;
    if (used) throw denied();
    await tx`insert into command_idempotency(location_id,key,command,result_json)
      values(${selection.anchor.locationId},${key},'auth.phone.select','{}'::jsonb)`;
    // Both tenant identities came from verified server data, never raw request fields.
    await tx`select set_config('app.org_id',${picked.orgId},true),
      set_config('app.location_id',${picked.locationId},true),
      set_config('app.membership_id',${picked.membershipId},true)`;
    return issueStaffSession(picked, 'phone_otp', deviceLabel, tx);
  });
}
