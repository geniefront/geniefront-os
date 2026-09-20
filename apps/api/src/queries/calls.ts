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
  /** 这通电话调过哪些工具。`book_appointment` 在里面 = 真订上了 */
  toolsUsed: string[];
  /** ⭐ 它有没有真的订上单 —— 前台扫一眼列表就要能分辨 */
  booked: boolean;
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
  opts: { days?: number; limit?: number; callId?: string } = {},
): Promise<{ calls: CallView[]; bookedCount: number; totalMinutes: number; voiceNumber: string | null }> {
  const days = Math.min(90, Math.max(1, opts.days ?? 7));
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const canSeeContact = ctx.permissions.has('customer.view_contact');

  const rows = await tx<{
    id: string; from_e164: string | null; started_at: string | Date | null;
    duration_seconds: number | null; outcome: string | null;
    recording_id: string | null; voice_billing_status: string; billable_seconds: number | null;
    tools_used: string[] | null; recording_url: string | null; transcript: unknown; summary: string | null;
  }[]>`
    select id, from_e164, started_at, duration_seconds, outcome,
           tools_used, recording_url, summary, transcript, recording_id, voice_billing_status, billable_seconds
    from phone_calls
    where location_id = ${ctx.locationId}
      and (${opts.callId ?? null}::uuid is null or id=${opts.callId ?? null}::uuid)
      and (${opts.callId ?? null}::uuid is not null or created_at > now() - make_interval(days => ${days}))
    order by coalesce(started_at, created_at) desc
    limit ${limit}`;

  const calls = rows.map((r) => {
    const tools = r.tools_used ?? [];
    return {
      callId: r.id,
      fromE164: maskPhone(r.from_e164, canSeeContact),
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      durationSeconds: r.duration_seconds,
      outcome: r.outcome,
      toolsUsed: tools,
      booked: tools.includes('book_appointment'),
      recordingUrl: r.recording_url,
      recordingId: r.recording_id,
      billingStatus: r.voice_billing_status,
      billableSeconds: r.billable_seconds,
      summary: r.summary,
      transcript: Array.isArray(r.transcript) ? r.transcript as CallLine[] : [],
    };
  });

  const [line] = await tx<{e164:string}[]>`select e164 from phone_lines where location_id=${ctx.locationId} and purpose='ai_voice' and active limit 1`;
  return {
    voiceNumber: line?.e164 ?? null,
    calls,
    /** 这段时间有几通真的订上了单 —— 老板问「这东西值不值」问的就是它 */
    bookedCount: calls.filter((c) => c.booked).length,
    /** 计费口径：每通向上取整到分钟（和 `call.record` 一致） */
    totalMinutes: calls.reduce((n, c) => n + Math.ceil((c.durationSeconds ?? 0) / 60), 0),
  };
}
