import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  cdr: vi.fn(), recordings: vi.fn(), boundary: vi.fn(), dispatch: vi.fn(), tenant: vi.fn(),
}));
vi.mock('@gf/db', () => ({
  sql: vi.fn(), withTenant: async () => [], tenantForPhoneNumber: mocks.tenant,
}));
vi.mock('../bus', () => ({ dispatch: mocks.dispatch }));
vi.mock('../handlers/voiceProcessing', () => ({}));
vi.mock('../billing/autoTopup', () => ({ billingSystemContext: vi.fn(), maybeAutoTopup: vi.fn() }));
vi.mock('../email/flush', () => ({ flushEmails: vi.fn() }));
vi.mock('../sms/flush', () => ({ flushSms: vi.fn() }));
vi.mock('./directSip', () => ({ reconcileDirectSipCalls: mocks.cdr, recordingBoundary: mocks.boundary }));
vi.mock('./provider', () => ({ recentRecordings: mocks.recordings, getRecording: vi.fn(), transcribeRecording: vi.fn(), classifyRecording: vi.fn() }));
import { reconcileVoiceRecordings, reconcileVoiceSources } from './worker';
afterEach(() => vi.resetAllMocks());
const recording = (id: string) => ({ id, call_session_id: id, to: '+12025550199', from: 'Anonymous',
  recording_started_at: new Date(Date.now() - 600000).toISOString(), recording_ended_at: new Date(Date.now() - 500000).toISOString(), duration_millis: 60000 });
it('imports recordings even if the call-detail reconciliation fails', async () => {
  mocks.cdr.mockRejectedValue(new Error('malformed CDR'));
  mocks.recordings.mockResolvedValue([]);
  const log = { warn: vi.fn() };
  await reconcileVoiceSources({ log } as any);
  expect(mocks.recordings).toHaveBeenCalledOnce();
  expect(log.warn).toHaveBeenCalledOnce();
});
it('continues past one bad recording and omits anonymous caller IDs from commands', async () => {
  mocks.recordings.mockResolvedValue([recording('bad'), recording('good')]);
  mocks.tenant.mockResolvedValue({ orgId: 'org', locationId: 'location', assistantId: 'agent_test' });
  mocks.boundary.mockRejectedValueOnce(new Error('missing CDR')).mockResolvedValueOnce({ aiDurationSeconds: 60, callerChannel: 1 });
  mocks.dispatch.mockResolvedValue({ result: { queued: true } });
  await expect(reconcileVoiceRecordings()).rejects.toThrow('failed for 1 recording(s): bad');
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  expect(mocks.dispatch.mock.calls[0]?.[1]).toMatchObject({ providerCallId: 'good', recordingId: 'good' });
  expect(mocks.dispatch.mock.calls[0]?.[1]).not.toHaveProperty('from');
});
