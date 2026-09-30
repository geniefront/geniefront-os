import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError, type CommandContext } from '@gf/contracts';
import { tenantForPhoneNumber, withTenant } from '@gf/db';
import { assertAiAdmission } from '../billing/aiAdmission';
import { dispatch } from '../bus';
import '../handlers/phone';

const e164 = /^\+[1-9]\d{7,14}$/;
const routesSchema = z.array(z.object({ number: z.string().regex(e164),
  numberId: z.string().regex(/^\d+$/), connectionId: z.string().regex(/^\d+$/) }).strict());
export function directSipRoutes() {
  return routesSchema.parse(JSON.parse(process.env.XAI_DIRECT_SIP_ROUTES ?? '[]'));
}

async function telnyx(path: string, body?: unknown) {
  if (!process.env.TELNYX_API_KEY) throw new Error('Telnyx is not configured');
  const result = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: body ? 'PATCH' : 'GET',
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new Error(`Direct SIP provider request failed (${result.status})`);
  return result.json() as Promise<Record<string, any>>;
}

export interface SipRecord {
  id: string; telnyx_session_id: string; connection_id: string;
  cli: string | null; cld: string; direction: string; is_callcontrol: boolean;
  started_at: string; answered_at?: string; finished_at: string;
  connected?: number; hangup_cause?: string; cf_number?: string;
}

/** A complete session is needed: the outbound staff leg supplies the AI cutoff. */
export async function sipRecords(sessionId?: string): Promise<SipRecord[]> {
  const results: SipRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ 'filter[record_type]': 'sip-trunking',
      'page[size]': '100', 'page[number]': String(page) });
    if (sessionId) query.set('filter[telnyx_session_id]', sessionId);
    else query.set('filter[finished_at][gte]', new Date(Date.now() - 24 * 3600_000).toISOString());
    const body = await telnyx(`/detail_records?${query}`);
    if (!Array.isArray(body.data)) throw new Error('Invalid SIP detail records');
    results.push(...body.data);
    if (page >= parseInt(String(body.meta?.total_pages ?? 1), 10)) return results;
  }
  throw new Error('SIP detail records exceeded the reconciliation page limit');
}

export interface RecordingIdentity {
  connection_id?: string; call_session_id: string; call_leg_id?: string;
  to: string; from: string | null; recording_started_at: string; duration_millis: number;
}
/** Providers represent withheld caller ID as null in CDRs and "Anonymous" in recordings.
 * Only explicit withheld markers are equivalent; never equate different real callers. */
export function sipCallerIdentity(value: string | null | undefined): string | null {
  if (value == null || /^(?:anonymous|restricted|unavailable|private)?$/i.test(value.trim())) return null;
  return value.trim();
}
export function directRecordingBoundary(recording: RecordingIdentity, records: SipRecord[], now = Date.now()) {
  const inbound = records.filter(r => r.telnyx_session_id === recording.call_session_id
    && r.connection_id === recording.connection_id && r.direction === 'inbound'
    && r.is_callcontrol === false && r.cld === recording.to && sipCallerIdentity(r.cli) === sipCallerIdentity(recording.from));
  // Let CDRs settle before charging; missing/ambiguous records are retried, never
  // interpreted as proof that the whole recording was AI time.
  if (inbound.length !== 1 || !Number.isFinite(Date.parse(inbound[0]!.finished_at))
    || now - Date.parse(inbound[0]!.finished_at) < 90_000) return null;
  const start = Date.parse(recording.recording_started_at);
  const duration = Math.ceil(Number(recording.duration_millis) / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0) return null;
  // A SIP transfer can rotate the recording's leg ID. Corroborate the unique
  // session/connection/number pair and recording window instead of equating legs.
  const callStart = Date.parse(inbound[0]!.answered_at ?? inbound[0]!.started_at);
  const callEnd = Date.parse(inbound[0]!.finished_at);
  if (!Number.isFinite(callStart) || start < callStart - 2000
    || start + Number(recording.duration_millis) > callEnd + 2000) return null;
  const callDurationSeconds = Math.max(duration, Math.round((callEnd - callStart) / 1000));
  const transfers = records.filter(r => r.telnyx_session_id === recording.call_session_id
    && r.connection_id === recording.connection_id && r.direction === 'outbound'
    && r.is_callcontrol === false && sipCallerIdentity(r.cli) === sipCallerIdentity(recording.from));
  if (transfers.some(r => !Number.isFinite(Date.parse(r.started_at)))) return null;
  const forwarded = Boolean(inbound[0]!.cf_number);
  const cutoff = forwarded ? 0 : transfers.length
    ? Math.max(0, Math.floor((Math.min(...transfers.map(r => Date.parse(r.started_at))) - start) / 1000))
    : duration;
  return { aiDurationSeconds: Math.min(duration, cutoff), callDurationSeconds, callerChannel: 1 as const,
    outcome: (forwarded || transfers.length ? 'transferred_to_human' : 'completed') as 'transferred_to_human' | 'completed' };
}

export async function recordingBoundary(recording: RecordingIdentity) {
  const route = directSipRoutes().find(r => r.number === recording.to);
  if (!route) return undefined;
  // Historical TeXML recordings retain their own connection ID. Missing SIP
  // metadata must be corroborated by CDRs, never default to charging the whole call.
  if (recording.connection_id && recording.connection_id !== route.connectionId) return undefined;
  return directRecordingBoundary({ ...recording, connection_id: route.connectionId }, await sipRecords(recording.call_session_id));
}

function context(t: NonNullable<Awaited<ReturnType<typeof tenantForPhoneNumber>>>): CommandContext {
  return { ...t, membershipId: null, userId: '00000000-0000-4000-8000-000000000000',
    actorKind: 'api', locale: 'en', permissions: new Set(['call.draft']) };
}

/** Direct trunks must stay free of call-control webhooks (which change routing). */
export async function syncDirectSipRouting(app: { log: Pick<FastifyInstance['log'], 'info' | 'warn'> }) {
  for (const route of directSipRoutes()) {
    try {
      const t = await tenantForPhoneNumber(route.number);
      if (!t?.assistantId?.startsWith('agent_')) continue;
      const ctx = context(t);
      const [store] = await withTenant(ctx, tx => tx<{ status: string; target: string | null }[]>`
        select l.status,(select p.e164 from phone_lines p where p.location_id=l.id
          and p.purpose='transfer_target' and p.active limit 1) as target
        from locations l where l.id=${ctx.locationId}`);
      let admitted = t.aiAnswer && Boolean(t.toolTokenDigest) && !['closed','suspended'].includes(store?.status ?? 'closed');
      if (admitted) {
        try { await assertAiAdmission(ctx, 'voice_minute'); }
        catch (e) {
          if (!(e instanceof AppError) || !['AI_QUOTA_EXHAUSTED','SUBSCRIPTION_PAST_DUE'].includes(e.code)) throw e;
          admitted = false;
        }
      }
      const target = store?.target && e164.test(store.target) && store.target !== route.number ? store.target : null;
      const number = (await telnyx(`/phone_numbers/${route.numberId}`)).data;
      if (number?.phone_number !== route.number) throw new Error('Direct SIP phone binding mismatch');
      const voice = (await telnyx(`/phone_numbers/${route.numberId}/voice`)).data;
      const forwarding = !admitted && Boolean(target);
      const desiredConnection = admitted || forwarding ? route.connectionId : null;
      const changed = voice.call_forwarding?.call_forwarding_enabled !== forwarding
        || (forwarding && (voice.call_forwarding?.forwards_to !== target || voice.call_forwarding?.forwarding_type !== 'always'))
        || voice.call_recording?.inbound_call_recording_enabled !== admitted
        || (admitted && (voice.call_recording?.inbound_call_recording_channels !== 'dual'
          || voice.call_recording?.inbound_call_recording_format !== 'mp3'));
      if (changed) await telnyx(`/phone_numbers/${route.numberId}/voice`, {
        call_forwarding: { call_forwarding_enabled: forwarding, ...(forwarding ? { forwards_to: target, forwarding_type: 'always' } : {}) },
        call_recording: { inbound_call_recording_enabled: admitted, inbound_call_recording_channels: 'dual', inbound_call_recording_format: 'mp3' },
      });
      if (number.connection_id !== desiredConnection) await telnyx(`/phone_numbers/${route.numberId}`, { connection_id: desiredConnection });
      if (changed || number.connection_id !== desiredConnection)
        app.log.info({ locationId: t.locationId, aiAnswer: admitted, forwarding }, 'Direct SIP routing synchronized');
    } catch (e) {
      app.log.warn({ numberId: route.numberId, reason: e instanceof Error ? e.message : 'sync_failed' }, 'Direct SIP routing will retry');
    }
  }
}

export function startDirectSipRouting(app: FastifyInstance) {
  if (!directSipRoutes().length) return;
  let running: Promise<void> | undefined;
  const run = () => {
    if (running) return;
    running = syncDirectSipRouting(app).finally(() => { running = undefined; });
  };
  const timer = setInterval(run, 30_000); timer.unref();
  app.addHook('onListen', async () => { run(); });
  app.addHook('onClose', async () => { clearInterval(timer); await running; });
}

/** Record missed/unrecorded calls too. Their AI billing stays pending until audio is verified. */
export async function reconcileDirectSipCalls() {
  const routes = directSipRoutes();
  if (!routes.length) return;
  const records = await sipRecords();
  const failed: string[] = [];
  for (const r of records) {
    try {
      const route = routes.find(route => route.connectionId === r.connection_id && route.number === r.cld);
      if (!route || r.direction !== 'inbound' || r.is_callcontrol !== false || !r.telnyx_session_id
        || !Number.isFinite(Date.parse(r.finished_at)) || Date.now() - Date.parse(r.finished_at) < 90_000) continue;
      const t = await tenantForPhoneNumber(route.number);
      if (!t?.assistantId?.startsWith('agent_')) continue;
      const ctx = context(t);
      const [line] = await withTenant(ctx, tx => tx<{ created_at: string }[]>`
        select created_at::text from phone_lines where location_id=${t.locationId} and e164=${route.number} and purpose='ai_voice' and active`);
      const start = r.answered_at ?? r.started_at;
      if (!line || !Number.isFinite(Date.parse(start)) || Date.parse(start) < Date.parse(line.created_at)) continue;
      const existing = await withTenant(ctx, tx => tx`select id from phone_calls where location_id=${t.locationId} and provider_call_id=${r.telnyx_session_id}`);
      if (existing.length) continue;
      const transferred = Boolean(r.cf_number) || records.some(other => other.telnyx_session_id === r.telnyx_session_id && other.direction === 'outbound');
      await dispatch('call.record', { providerCallId: r.telnyx_session_id,
        ...(r.cli && e164.test(r.cli) ? { fromE164: r.cli } : {}), toE164: r.cld,
        startedAt: start, endedAt: r.finished_at, durationSeconds: Math.max(0, Math.floor((Date.parse(r.finished_at) - Date.parse(start)) / 1000)),
        deferBilling: true, aiBypassed: Boolean(r.cf_number) || r.connected === 0,
        outcome: transferred ? 'transferred_to_human' : r.connected === 1 ? 'completed' : 'no_answer',
      }, ctx, { systemOrigin: 'direct_sip_reconcile', idempotencyKey: `telnyx-hangup-${r.telnyx_session_id}` });
    } catch {
      // A malformed provider record must not starve later calls in the batch.
      failed.push(r.telnyx_session_id);
    }
  }
  if (failed.length) throw new Error(`Direct SIP reconciliation failed for ${failed.length} call(s): ${failed.join(', ')}`);
}
