import {initialVoiceContext} from './v2';
import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { tenantForPhoneNumber, withTenant } from '@gf/db';
import { rawBodyOf } from '../rawBody';
import { verifyTelnyxSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../telnyx/verify';
import { assertAiAdmission } from '../billing/aiAdmission';
import { getRecordingMetadata } from './provider';
import { dispatch } from '../bus';
import '../handlers/voiceProcessing';

const escapeXml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const response = (s: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${s}</Response>`;
const e164 = /^\+[1-9]\d{7,14}$/;

/** Telnyx, rather than the model or an in-memory timer, owns the 600-second cutoff. */
export function xaiDialXml(phone: string, sipHost: string, callbackBase: string): string {
  if (!e164.test(phone) || !/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(sipHost)) throw new Error('Invalid SIP route');
  const callback = new URL('/v1/telnyx/xai/recording', callbackBase);
  if (callback.protocol !== 'https:') throw new Error('HTTPS callback required');
  callback.searchParams.set('number', phone);
  return response(`<Dial timeLimit="600" timeout="20" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(callback.href)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"><Sip>sip:${phone}@${escapeXml(sipHost)}</Sip></Dial><Hangup/>`);
}

export function registerXaiTexmlRoutes(app: FastifyInstance) {
  function verified(req: { headers: Record<string, unknown>; body: unknown }) {
    const raw = rawBodyOf(req);
    verifyTelnyxSignature({ rawBody: raw, publicKeyB64: process.env.TELNYX_PUBLIC_KEY ?? '',
      signatureB64: req.headers[SIGNATURE_HEADER] as string | undefined,
      timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined });
    return Object.fromEntries(new URLSearchParams(raw));
  }
  app.post('/v1/telnyx/xai/inbound', async (req, reply) => {
    const body = verified(req);
    const phone = body.To ?? '';
    if (!e164.test(phone)) throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    const tenant = await tenantForPhoneNumber(phone);
    if (!tenant?.assistantId?.startsWith('agent_')) return reply.type('application/xml').send(response('<Reject/>'));
    let admitted = tenant.aiAnswer;
    try { if (admitted) await assertAiAdmission({ ...tenant, membershipId: null }, 'voice_minute'); }
    catch (e) {
      if (!(e instanceof AppError)) throw e;
      admitted = false;
    }
    if (!admitted) {
      const [transfer] = await withTenant({ ...tenant, membershipId: null }, tx => tx<{ e164: string }[]>`
        select e164 from phone_lines where location_id=${tenant.locationId} and purpose='transfer_target' and active limit 1`);
      const dial = transfer && e164.test(transfer.e164) && transfer.e164 !== phone
        ? `<Dial timeLimit="600" timeout="20"><Number>${transfer.e164}</Number></Dial><Hangup/>` : '<Reject/>';
      return reply.type('application/xml').send(response(dial));
    }
    const sipHost = process.env.XAI_SIP_HOST;
    const base = process.env.XAI_TEXML_BASE_URL;
    if (!sipHost || !base) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE);
    if(tenant.toolTokenDigest) {
      const ctx:CommandContext={...tenant,membershipId:null,userId:'00000000-0000-4000-8000-000000000000',actorKind:'api',locale:'en',permissions:new Set(['appointment.write','call.draft'])};
      void initialVoiceContext(ctx,tenant.toolTokenDigest).catch(()=>app.log.warn('Voice context prewarm failed; tool will retry'));
    }
    return reply.type('application/xml').send(xaiDialXml(phone, sipHost, base));
  });
  app.post('/v1/telnyx/xai/recording', async (req, reply) => {
    const body = verified(req);
    if (body.RecordingStatus !== 'completed' || !body.RecordingSid) return reply.send({ ok: true });
    const phone = (req.query as { number?: string }).number ?? '';
    if (!e164.test(phone)) throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    const tenant = await tenantForPhoneNumber(phone);
    if (!tenant?.assistantId?.startsWith('agent_')) throw new AppError(ERROR_CODES.NOT_FOUND);
    const recording = await getRecordingMetadata(body.RecordingSid);
    // The provider lookup must corroborate tenant routing; a URL parameter is not proof.
    const to = String(recording.to ?? '');
    if (to !== phone && !to.startsWith(`sip:${phone}@`)) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    const ctx: CommandContext = { ...tenant, membershipId: null, userId: '00000000-0000-4000-8000-000000000000',
      actorKind: 'api', locale: 'en', permissions: new Set(['call.draft']) };
    if (!recording.call_session_id) throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    await dispatch('call.queueRecording', { recordingId: body.RecordingSid,
      providerCallId: String(recording.call_session_id), to: phone,
      ...(e164.test(recording.from ?? '') ? { from: recording.from } : {}),
      ...(recording.recording_started_at ? { startedAt: new Date(recording.recording_started_at).toISOString() } : {}),
      durationSeconds: Math.ceil(Number(recording.duration_millis) / 1000) }, ctx,
    { systemOrigin: 'telnyx_texml_recording' });
    return { ok: true };
  });
}
