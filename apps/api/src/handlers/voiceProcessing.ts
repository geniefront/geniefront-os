import {isUnansweredGreeting} from '../voice/transcript';
import {linkVoiceActivities} from './voiceActivity';
import { shopCallSms } from '../sms/booking';
import { ownerLocaleOf } from '../email/locale';
import { notificationCopy } from '../notify/copy';
import { pickText } from '@gf/contracts';
import { renderVoiceCallEmail } from '../email/voiceCall';
import { voiceNotificationTargets } from '@gf/contracts';
import { randomUUID } from 'node:crypto';
import { QueueVoiceRecording, ClaimVoiceJob, CompleteVoiceJob, FailVoiceJob } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { billableVoiceSeconds } from '@gf/scheduling';
import { registerHandler } from '../bus';
import { chargeQuota } from '../billing/usage';
import { smsFrom, smsConfigured } from '../sms/send';
import { segmentsOf } from '../sms/segments';

registerHandler(QueueVoiceRecording, async ({ input, tx, ctx, audit }) => {
  // A reassigned number must never import or bill recordings from its previous shop.
  const [line] = await tx<{ created_at: string }[]>`select created_at::text from phone_lines
    where location_id=${ctx.locationId} and e164=${input.to} and purpose='ai_voice' and active limit 1`;
  if (!line || !input.startedAt || Date.parse(input.startedAt) < Date.parse(line.created_at)) {
    audit({ entityType: 'location', entityId: ctx.locationId,
      after: { recordingQueued: false, providerCallId: input.providerCallId, reason: 'outside_phone_binding' } });
    return { queued: false };
  }
  await tx`insert into voice_processing_jobs(org_id,location_id,provider_call_id,recording_id,payload)
    values(${ctx.orgId},${ctx.locationId},${input.providerCallId},${input.recordingId},${jsonb(input)}::jsonb)
    on conflict(location_id,provider_call_id) do nothing`;
  await tx`insert into phone_calls(org_id,location_id,provider_call_id,from_e164,to_e164,started_at,duration_seconds,outcome,recording_id,voice_billing_status)
    values(${ctx.orgId},${ctx.locationId},${input.providerCallId},${input.from ?? null},${input.to},${input.startedAt}::timestamptz,${input.callDurationSeconds ?? input.durationSeconds},${input.outcome ?? 'completed'},${input.recordingId},'pending')
    on conflict(provider_call_id) do update set recording_id=coalesce(phone_calls.recording_id,excluded.recording_id),
      voice_billing_status=case when phone_calls.voice_billing_status='legacy' then 'pending' else phone_calls.voice_billing_status end,
      duration_seconds=greatest(phone_calls.duration_seconds,excluded.duration_seconds),outcome=excluded.outcome,started_at=coalesce(phone_calls.started_at,excluded.started_at),
      from_e164=coalesce(nullif(excluded.from_e164,''),phone_calls.from_e164)
    where phone_calls.location_id=excluded.location_id`;
  await linkVoiceActivities(tx,ctx);
  audit({ entityType: 'location', entityId: ctx.locationId, after: { recordingQueued: true, providerCallId: input.providerCallId } });
  return { queued: true };
});
registerHandler(ClaimVoiceJob, async ({ tx, ctx, audit }) => {
  const leaseId = randomUUID();
  const [job] = await tx<{ id: string; provider_call_id: string; recording_id: string; payload: Record<string, unknown>; attempts: number }[]>`
    update voice_processing_jobs set status='processing', lease_id=${leaseId}, locked_until=now()+interval '5 minutes', attempts=attempts+1
    where id=(select id from voice_processing_jobs where location_id=${ctx.locationId}
      and ((status='pending' and retry_at<=now()) or (status='processing' and locked_until<now()))
      order by created_at for update skip locked limit 1)
    returning id,provider_call_id,recording_id,payload,attempts`;
  audit({ entityType: 'location', entityId: ctx.locationId, after: { recordingClaimed: job?.id ?? null } });
  return { job: job ? { id: job.id, leaseId, providerCallId: job.provider_call_id,
    recordingId: job.recording_id, payload: job.payload, attempts: job.attempts } : null };
});
registerHandler(FailVoiceJob, async ({ input, tx, ctx, audit }) => {
  await tx`update voice_processing_jobs set status=case when attempts>=5 then 'review' else 'pending' end,
    retry_at=now()+interval '2 minutes', locked_until=null,last_error=${input.reason}
    where id=${input.jobId} and location_id=${ctx.locationId} and lease_id=${input.leaseId} and status='processing'`;
  await tx`update phone_calls set voice_billing_status='review'
    where location_id=${ctx.locationId} and voice_billing_status='pending' and provider_call_id in (
      select provider_call_id from voice_processing_jobs where id=${input.jobId} and status='review')`;
  audit({ entityType: 'location', entityId: ctx.locationId, after: { recordingJob: input.jobId, failure: input.reason } });
  return { saved: true };
});
registerHandler(CompleteVoiceJob, async ({ input, tx, ctx, audit }) => {
  const [job] = await tx<{ provider_call_id: string; recording_id: string; payload: Record<string, unknown> }[]>`
    select provider_call_id,recording_id,payload from voice_processing_jobs
    where id=${input.jobId} and location_id=${ctx.locationId} and lease_id=${input.leaseId} and status='processing' for update`;
  if (!job) {
    audit({ entityType: 'location', entityId: ctx.locationId, after: { recordingCompletionSkipped: input.jobId } });
    return { completed: false };
  }
  const validatedSeconds = billableVoiceSeconds(input.durationSeconds, input.analysis.segments);
  const aiDurationSeconds = typeof job.payload.aiDurationSeconds === 'number'
    ? Math.max(0, Math.min(input.durationSeconds, job.payload.aiDurationSeconds)) : input.durationSeconds;
  const aiBusinessSeconds = Math.ceil(input.analysis.segments.filter(s => s.category === 'business')
    .reduce((total, s) => total + Math.max(0, Math.min(s.end, aiDurationSeconds) - Math.min(s.start, aiDurationSeconds)), 0));
  const unansweredGreeting = isUnansweredGreeting(input.durationSeconds,input.turns);
  const billableSeconds = unansweredGreeting ? 0 : Math.min(validatedSeconds, aiBusinessSeconds);
  const transcript = input.turns?.length ? input.turns : (input.transcript.match(/[\s\S]{1,4000}/g) ?? []).map(text => ({ role: 'system' as const, text }));
  const callDurationSeconds = typeof job.payload.callDurationSeconds === 'number' ? Math.max(input.durationSeconds, job.payload.callDurationSeconds) : input.durationSeconds;
  const [call] = await tx<{ id: string; voice_billing_status: string; duration_seconds: number }[]>`
    insert into phone_calls(org_id,location_id,provider_call_id,from_e164,to_e164,started_at,duration_seconds,
      outcome,transcript,recording_id,recording_url,summary,voice_billing_status)
    values(${ctx.orgId},${ctx.locationId},${job.provider_call_id},${String(job.payload.from ?? '')},${String(job.payload.to ?? '')},
      ${job.payload.startedAt ? String(job.payload.startedAt) : null}::timestamptz,${callDurationSeconds},${job.payload.outcome === 'transferred_to_human' ? 'transferred_to_human' : 'completed'},
      ${jsonb(transcript)}::jsonb,${job.recording_id},${input.recordingUrl},${input.analysis.summary},'pending')
    on conflict(provider_call_id) do update set transcript=excluded.transcript, recording_id=excluded.recording_id,
      recording_url=excluded.recording_url,summary=excluded.summary,duration_seconds=greatest(phone_calls.duration_seconds,excluded.duration_seconds),outcome=excluded.outcome
    returning id,voice_billing_status,duration_seconds`;
  await linkVoiceActivities(tx,ctx);
  if (call!.voice_billing_status === 'pending' || call!.voice_billing_status === 'review') {
    const minutes = Math.ceil(billableSeconds / 60);
    const [usage] = await tx<{ id: string }[]>`insert into usage_events(org_id,location_id,kind,qty,cost_cents,meta)
      values(${ctx.orgId},${ctx.locationId},'ai_call_min',${minutes},0,
        ${jsonb({ provider: 'telnyx_xai', providerCallId: job.provider_call_id, durationSeconds: input.durationSeconds,
          billableSeconds, aiDurationSeconds, exemptSeconds: input.durationSeconds - billableSeconds, costPending: true, ruleVersion: 3 })}::jsonb) returning id`;
    await chargeQuota(tx, ctx, { unit: 'voice_minute', amount: minutes, usageEventId: usage!.id, source: 'ai_call_min' });
    await tx`update phone_calls set voice_billing_status='settled',billable_seconds=${billableSeconds},
      billing_analysis=${jsonb({ ...input.analysis, unansweredGreeting, aiDurationSeconds, ruleVersion: 3 })}::jsonb where id=${call!.id}`;
  }
  // Exact provider IDs are preferred. Older voice clients can be linked only when
  // caller + recording window identifies a call unambiguously inside this tenant.
  if(job.payload.startedAt && job.payload.from){
    const start=new Date(String(job.payload.startedAt)),end=new Date(start.getTime()+input.durationSeconds*1000+30000);
    await tx`update appointments a set provider_call_id=${job.provider_call_id}
      from customers c where a.customer_id=c.id and a.location_id=${ctx.locationId} and a.source='phone_ai'
      and a.provider_call_id is null and c.phone_e164=${String(job.payload.from)}
      and a.created_at>=${start.toISOString()}::timestamptz and a.created_at<=${end.toISOString()}::timestamptz
      and not exists(select 1 from phone_calls p where p.location_id=${ctx.locationId} and p.id<>${call!.id}
        and p.from_e164=${String(job.payload.from)} and p.started_at<${end.toISOString()}::timestamptz
        and p.started_at+make_interval(secs=>coalesce(p.duration_seconds,0))>${start.toISOString()}::timestamptz)`;
  }
  const [linkedBooking]=await tx`select id from appointments where location_id=${ctx.locationId} and provider_call_id=${job.provider_call_id} limit 1`;
  const [shop] = await tx<{ default_locale: string | null; email: string | null; phone: string | null; name: unknown; settings: unknown; timezone: string }[]>`
    select o.default_locale,l.email,l.phone,l.name,l.settings,l.timezone from locations l join organizations o on o.id=l.org_id where l.id=${ctx.locationId}`;
  const locale = ownerLocaleOf(shop?.default_locale);
  const targets = voiceNotificationTargets(shop?.settings, { email: shop?.email ?? null, phone: shop?.phone ?? null });
  const detail = `${process.env.APP_BASE_URL ?? ''}/calls?call=${call!.id}`;
  if (targets.email && !linkedBooking && job.payload.suppressNotification !== true) {
    const email = renderVoiceCallEmail({ locale, shop: pickText(shop?.name, locale, notificationCopy(locale).shop),
      from: String(job.payload.from ?? ''), startedAt: job.payload.startedAt ? String(job.payload.startedAt) : undefined,
      timezone: shop?.timezone ?? 'America/New_York', durationSeconds: call!.duration_seconds,
      summary: input.analysis.summary, turns: transcript, detailUrl: detail });
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
      values(${ctx.orgId},${ctx.locationId},'platform_notice',${targets.email},${email.subject},${email.html},${email.text},'phone_call',${call!.id})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  if (targets.phone && smsConfigured() && !linkedBooking && job.payload.suppressNotification !== true
    && job.payload.outcome !== 'transferred_to_human') {
    const body = shopCallSms(locale, String(job.payload.from ?? ''));
    await tx`insert into sms_outbox(org_id,location_id,kind,to_e164,from_e164,body,segments,entity_type,entity_id)
      values(${ctx.orgId},${ctx.locationId},'direct_message',${targets.phone},${smsFrom()},${body},${segmentsOf(body)},'phone_call',${call!.id})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  await tx`update voice_processing_jobs set status='done',locked_until=null where id=${input.jobId}`;
  audit({ entityType: 'phone_call', entityId: call!.id, after: { billableSeconds, aiDurationSeconds, ruleVersion: 3 } });
  return { completed: true, billableSeconds };
});
