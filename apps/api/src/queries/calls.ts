/**
 * 「来电记录」——前台看得到 AI 在电话里到底说了什么（sql/0037）。
 *
 * ## 为什么这一页非有不可
 *
 * 2026-08-22 决策 6 改成「AI 直接建单」之后，前台不再逐单复核 ——
 * 客人挂电话时单子已经落地了。那么当客人到店说「你们电话里明明说
 * 五点」的时候，**转录是唯一的证据**。它同时是 `04` §9 那个问题
 * （「AI 到底准不准」）唯一诚实的度量来源。
 *
 * ## 谁能看
 *
 * `appointment.read`（前台本来就在旁边听这通电话）。
 * ⚠️ 但**来电号码按 `customer.view_contact` 脱敏** —— 和来电复核屏
 * 同一个口径：能看见有这通电话，不等于能抄走客人的号码（决策 16 防挖客）。
 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';

export interface CallLine {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  startSeconds?: number;
  endSeconds?: number;
  speaker?: number;
  at?: string;
  tool?: string;
}

export interface CallView {
  callId: string;
  /** 已按 `customer.view_contact` 脱敏 */
  fromE164: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  outcome: string | null;
  /** Tools attempted during the call; not evidence of a committed booking. */
  toolsUsed: string[];
  /** ⭐ 它有没有真的订上单 —— 前台扫一眼列表就要能分辨 */
  booked: boolean;
  appointmentIds: string[];
  appointmentActions: Array<{appointmentId:string;action:string;outcome:string}>;
  recordingUrl: string | null;
  recordingId: string | null;
  billingStatus: string;
  billableSeconds: number | null;
  summary?: string | null;
  transcript: CallLine[];
}

const maskPhone = (e164: string | null, canSee: boolean): string | null => {
  if (!e164) return null;
  if (canSee) return e164;
  // 「尾号 6667」够前台在店里对上人，又抄不走
  return `••••${e164.slice(-4)}`;
};

export async function loadCalls(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  opts: { days?: number; limit?: number; callId?: string; offset?: number; fromDate?: string | undefined; toDate?: string | undefined } = {},
): Promise<{ total: number; calls: CallView[]; bookedCount: number; totalMinutes: number; voiceNumber: string | null }> {
  const days = Math.min(90, Math.max(1, opts.days ?? 7));
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const canSeeContact = ctx.permissions.has('customer.view_contact');

  const rows = await tx<{
    total: number; appointment_ids: string[]; appointment_actions: CallView["appointmentActions"]; id: string; from_e164: string | null; started_at: string | Date | null;
    duration_seconds: number | null; outcome: string | null;
    recording_id: string | null; voice_billing_status: string; billable_seconds: number | null;
    tools_used: string[] | null; recording_url: string | null; transcript: unknown; summary: string | null;
  }[]>`
    select count(*) over()::int as total, id, from_e164, started_at, duration_seconds, outcome,
           array(select a.id::text from appointments a where a.location_id=phone_calls.location_id
             and (a.provider_call_id=phone_calls.provider_call_id or exists (
               select 1 from call_drafts d where d.call_id=phone_calls.id and d.appointment_id=a.id and d.status='confirmed'
             ))) as appointment_ids,
           coalesce((select jsonb_agg(jsonb_build_object('appointmentId',v.appointment_id,'action',v.action,'outcome',v.outcome) order by v.occurred_at)
            from voice_appointment_activity v where v.location_id=phone_calls.location_id and v.call_id=phone_calls.id),'[]'::jsonb) as appointment_actions,
           tools_used, recording_url, summary, transcript, recording_id, voice_billing_status, billable_seconds
    from phone_calls
    where location_id = ${ctx.locationId}
      and (${opts.callId ?? null}::uuid is null or id=${opts.callId ?? null}::uuid)
      and (${opts.callId ?? null}::uuid is not null or ${opts.fromDate ?? null}::date is not null or created_at > now() - make_interval(days => ${days}))
      and (${opts.fromDate ?? null}::date is null or created_at >= (${opts.fromDate ?? null}::date::timestamp at time zone (select timezone from locations where id=${ctx.locationId})))
      and (${opts.toDate ?? null}::date is null or created_at < ((${opts.toDate ?? null}::date + 1)::timestamp at time zone (select timezone from locations where id=${ctx.locationId})))
    order by coalesce(started_at, created_at) desc, id
    limit ${limit} offset ${Math.max(0, Math.floor(opts.offset ?? 0))}`;

  const calls = rows.map((r) => {
    const tools = r.tools_used ?? [];
    return {
      callId: r.id,
      fromE164: maskPhone(r.from_e164, canSeeContact),
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      durationSeconds: r.duration_seconds,
      outcome: r.outcome,
      toolsUsed: tools,
      booked: r.appointment_ids.length > 0,
      appointmentIds: [...new Set([...r.appointment_ids,...r.appointment_actions.map(a=>a.appointmentId)])],
      appointmentActions: r.appointment_actions,
      recordingUrl: canSeeContact ? r.recording_url : null,
      recordingId: canSeeContact ? r.recording_id : null,
      billingStatus: r.voice_billing_status,
      billableSeconds: r.billable_seconds,
      summary: canSeeContact ? r.summary : null,
      transcript: canSeeContact && Array.isArray(r.transcript) ? r.transcript as CallLine[] : [],
    };
  });

  const [line] = await tx<{e164:string}[]>`select e164 from phone_lines where location_id=${ctx.locationId} and purpose='ai_voice' and active limit 1`;
  return {
    total: rows[0]?.total ?? 0,
    voiceNumber: line?.e164 ?? null,
    calls,
    /** 这段时间有几通真的订上了单 —— 老板问「这东西值不值」问的就是它 */
    bookedCount: calls.filter((c) => c.booked).length,
    /** 计费口径：每通向上取整到分钟（和 `call.record` 一致） */
    totalMinutes: calls.reduce((n, c) => n + Math.ceil((c.durationSeconds ?? 0) / 60), 0),
  };
}
