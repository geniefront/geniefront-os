import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { buildContext } from '../actor';
import { dispatch } from '../bus';
import { directRecordingBoundary, directSipRoutes, recordingBoundary, sipRecords, syncDirectSipRouting, type SipRecord } from './directSip';
import { callerFromSystemHeaders } from './manage';

const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
const route = { number: '+15125550199', numberId: '12345', connectionId: '67890' };
const staff = '+12025550188';
const at = Date.parse('2026-09-23T01:11:59Z');
const recording = { connection_id: route.connectionId, call_session_id: 'session', call_leg_id: 'inbound',
  to: route.number, from: '+12025550123', recording_started_at: new Date(at).toISOString(), duration_millis: 85000 };
const inbound: SipRecord = { id: 'inbound', telnyx_session_id: 'session', connection_id: route.connectionId,
  cli: recording.from, cld: route.number, direction: 'inbound', is_callcontrol: false,
  started_at: new Date(at - 2000).toISOString(), answered_at: new Date(at).toISOString(), finished_at: new Date(at + 85000).toISOString() };
const transferred: SipRecord = { ...inbound, id: 'staff-leg', cld: staff, direction: 'outbound', started_at: new Date(at + 13000).toISOString() };
const now = at + 300000;
beforeAll(async () => {
  const [m] = await withTenant(tenant, tx => tx<{ id: string; user_id: string }[]>`select id,user_id from memberships where location_id=${tenant.locationId} and status='active' order by created_at limit 1`);
  const ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  await dispatch('location.savePhoneLine', { e164: route.number, purpose: 'ai_voice', active: true, aiAnswer: true, assistantId: 'agent_test' }, ctx, { systemOrigin: 'test_direct_sip' });
  await dispatch('location.savePhoneLine', { e164: staff, purpose: 'transfer_target', active: true }, ctx, { systemOrigin: 'test_direct_sip' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await closeDb(); });

it('bills only the 13 AI seconds of an 85-second transferred call', () => {
  expect(directRecordingBoundary(recording, [inbound, transferred], now)).toEqual({ aiDurationSeconds: 13, outcome: 'transferred_to_human' });
});
it('does not treat another session, caller or connection as a transfer', () => {
  expect(directRecordingBoundary(recording, [inbound, { ...transferred, telnyx_session_id: 'other' },
    { ...transferred, cli: '+12025550999' }, { ...transferred, connection_id: 'other' }], now))
    .toEqual({ aiDurationSeconds: 85, outcome: 'completed' });
});
it('waits for missing, ambiguous or still-settling provider records', () => {
  expect(directRecordingBoundary(recording, [], now)).toBeNull();
  expect(directRecordingBoundary(recording, [inbound, inbound], now)).toBeNull();
  expect(directRecordingBoundary(recording, [inbound], at + 90000)).toBeNull();
  expect(directRecordingBoundary(recording, [{ ...inbound, cli: '+12025550999' }], now)).toBeNull();
});
it('does not bill an AI-disabled call forwarded directly to staff', () => {
  expect(directRecordingBoundary(recording, [{ ...inbound, cf_number: staff }], now)?.aiDurationSeconds).toBe(0);
});
it('keeps business tools usable on a one-hour call but rejects stale/future identities', () => {
  const headers = (time: number) => ({ headers: { 'x-gf-caller-number': recording.from, 'x-gf-call-start-time': new Date(time).toISOString() } });
  expect(callerFromSystemHeaders(headers(Date.now() - 3600_000)).caller).toBe(recording.from);
  expect(() => callerFromSystemHeaders(headers(Date.now() - 25 * 3600_000))).toThrow();
  expect(() => callerFromSystemHeaders(headers(Date.now() + 120000))).toThrow();
});
it('paginates complete SIP sessions before deriving a billing boundary', async () => {
  vi.stubEnv('TELNYX_API_KEY', 'test');
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [inbound], meta: { total_pages: 2 } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [transferred], meta: { total_pages: 2 } }) });
  vi.stubGlobal('fetch', fetcher);
  expect(await sipRecords('session')).toEqual([inbound, transferred]);
  expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get('page[number]')).toBe('2');
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('filter[telnyx_session_id]')).toBe('session');
});
it('requires explicit, valid direct SIP configuration', () => {
  vi.stubEnv('XAI_DIRECT_SIP_ROUTES', '[]'); expect(directSipRoutes()).toEqual([]);
  vi.stubEnv('XAI_DIRECT_SIP_ROUTES', JSON.stringify([{ ...route, number: 'bad' }]));
  expect(() => directSipRoutes()).toThrow();
});
it('requires provider corroboration even when a direct recording omits its connection ID', async () => {
  vi.stubEnv('TELNYX_API_KEY', 'test');
  vi.stubEnv('XAI_DIRECT_SIP_ROUTES', JSON.stringify([route]));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [inbound, transferred], meta: { total_pages: 1 } }) }));
  expect(await recordingBoundary({ ...recording, connection_id: undefined })).toEqual({ aiDurationSeconds: 13, outcome: 'transferred_to_human' });
});

function providerMock() {
  vi.stubEnv('TELNYX_API_KEY', 'test');
  vi.stubEnv('XAI_DIRECT_SIP_ROUTES', JSON.stringify([route]));
  const number = { phone_number: route.number, connection_id: route.connectionId };
  const voice = { call_forwarding: { call_forwarding_enabled: false },
    call_recording: { inbound_call_recording_enabled: false, inbound_call_recording_channels: 'single', inbound_call_recording_format: 'wav' } };
  const patches: Array<{ path: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (init.method === 'PATCH') patches.push({ path, body: JSON.parse(init.body as string) });
    return { ok: true, json: async () => ({ data: path.endsWith('/voice') ? voice : number }) };
  }));
  return { number, voice, patches, log: { info: vi.fn(), warn: vi.fn() } };
}
it('enables dual recording on the direct route without a webhook or time limit', async () => {
  const mock = providerMock();
  await syncDirectSipRouting(mock);
  expect(mock.log.warn).not.toHaveBeenCalled();
  expect(mock.patches).toHaveLength(1);
  expect(mock.patches[0]!.body.call_recording).toEqual({ inbound_call_recording_enabled: true, inbound_call_recording_channels: 'dual', inbound_call_recording_format: 'mp3' });
  expect(JSON.stringify(mock.patches)).not.toMatch(/webhook|600|timeLimit/);
});
it('forwards to staff when AI is disabled and stops recording human-only calls', async () => {
  const mock = providerMock();
  await withTenant(tenant, tx => tx`update phone_lines set ai_answer=false where e164=${route.number} and location_id=${tenant.locationId}`);
  try {
    await syncDirectSipRouting(mock);
    expect(mock.patches[0]!.body.call_forwarding).toEqual({ call_forwarding_enabled: true, forwards_to: staff, forwarding_type: 'always' });
    expect(mock.patches[0]!.body.call_recording.inbound_call_recording_enabled).toBe(false);
  } finally { await withTenant(tenant, tx => tx`update phone_lines set ai_answer=true where e164=${route.number} and location_id=${tenant.locationId}`); }
});
it('does not modify a provider number that no longer matches the configured binding', async () => {
  const mock = providerMock(); mock.number.phone_number = '+12025550999';
  await syncDirectSipRouting(mock);
  expect(mock.patches).toHaveLength(0); expect(mock.log.warn).toHaveBeenCalledOnce();
});
it('routes subsequent calls to staff when the AI minute quota is exhausted', async () => {
  const mock = providerMock();
  const [before] = await withTenant(tenant, tx => tx<{ included_minutes_used: number; voice_minute_balance: number }[]>`
    select included_minutes_used,voice_minute_balance from billing_accounts where location_id=${tenant.locationId}`);
  await withTenant(tenant, tx => tx`update billing_accounts set included_minutes_used=999999,voice_minute_balance=0 where location_id=${tenant.locationId}`);
  try {
    await syncDirectSipRouting(mock);
    expect(mock.log.warn).not.toHaveBeenCalled();
    expect(mock.patches[0]!.body.call_forwarding.call_forwarding_enabled).toBe(true);
    expect(mock.patches[0]!.body.call_recording.inbound_call_recording_enabled).toBe(false);
  } finally {
    await withTenant(tenant, tx => tx`update billing_accounts set included_minutes_used=${before!.included_minutes_used},voice_minute_balance=${before!.voice_minute_balance} where location_id=${tenant.locationId}`);
  }
});
it('stops AI routing if disabled without a staff fallback, without changing other numbers', async () => {
  const mock = providerMock();
  await withTenant(tenant, tx => tx`update phone_lines set ai_answer=false where e164=${route.number} and location_id=${tenant.locationId}`);
  await withTenant(tenant, tx => tx`update phone_lines set active=false where purpose='transfer_target' and location_id=${tenant.locationId}`);
  try {
    await syncDirectSipRouting(mock);
    expect(mock.patches).toEqual([{ path: '/v2/phone_numbers/12345', body: { connection_id: null } }]);
  } finally {
    await withTenant(tenant, tx => tx`update phone_lines set ai_answer=true where e164=${route.number} and location_id=${tenant.locationId}`);
    await withTenant(tenant, tx => tx`update phone_lines set active=true where purpose='transfer_target' and location_id=${tenant.locationId}`);
  }
});
