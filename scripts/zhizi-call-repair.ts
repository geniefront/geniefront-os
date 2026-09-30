/** Run a bundled copy in the production API container, using its existing app_user
 * credentials. No provider/DB secrets are accepted as CLI arguments or printed. */
import { closeDb, readOnlineBooking, tenantForPhoneNumber, withTenant } from '@gf/db';
import { addDays, businessDateOf } from '@gf/scheduling';
import type { CommandContext } from '@gf/contracts';
import { dispatch } from '../apps/api/src/bus';
import '../apps/api/src/handlers/phone';
import { refreshVoiceSnapshot } from '../apps/api/src/voice/contextCache';
import { loadVoiceOffers } from '../apps/api/src/voice/offers';

const action = process.argv[2] ?? 'inspect';
if (!['inspect', 'apply-rules', 'verify-offers'].includes(action)) throw new Error('Unknown action');
try {
  const tenant = await tenantForPhoneNumber('+17577317358');
  if (!tenant || tenant.locationId !== '1c708a61-b467-4062-af96-2cd6392e20e5' || !tenant.toolTokenDigest)
    throw new Error('Production shop binding mismatch');
  const ctx: CommandContext = { ...tenant, membershipId: null, userId: null, actorKind: 'api', locale: 'en',
    permissions: new Set(['settings.manage', 'call.draft', 'appointment.write']) };
  const [shop] = await withTenant(ctx, tx => tx`select settings,timezone from locations where id=${ctx.locationId}`);
  const rules = readOnlineBooking(shop!.settings);
  if (action === 'apply-rules') {
    if (![5, 30].includes(rules.minMinutesAhead) || ![10, 30].includes(rules.slotIntervalMinutes ?? 30))
      throw new Error('Booking rules changed since review; inspect before applying');
    await dispatch('settings.saveVoiceBookingRules', {
      maxDaysAhead: rules.maxDaysAhead, minMinutesAhead: 5, slotIntervalMinutes: 10,
    }, ctx, { systemOrigin: 'zhizi_call_repair_20260929', idempotencyKey: 'zhizi-20260929-lead5-step10' });
    await refreshVoiceSnapshot(ctx, tenant.toolTokenDigest, true);
    const [saved] = await withTenant(ctx, tx => tx`select settings->'online_booking' as rules from locations where id=${ctx.locationId}`);
    if (saved!.rules.min_minutes_ahead !== 5 || saved!.rules.slot_interval_minutes !== 10) throw new Error('Rules verification failed');
    console.log(JSON.stringify({ action, locationId:ctx.locationId, minMinutesAhead:5, slotIntervalMinutes:10, maxDaysAhead:rules.maxDaysAhead }));
  } else if (action === 'verify-offers') {
    const date = addDays(businessDateOf(new Date(), shop!.timezone, '00:00'), 1);
    const serviceId = '77d8104b-8bb2-4e82-a3ab-55dada90a0da';
    for (const time of ['09:10', '09:15']) {
      const response = await loadVoiceOffers(ctx, tenant.toolTokenDigest, { date, serviceId, time, partySize:1 });
      console.log(JSON.stringify({ action, date, requestedTime:response.requestedTime, times:response.offers.map(o => o.times) }));
    }
  } else {
    const calls = await withTenant(ctx, tx => tx`
      select c.id,c.provider_call_id,coalesce(c.started_at,c.created_at)::text as started_at,
        c.from_e164 is null or c.from_e164='' as anonymous,c.duration_seconds,c.voice_billing_status,
        c.recording_id,jsonb_array_length(coalesce(c.transcript,'[]'::jsonb)) as transcript_turns,
        c.summary is not null as has_summary,j.status as processing_status,j.last_error
      from phone_calls c left join voice_processing_jobs j on j.location_id=c.location_id and j.provider_call_id=c.provider_call_id
      where c.location_id=${ctx.locationId} and c.started_at>='2026-09-29T04:00:00Z'::timestamptz
        and c.started_at<'2026-09-30T04:00:00Z'::timestamptz order by c.started_at`);
    console.log(JSON.stringify({ action, rules:{minMinutesAhead:rules.minMinutesAhead,slotIntervalMinutes:rules.slotIntervalMinutes},calls }));
  }
} finally { await closeDb(); }
