import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { withTenant, closeDb, PLATFORM_OPS_USER_ID } from '@gf/db';
import { buildContext } from './actor';
import { buildServer } from './server';
import { dispatch } from './bus';
import { wallMinuteToInstant, addDays, businessDateOf } from '@gf/scheduling';

const locationId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId, membershipId: null };
const phone = '+15125550199';
const path = `/v1/voice/${encodeURIComponent(phone)}`;
let app: ReturnType<typeof buildServer>;
let ctx: Awaited<ReturnType<typeof buildContext>>;
let token: string;
let serviceId: string;
let memberId: string;
const date = addDays(businessDateOf(new Date(), 'America/New_York', '03:00'), 35);

beforeAll(async () => {
  const [m] = await withTenant(tenant, tx => tx<{ id: string; user_id: string }[]>`
    select id, user_id from memberships where location_id=${locationId} and status='active' order by created_at limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  const bind = await dispatch<{ toolToken: string }>('location.savePhoneLine', {
    e164: phone, purpose: 'ai_voice', active: true, rotateToolToken: true, aiAnswer: true, assistantId: 'agent_test',
  }, ctx, { systemOrigin: 'test_voice' });
  token = bind.result.toolToken;
  const [s] = await withTenant(tenant, tx => tx<{ id: string }[]>`
    select id from services where location_id=${locationId} and active and not is_addon and staff_count=1 order by id limit 1`);
  serviceId = s!.id;
  const [staff] = await withTenant(tenant, tx => tx<{ membership_id: string }[]>`
    select membership_id from staff_profiles where location_id=${locationId} and is_bookable limit 1`);
  memberId = staff!.membership_id;
  await withTenant(tenant, tx => tx`update staff_profiles set max_concurrent_appointments=1 where membership_id=${memberId}`);
  await withTenant(tenant, tx => tx`update services set online_bookable=true where id=${serviceId}`);
  await dispatch('location.saveHours', { hours: Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat']
    .map(d => [d, { open: '09:00', close: '20:00' }])) }, ctx);
  app = buildServer(); await app.ready();
});
afterAll(async () => { vi.unstubAllEnvs(); await app?.close(); await closeDb(); });

const headers = () => ({ authorization: `Bearer ${token}` });
const policy = (bufferEnabled: boolean, requestBufferEnabled = false) => dispatch('location.saveBookingPolicy', {
  mode: 'location', baseCapacity: 2, bufferEnabled, bufferExtra: 1, requestBufferEnabled, requestBufferExtra: 1,
}, ctx);
async function offers(day = date, requested = false) {
  return app.inject({ method: 'GET', url: `${path}/context?date=${day}&serviceId=${serviceId}${requested ? `&membershipId=${memberId}` : ''}`, headers: headers() });
}
const submit = (slotToken: string, name: string) => app.inject({ method: 'POST', url: `${path}/bookings`, headers: headers(),
  payload: { slotToken, customerName: name, phoneE164: '+12025550123' } });

describe('xAI scoped booking tools', () => {
  it('rejects missing credentials and a credential for another phone', async () => {
    expect((await app.inject({ method: 'GET', url: `${path}/context` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/voice/%2B17579999968/context', headers: headers() })).statusCode).toBe(401);
  });

  it('verifies raw TeXML callbacks and returns the provider-side time limit', async () => {
    const keys = generateKeyPairSync('ed25519');
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'));
    vi.stubEnv('XAI_SIP_HOST', 'voice.example.com:5060');
    vi.stubEnv('XAI_TEXML_BASE_URL', 'https://api.example.com');
    const body = new URLSearchParams({ To: phone, From: '+12025550123' }).toString();
    const timestamp = String(Math.floor(Date.now()/1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64');
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature };
    const r = await app.inject({method:'POST',url:'/v1/telnyx/xai/inbound',headers,payload:body});
    expect(r.statusCode).toBe(200); expect(r.body).toContain('timeLimit="600"');
    expect((await app.inject({method:'POST',url:'/v1/telnyx/xai/inbound',headers,payload:body+'&tampered=1'})).statusCode).toBe(401);
  });
  it('returns store information without leaking customer records', async () => {
    const r = await app.inject({ method: 'GET', url: `${path}/context`, headers: headers() });
    expect(r.statusCode).toBe(200); expect(r.json().shop.timezone).toBe('America/New_York');
    expect(r.json().services.length).toBeGreaterThan(0); expect(r.json().customers).toBeUndefined();
  });
  it('rechecks the last place under a lock and permits exactly one configured extra booking', async () => {
    await policy(false);
    const res = await offers(); expect(res.statusCode).toBe(200);
    const slot = res.json().slots[0]; expect(slot).toBeTruthy();
    expect((await submit(slot.slotToken, 'First')).statusCode).toBe(200);
    const races = await Promise.all([submit(slot.slotToken, 'Second'), submit(slot.slotToken, 'Third')]);
    expect(races.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(races.filter(r => r.statusCode === 409)).toHaveLength(1);
    await policy(true);
    expect((await submit(slot.slotToken, 'Buffer guest')).statusCode).toBe(200);
    expect((await submit(slot.slotToken, 'Fourth')).statusCode).toBe(409);
  });
  it('replays without duplicating appointments and rejects tampered offers', async () => {
    const res = await offers(addDays(date, 1)); const slot = res.json().slots[0];
    const first = await submit(slot.slotToken, 'Replay'); const second = await submit(slot.slotToken, 'Replay');
    expect(first.statusCode).toBe(200); expect(second.json().appointmentId).toBe(first.json().appointmentId);
    expect(second.json().replayed).toBe(true);
    expect((await submit(`x${slot.slotToken}`, 'Tampered')).statusCode).toBe(400);
  });
  it('requested therapist overlaps require their independent buffer switch', async () => {
    await policy(true, false);
    const first = await offers(addDays(date, 2), true); const slot = first.json().slots[0];
    expect((await submit(slot.slotToken, 'Requested one')).statusCode).toBe(200);
    expect((await submit(slot.slotToken, 'Requested two')).statusCode).toBe(409);
    await policy(false, true);
    expect((await submit(slot.slotToken, 'Requested two')).statusCode).toBe(200);
    expect((await submit(slot.slotToken, 'Requested three')).statusCode).toBe(409);
  });
  it('settles recording classification once, without charging excluded time', async () => {
    const opts = { systemOrigin: 'voice_test' };
    ctx = { ...ctx, permissions: new Set([...ctx.permissions, 'call.draft', 'billing.manage']) };
    const providerCallId = 'voice-test-classification';
    await dispatch('call.queueRecording', { providerCallId, recordingId: 'recording-test',
      to: phone, from: '+12025550123', startedAt: new Date().toISOString(), durationSeconds: 180 }, ctx, opts);
    const claimed = await dispatch<{ job: { id: string; leaseId: string } }>('call.claimRecording', {}, ctx, opts);
    const job = claimed.result.job; expect(job).toBeTruthy();
    const payload = { jobId: job.id, leaseId: job.leaseId, durationSeconds: 180,
      transcript: 'Store service inquiry followed by unrelated conversation.', recordingUrl: 'https://recordings.telnyx.com/test.wav',
      analysis: { summary: '客户咨询服务，随后闲聊。', segments: [
        { start: 0, end: 60, category: 'business' }, { start: 60, end: 180, category: 'off_topic' },
      ] } };
    const first = await dispatch<{ completed: boolean; billableSeconds: number }>('call.completeRecording', payload, ctx, opts);
    expect(first.result.billableSeconds).toBe(60);
    const second = await dispatch<{ completed: boolean }>('call.completeRecording', payload, ctx, opts);
    expect(second.result.completed).toBe(false);
    const [usage] = await withTenant(tenant, tx => tx<{ count: number; total: number }[]>`
      select count(*)::int as count,sum(qty)::int as total from usage_events where meta->>'providerCallId'=${providerCallId}`);
    expect(usage).toEqual({ count: 1, total: 1 });
  });

  it('blocks disabled voice tools before creating any booking', async () => {
    await dispatch('location.savePhoneLine', { e164: phone, purpose: 'ai_voice', aiAnswer: false }, ctx, { systemOrigin: 'test_voice' });
    expect((await offers()).statusCode).toBe(403);
    await dispatch('location.savePhoneLine', { e164: phone, purpose: 'ai_voice', aiAnswer: true }, ctx, { systemOrigin: 'test_voice' });
  });
  it('attaches a Stripe customer without changing manual entitlement or usage', async () => {
    await withTenant(tenant, tx => tx`update billing_accounts set billing_source='license', license_period_end=now()+interval '30 days', subscription_status='active', included_minutes_used=37 where location_id=${locationId}`);
    await dispatch('billing.syncSubscription', { stripeCustomerId: 'cus_voice_binding_test' }, ctx, { systemOrigin: 'test_voice' });
    const [acct] = await withTenant(tenant, tx => tx`select billing_source, stripe_customer_id, included_minutes_used from billing_accounts where location_id=${locationId}`);
    expect(acct).toMatchObject({ billing_source: 'license', stripe_customer_id: 'cus_voice_binding_test', included_minutes_used: 37 });
  });
  it('checks a manual expiry immediately without waiting for a sweep', async () => {
    await withTenant(tenant, tx => tx`update billing_accounts set license_period_end=now()-interval '1 minute' where location_id=${locationId}`);
    expect((await offers()).statusCode).toBe(402);
    await expect(policy(false)).rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });
    await withTenant(tenant, tx => tx`update billing_accounts set license_period_end=now()+interval '30 days' where location_id=${locationId}`);
  });


  it('lets operators change manual base quota without resetting used minutes', async () => {
    const { updateStoreVoiceQuota } = await import('./platform/licenseCommands');
    const { loadBilling } = await import('./queries/billing');
    const { assertAiAdmission } = await import('./billing/aiAdmission');
    const op = { userId: PLATFORM_OPS_USER_ID, operatorId: '55555555-5555-4555-8555-555555555555', role: 'super_admin' as const, email: null };
    await updateStoreVoiceQuota(op, tenant.orgId, locationId, { baseVoiceMinutes: 75, note: 'Test manual base minutes' });
    const bill = await withTenant(tenant, tx => loadBilling(tx, ctx));
    expect(bill?.quotas.find(q => q.unit === 'voice_minute')?.included).toEqual({ total: 75, used: 37, remaining: 38 });
    expect((await assertAiAdmission(ctx, 'voice_minute')).includedRemaining).toBe(38);
    await expect(updateStoreVoiceQuota({ ...op, role: 'support' as never }, tenant.orgId, locationId, { baseVoiceMinutes: 100, note: 'Refused' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('enforces special-plan capabilities and only permits Growth as a different plan', async () => {
    await withTenant(tenant, tx => tx`update billing_accounts set plan='voice_booking' where location_id=${locationId}`);
    await expect(dispatch('settings.saveSetupFeatures', { healthFormsEnabled: true }, ctx)).rejects.toMatchObject({ details: { reason: 'health_forms_not_in_plan' } });
    await expect(withTenant(tenant, tx => tx`update billing_accounts set plan='essential' where location_id=${locationId}`)).rejects.toThrow();
    await withTenant(tenant, tx => tx`update billing_accounts set plan='growth' where location_id=${locationId}`);
    const [account] = await withTenant(tenant, tx => tx`select plan,included_minutes_used,manual_voice_minutes from billing_accounts where location_id=${locationId}`);
    expect(account).toMatchObject({ plan: 'growth', included_minutes_used: 37, manual_voice_minutes: null });
  });

});
