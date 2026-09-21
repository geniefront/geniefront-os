import { ownerLocaleOf } from '../email/locale';
import {labelDiarizedTurns} from './transcript';
import type { FastifyInstance } from 'fastify';
import type { CommandContext } from '@gf/contracts';
import { sql, withTenant, tenantForPhoneNumber } from '@gf/db';
import { dispatch } from '../bus';
import { getRecording, transcribeRecording, classifyRecording, recentRecordings } from './provider';
import { flushEmails } from '../email/flush';
import { flushSms } from '../sms/flush';
import '../handlers/voiceProcessing';

/** Recover late/missed provider callbacks. The recording ID remains in Telnyx storage. */
export async function reconcileVoiceRecordings() {
  for (const r of await recentRecordings()) {
    const at = new Date(r.recording_started_at);
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() - 60 * 60_000
      || !r.call_session_id || !/^\+[1-9]\d{7,14}$/.test(r.to ?? '')) continue;
    const t = await tenantForPhoneNumber(r.to);
    if (!t?.assistantId?.startsWith('agent_')) continue;
    const ctx: CommandContext = { ...t, membershipId: null, userId: '00000000-0000-4000-8000-000000000000',
      actorKind: 'api', locale: 'en', permissions: new Set(['call.draft']) };
    const known = await withTenant(ctx, tx => tx`select id from voice_processing_jobs where location_id=${t.locationId} and provider_call_id=${r.call_session_id}`);
    if (known.length) continue;
    await dispatch('call.queueRecording', { providerCallId: r.call_session_id, recordingId: r.id, to: r.to,
      ...(typeof r.from === 'string' && /^\+[1-9]\d{7,14}$/.test(r.from) ? { from: r.from } : {}),
      startedAt: at.toISOString(), durationSeconds: Math.ceil(Number(r.duration_millis) / 1000) }, ctx,
    { systemOrigin: 'voice_recording_reconcile' });
  }
}

export async function processVoiceRecordings(app: Pick<FastifyInstance, 'log'>) {
  if (!process.env.XAI_API_KEY) return;
  const tenants = await sql<{ org_id: string; location_id: string }[]>`select * from gf_voice_pending_tenants()`;
  for (const t of tenants) {
    const ctx: CommandContext = { orgId: t.org_id, locationId: t.location_id, membershipId: null,
      userId: '00000000-0000-4000-8000-000000000000', actorKind: 'api', locale: 'en', timezone: 'UTC', permissions: new Set(['call.draft']) };
    const opts = { systemOrigin: 'voice_recording_worker' };
    const { result } = await dispatch<{ job: { id: string; leaseId: string; recordingId: string; payload: Record<string, unknown> } | null }>(
      'call.claimRecording', {}, ctx, opts);
    const job = result.job; if (!job) continue;
    try {
      const recording = await getRecording(job.recordingId);
      const transcript = await transcribeRecording(recording.bytes, recording.type, recording.channels);
      const durationSeconds = recording.durationSeconds || Number(job.payload.durationSeconds) || Math.ceil(Number(transcript.duration));
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 86400) throw new Error('Invalid recording duration');
      const [org] = await withTenant(ctx, tx => tx<{default_locale:string|null}[]>`
        select default_locale from organizations where id=${ctx.orgId}`);
      const analysis = await classifyRecording(transcript, durationSeconds, ownerLocaleOf(org?.default_locale));
      await dispatch('call.completeRecording', { jobId: job.id, leaseId: job.leaseId, durationSeconds,
        transcript: transcript.text, turns: labelDiarizedTurns(transcript.turns, analysis.speakers), analysis, recordingUrl: recording.url }, ctx, opts);
      await flushEmails(ctx, app.log); await flushSms(ctx, app.log);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'Voice processing failed';
      await dispatch('call.failRecording', { jobId: job.id, leaseId: job.leaseId, reason }, ctx, opts);
      app.log.warn({ jobId: job.id, reason }, 'Voice recording requires retry');
    }
  }
}
export function startVoiceProcessing(app: FastifyInstance) {
  if (!process.env.XAI_API_KEY) return;
  let busy = false;
  let reconciledAt = 0;
  const run = async () => { if (busy) return; busy = true;
    try {
      if (Date.now() - reconciledAt > 5 * 60_000) {
        try { await reconcileVoiceRecordings(); reconciledAt = Date.now(); }
        catch { app.log.warn('Voice recording reconciliation will retry'); }
      }
      await processVoiceRecordings(app);
    } catch { app.log.error('Voice recording worker failed'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void run(), 30_000); timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
