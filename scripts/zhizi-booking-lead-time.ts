/** Bundle and run in the production API container with its restricted runtime role.
 * Defaults to read-only. Apply changes only Zhi Zi's minimum booking lead time.
 */
import { closeDb, readOnlineBooking, tenantForPhoneNumber, withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { dispatch } from '../apps/api/src/bus';
import '../apps/api/src/handlers/phone';
import { requestVoiceSnapshot, initialVoiceContext } from '../apps/api/src/voice/contextCache';
import { voiceCatalog } from '../apps/api/src/voice/catalog';

const action = process.argv[2] ?? 'inspect';
if (!['inspect', 'apply', 'verify'].includes(action)) throw new Error('Unknown action');
try {
  const tenant = await tenantForPhoneNumber('+17577317358');
  if (process.env.GF_ENV !== 'production' || !tenant?.toolTokenDigest ||
      tenant.locationId !== '1c708a61-b467-4062-af96-2cd6392e20e5')
    throw new Error('Production shop binding mismatch');
  const ctx: CommandContext = { ...tenant, membershipId:null, userId:null, actorKind:'api', locale:'en',
    permissions:new Set(['settings.manage', 'call.draft', 'appointment.write']) };
  const read = () => withTenant(ctx, async tx => {
    const [row] = await tx`select settings from locations where id=${ctx.locationId}`;
    return row!.settings as Record<string, unknown>;
  });
  const before = await read();
  const rules = readOnlineBooking(before);
  if (action === 'apply') {
    if (![0, 90].includes(rules.minMinutesAhead)) throw new Error('Lead time changed since review');
    await dispatch('settings.saveVoiceBookingRules', {
      maxDaysAhead:rules.maxDaysAhead, minMinutesAhead:0,
    }, ctx, { systemOrigin:'zhizi_booking_lead_time_20261009', idempotencyKey:'zhizi-20261009-lead0' });
    const after = await read();
    const expected = { ...before, online_booking:{ ...(before.online_booking as object), min_minutes_ahead:0,
      max_days_ahead:rules.maxDaysAhead } };
    const { isDeepStrictEqual } = await import('node:util');
    if (!isDeepStrictEqual(after, expected)) throw new Error('Unexpected settings change');
    await requestVoiceSnapshot(ctx, tenant.toolTokenDigest);
  }
  const current = readOnlineBooking(await read());
  const catalog = await withTenant(ctx, tx => voiceCatalog(tx, ctx.locationId));
  const snapshot = action === 'verify' ? await initialVoiceContext(ctx, tenant.toolTokenDigest) : null;
  if (action !== 'inspect' && (current.minMinutesAhead !== 0 || catalog.context.rules.minMinutesAhead !== 0 ||
      (snapshot && snapshot.rules.minMinutesAhead !== 0))) throw new Error('Lead-time verification failed');
  console.log(JSON.stringify({ action, locationId:ctx.locationId, beforeMinMinutesAhead:rules.minMinutesAhead,
    minMinutesAhead:current.minMinutesAhead, voiceMinMinutesAhead:catalog.context.rules.minMinutesAhead,
    snapshotMinMinutesAhead:snapshot?.rules.minMinutesAhead, snapshotGeneratedAt:snapshot?.coverage.generatedAt,
    slotIntervalMinutes:current.slotIntervalMinutes, maxDaysAhead:current.maxDaysAhead }));
} finally { await closeDb(); }
