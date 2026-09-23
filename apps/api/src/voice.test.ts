import { loadCalls } from './queries/calls';
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
const submit = (slotToken: string, name: string, providerCallId?: string) => app.inject({ method: 'POST', url: `${path}/bookings`, headers: headers(),
  payload: { slotToken, customerName: name, phoneE164: '+12025550123',providerCallId } });

describe('xAI scoped booking tools', () => {
  it('rejects missing credentials and a credential for another phone', async () => {
    expect((await app.inject({ method: 'GET', url: `${path}/context` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/voice/%2B17579999968/context', headers: headers() })).statusCode).toBe(401);
  });

  it('verifies legacy TeXML callbacks without a 600-second call cutoff', async () => {
    const keys = generateKeyPairSync('ed25519');
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'));
    vi.stubEnv('XAI_SIP_HOST', 'voice.example.com:5060');
    vi.stubEnv('XAI_TEXML_BASE_URL', 'https://api.example.com');
    const body = new URLSearchParams({ To: phone, From: '+12025550123' }).toString();
    const timestamp = String(Math.floor(Date.now()/1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64');
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature };
    const r = await app.inject({method:'POST',url:'/v1/telnyx/xai/inbound',headers,payload:body});
    expect(r.statusCode).toBe(200); expect(r.body).not.toContain('timeLimit=');
    expect(r.body).toContain('sip:+15125550199@voice.example.com:5060;transport=tls</Sip>');
    expect(r.body).toContain('referUrl="https://api.example.com/v1/telnyx/xai/transfer" referMethod="POST"');
    expect((await app.inject({method:'POST',url:'/v1/telnyx/xai/inbound',headers,payload:body+'&tampered=1'})).statusCode).toBe(401);
  });
  it('continues a signed SIP transfer only to the active store staff number', async () => {
    const keys = generateKeyPairSync('ed25519');
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'));
    const staffPhone = '+12025550188';
    await dispatch('location.savePhoneLine', { e164: staffPhone, purpose: 'transfer_target', active: true }, ctx, { systemOrigin: 'test_voice' });
    const transfer = (fields: Record<string, string> = {}, tamper = false) => {
      const body = new URLSearchParams({ To: phone, CallSid: 'original-inbound-call',
        From: '+12025550123', ReferTransferTarget: '+19005550199', ...fields }).toString();
      const timestamp = String(Math.floor(Date.now()/1000));
      const signature = sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64');
      return app.inject({ method: 'POST', url: '/v1/telnyx/xai/transfer?number=%2B19005550199',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'telnyx-timestamp': timestamp,
          'telnyx-signature-ed25519': signature }, payload: body + (tamper ? '&To=%2B19005550199' : '') });
    };
    const result = await transfer();
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('application/xml');
    expect(result.body).toContain(`<Number>${staffPhone}</Number>`);
    expect(result.body).toContain(`callerId="${phone}"`);
    expect(result.body).not.toContain('+19005550199');
    expect(result.body).not.toContain('record=');
    expect((await transfer({}, true)).statusCode).toBe(401);
    expect((await transfer({ To: '+15125550198' })).statusCode).toBe(404);
    expect((await transfer({ CallSid: '' })).statusCode).toBe(400);
    expect((await transfer({ To: 'invalid' })).statusCode).toBe(400);
    await withTenant(tenant, tx => tx`update phone_lines set active=false where location_id=${locationId} and purpose='transfer_target'`);
    const unavailable = await transfer();
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.body).toContain('<Say>');
    expect(unavailable.body).not.toContain('<Dial');
    await withTenant(tenant, tx => tx`update phone_lines set active=true, e164=${phone} where location_id=${locationId} and purpose='transfer_target'`);
    expect((await transfer()).body).not.toContain('<Dial');
    await withTenant(tenant, tx => tx`update phone_lines set e164=${staffPhone} where location_id=${locationId} and purpose='transfer_target'`);
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
    const first = await submit(slot.slotToken, 'Replay','voice-replay-test'); const second = await submit(slot.slotToken, 'Replay','voice-replay-test');
    expect(first.statusCode).toBe(200); expect(second.json().appointmentId).toBe(first.json().appointmentId);
    expect(second.json().replayed).toBe(true);
    const [saved]=await withTenant(tenant,tx=>tx`select provider_call_id from appointments where id=${first.json().appointmentId}`);
    expect(saved!.provider_call_id).toBe('voice-replay-test');
    const items=await withTenant(tenant,tx=>tx`select membership_id from appointment_items where appointment_id=${first.json().appointmentId}`);
    expect(items.every(item=>item.membership_id===null)).toBe(true);
    expect((await submit(`x${slot.slotToken}`, 'Tampered')).statusCode).toBe(400);
  });
  it('requested therapist overlaps require their independent buffer switch', async () => {
    await policy(true, false);
    const first = await offers(addDays(date, 2), true); const slot = first.json().slots[0];
    const booked=await submit(slot.slotToken, 'Requested one');expect(booked.statusCode).toBe(200);
    const [item]=await withTenant(tenant,tx=>tx`select membership_id,reserved_membership_id from appointment_items where appointment_id=${booked.json().appointmentId}`);
    expect(item).toMatchObject({membership_id:memberId,reserved_membership_id:null});
    expect((await submit(slot.slotToken, 'Requested two')).statusCode).toBe(409);
    await policy(false, true);
    expect((await submit(slot.slotToken, 'Requested two')).statusCode).toBe(200);
    expect((await submit(slot.slotToken, 'Requested three')).statusCode).toBe(409);
  });
  it('does not import recordings from before a phone number was bound to this shop', async () => {
    const scoped = { ...ctx, permissions: new Set([...ctx.permissions, 'call.draft' as const]) };
    for (const [providerCallId, startedAt] of [['old-binding-call', '2000-01-01T00:00:00Z'], ['undated-binding-call', undefined]] as const) {
      const out = await dispatch<{queued:boolean}>('call.queueRecording', {providerCallId,recordingId:providerCallId,to:phone,startedAt,durationSeconds:30},scoped,{systemOrigin:'voice_test'});
      expect(out.result.queued).toBe(false);
      expect(await withTenant(tenant,tx=>tx`select id from voice_processing_jobs where provider_call_id=${providerCallId}`)).toHaveLength(0);
    }
  });
  it('settles recording classification once, without charging excluded time', async () => {
    const opts = { systemOrigin: 'voice_test' };
    ctx = { ...ctx, permissions: new Set([...ctx.permissions, 'call.draft', 'billing.manage']) };
    const providerCallId = 'voice-test-classification';
    await withTenant(tenant,tx=>tx`insert into phone_calls(org_id,location_id,provider_call_id) values(${tenant.orgId},${locationId},${providerCallId})`);
    await dispatch('call.queueRecording', { providerCallId, recordingId: 'recording-test',
      to: phone, from: '+12025550123', startedAt: new Date().toISOString(), durationSeconds: 180 }, ctx, opts);
    const queued = await withTenant(tenant, tx => loadCalls(tx,ctx));
    const pending = queued.calls.find(c=>c.recordingId==='recording-test');
    expect(pending?.billingStatus).toBe('pending');
    expect(pending?.transcript).toEqual([]);
    await withTenant(tenant,async tx=>{
      const appointments=await tx`select id from appointments where location_id=${locationId} limit 2`;
      expect(appointments).toHaveLength(2);
      for(const a of appointments) await tx`insert into voice_appointment_activity(org_id,location_id,appointment_id,caller,call_started_at,action,outcome,call_id)
       values(${tenant.orgId},${locationId},${a.id},'+12025550123',now(),'lookup','requested',${pending!.callId})`;
    });
    const claimed = await dispatch<{ job: { id: string; leaseId: string } }>('call.claimRecording', {}, ctx, opts);
    const job = claimed.result.job; expect(job).toBeTruthy();
    const payload = { jobId: job.id, leaseId: job.leaseId, durationSeconds: 180,
      transcript: 'Store service inquiry followed by unrelated conversation.', turns: [{role:'assistant',text:'Hello',startSeconds:0,endSeconds:1},{role:'user',text:'What services?',startSeconds:2,endSeconds:4}], recordingUrl: 'https://recordings.telnyx.com/test.wav',
      analysis: { summary: '客户咨询服务，随后闲聊。', segments: [
        { start: 0, end: 60, category: 'business' }, { start: 60, end: 180, category: 'off_topic' },
      ] } };
    const first = await dispatch<{ completed: boolean; billableSeconds: number }>('call.completeRecording', payload, ctx, opts);
    expect(first.result.billableSeconds).toBe(60);
    const loaded = await withTenant(tenant, tx => loadCalls(tx, ctx));
    const stored = loaded.calls.find(c=>c.transcript[0]?.text==='Hello');
    expect(stored?.summary).toBe(payload.analysis.summary);
    expect(stored?.appointmentIds).toHaveLength(2);
    expect(stored?.booked).toBe(false);
    expect(stored?.transcript).toEqual(payload.turns);
    const exact = await withTenant(tenant, tx => loadCalls(tx, ctx, {callId:stored!.callId}));
    expect(exact.calls).toHaveLength(1);
    const other = {...ctx, locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
    expect((await withTenant(tenant,tx=>loadCalls(tx,other,{callId:stored!.callId}))).calls).toHaveLength(0);

    const second = await dispatch<{ completed: boolean }>('call.completeRecording', payload, ctx, opts);
    expect(second.result.completed).toBe(false);
    const [usage] = await withTenant(tenant, tx => tx<{ count: number; total: number }[]>`
      select count(*)::int as count,sum(qty)::int as total from usage_events where meta->>'providerCallId'=${providerCallId}`);
    expect(usage).toEqual({ count: 1, total: 1 });
    await dispatch('call.queueRecording',{providerCallId,recordingId:'recording-test',to:phone,from:'+12025550123',startedAt:new Date().toISOString(),durationSeconds:180},ctx,opts);
    const [settled]=await withTenant(tenant,tx=>tx`select voice_billing_status from phone_calls where provider_call_id=${providerCallId}`);
    expect(settled?.voice_billing_status).toBe('settled');
  });

  it('keeps failed recordings visible and settles a recovered business call once without delayed notifications',async()=>{
    const opts={systemOrigin:'voice_test'};
    await dispatch('call.queueRecording',{providerCallId:'failed-transcription',recordingId:'recording-failed',to:phone,from:'+12025550188',startedAt:new Date().toISOString(),durationSeconds:62},ctx,opts);
    const claimed=await dispatch<{job:{id:string;leaseId:string}}>('call.claimRecording',{},ctx,opts);
    await withTenant(tenant,tx=>tx`update voice_processing_jobs set attempts=5 where id=${claimed.result.job.id}`);
    await dispatch('call.failRecording',{jobId:claimed.result.job.id,leaseId:claimed.result.job.leaseId,reason:'provider_failed'},ctx,opts);
    const data=await withTenant(tenant,tx=>loadCalls(tx,ctx));
    expect(data.calls.find(c=>c.recordingId==='recording-failed')?.billingStatus).toBe('review');
    const usage=await withTenant(tenant,tx=>tx`select id from usage_events where meta->>'providerCallId'='failed-transcription'`);
    expect(usage).toHaveLength(0);
    await withTenant(tenant,tx=>tx`update voice_processing_jobs set status='processing',payload=payload||'{"suppressNotification":true}'::jsonb where id=${claimed.result.job.id}`);
    const recovery={jobId:claimed.result.job.id,leaseId:claimed.result.job.leaseId,durationSeconds:62,transcript:'Please change my appointment. No slots available.',recordingUrl:'https://recordings.telnyx.com/recovered.wav',analysis:{summary:'Reschedule inquiry; no availability.',segments:[{start:0,end:62,category:'business'}]}};
    expect((await dispatch<{billableSeconds:number}>('call.completeRecording',recovery,ctx,opts)).result.billableSeconds).toBe(62);
    expect((await dispatch<{completed:boolean}>('call.completeRecording',recovery,ctx,opts)).result.completed).toBe(false);
    const recovered=await withTenant(tenant,tx=>tx`select qty from usage_events where meta->>'providerCallId'='failed-transcription'`);
    expect(recovered).toEqual([{qty:2}]);
    const notifications=await withTenant(tenant,tx=>tx`select id from email_outbox where entity_type='phone_call' and entity_id=(select id from phone_calls where provider_call_id='failed-transcription')`);
    expect(notifications).toHaveLength(0);
  });

  it('does not charge an unanswered opening greeting even if the classifier calls it business',async()=>{
    const opts={systemOrigin:'voice_test'},providerCallId='greeting-only';
    await dispatch('call.queueRecording',{providerCallId,recordingId:'greeting-audio',to:phone,startedAt:new Date().toISOString(),durationSeconds:5},ctx,opts);
    const claimed=await dispatch<{job:{id:string;leaseId:string}}>('call.claimRecording',{},ctx,opts);
    const out=await dispatch<{billableSeconds:number}>('call.completeRecording',{jobId:claimed.result.job.id,leaseId:claimed.result.job.leaseId,durationSeconds:5,transcript:'ZZ Massage, how can I help?',turns:[{role:'assistant',text:'ZZ Massage, how can I help?'}],recordingUrl:'https://recordings.telnyx.com/greeting.wav',analysis:{summary:'Greeting only.',segments:[{start:0,end:5,category:'business'}]}},ctx,opts);
    expect(out.result.billableSeconds).toBe(0);
    const [usage]=await withTenant(tenant,tx=>tx`select qty from usage_events where meta->>'providerCallId'=${providerCallId}`);
    expect(usage?.qty).toBe(0);
  });

  it('keeps direct SIP recording and notifications while excluding staff time from AI billing', async () => {
    const opts = { systemOrigin: 'test_direct_sip' }, providerCallId = 'direct-sip-transfer';
    await withTenant(tenant, tx => tx`update locations set settings=jsonb_set(settings,'{voice_notifications}','{"email":"direct-sip@example.com","phone":null}'::jsonb,true) where id=${locationId}`);
    await dispatch('call.queueRecording', { providerCallId, recordingId: 'direct-sip-audio', to: phone,
      from: '+12025550777', startedAt: new Date().toISOString(), durationSeconds: 180,
      aiDurationSeconds: 13, outcome: 'transferred_to_human' }, ctx, opts);
    const claimed = await dispatch<{job:{id:string;leaseId:string}}>('call.claimRecording', {}, ctx, opts);
    const payload = { jobId: claimed.result.job.id, leaseId: claimed.result.job.leaseId, durationSeconds: 180,
      transcript: 'Please connect me to staff. Staff handled the rest of the call.',
      recordingUrl: 'https://recordings.telnyx.com/direct.mp3',
      analysis: { summary: 'Caller requested staff and was transferred.', segments: [{ start: 0, end: 180, category: 'business' }] } };
    expect((await dispatch<{billableSeconds:number}>('call.completeRecording', payload, ctx, opts)).result.billableSeconds).toBe(13);
    expect((await dispatch<{completed:boolean}>('call.completeRecording', payload, ctx, opts)).result.completed).toBe(false);
    const [call] = await withTenant(tenant, tx => tx`select id,outcome,duration_seconds,billable_seconds,recording_id from phone_calls where provider_call_id=${providerCallId}`);
    expect(call).toMatchObject({ outcome: 'transferred_to_human', duration_seconds: 180, billable_seconds: 13, recording_id: 'direct-sip-audio' });
    expect(await withTenant(tenant, tx => tx`select qty from usage_events where meta->>'providerCallId'=${providerCallId}`)).toEqual([{ qty: 1 }]);
    expect(await withTenant(tenant, tx => tx`select id from email_outbox where entity_type='phone_call' and entity_id=${call!.id}`)).toHaveLength(1);
  });

  it('shows human-only forwarded calls without pending AI minutes or quota charges', async () => {
    const opts = { systemOrigin: 'test_direct_sip', idempotencyKey: 'direct-staff-only' };
    const payload = { providerCallId: 'direct-staff-only', fromE164: '+12025550777', toE164: phone,
      durationSeconds: 600, outcome: 'transferred_to_human', deferBilling: true, aiBypassed: true };
    await dispatch('call.record', payload, ctx, opts);
    await dispatch('call.record', payload, ctx, opts);
    const [call] = await withTenant(tenant, tx => tx`select duration_seconds,billable_seconds,voice_billing_status from phone_calls where provider_call_id='direct-staff-only'`);
    expect(call).toEqual({ duration_seconds: 600, billable_seconds: 0, voice_billing_status: 'settled' });
    expect(await withTenant(tenant, tx => tx`select id from usage_events where meta->>'providerCallId'='direct-staff-only'`)).toHaveLength(0);
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
