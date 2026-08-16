/**
 * 来电待复核队列 —— 前台屏幕上那一列（决策 6）。
 *
 * 一条原则贯穿这个视图：**把 AI「听到的」和「猜到的」分开摆**。
 *
 * 只显示匹配结果（「Gel Manicure · Amy · 明天 16:00」）的话，前台没法核对 ——
 * 那行字看起来永远是对的。把原话一起摆出来（客人说的是 "gel removal"），
 * 她一眼就能发现听岔了。这也是 `call_drafts` 每个要素存两个字段的原因。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import { pickText, type CommandContext } from '@gf/contracts';

export interface CallDraftView {
  draftId: string;
  status: string;
  fromE164: string | null;
  /** 决策 16 的口径：前台有 customer.view_contact 才给完整号码 */
  fromDisplay: string | null;
  createdAt: string;

  service: { heard: string | null; matchedId: string | null; matchedName: string | null };
  staff: { heard: string | null; matchedId: string | null; matchedName: string | null };
  time: { heard: string | null; slotStartsAt: string | null; durationMin: number | null };

  customer: { id: string | null; displayName: string | null } | null;
  /** 同号多客户时的候选（决策 21：绝不替前台挑一个） */
  candidates: Array<{ customerId: string; displayName: string; lastVisitOn: string | null }>;
  callerNameHeard: string | null;

  confidenceBp: number;
  lowConfidence: boolean;
  notes: string | null;
  /** 三要素齐了才能一键确认；缺哪个前台就得先补哪个 */
  readyToBook: boolean;
  missing: string[];
}

/** 低于这个值在队列里标黄。和拍照开店同一个阈值口径，只该有一份 */
const LOW_CONFIDENCE_BP = 8500;

export async function loadCallDrafts(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  status: string,
): Promise<{ drafts: CallDraftView[]; pendingCount: number }> {
  const wanted = ['pending', 'confirmed', 'dismissed'].includes(status) ? status : 'pending';
  const canSeeContact = ctx.permissions.has('customer.view_contact');

  const rows = await tx<{
    id: string; status: string; from_e164: string | null; created_at: string | Date;
    service_name_heard: string | null; service_id: string | null; service_name: unknown;
    staff_name_heard: string | null; staff_membership_id: string | null; staff_name: unknown;
    time_heard: string | null; slot_starts_at: string | Date | null; duration_min: number | null;
    customer_id: string | null; customer_name: string | null;
    customer_candidates: unknown; caller_name_heard: string | null;
    confidence_bp: number; notes: string | null;
  }[]>`
    select d.id, d.status, d.from_e164, d.created_at,
           d.service_name_heard, d.service_id, s.name as service_name,
           d.staff_name_heard, d.staff_membership_id, sp.display_name as staff_name,
           d.time_heard, d.slot_starts_at, d.duration_min,
           d.customer_id, c.display_name as customer_name,
           d.customer_candidates, d.caller_name_heard,
           d.confidence_bp, d.notes
    from call_drafts d
    left join services s on s.id = d.service_id
    left join staff_profiles sp on sp.membership_id = d.staff_membership_id
    left join customers c on c.id = d.customer_id
    where d.location_id = ${ctx.locationId} and d.status = ${wanted}
    order by d.created_at desc
    limit 50`;

  const [count] = await tx<{ n: string }[]>`
    select count(*) as n from call_drafts
    where location_id = ${ctx.locationId} and status = 'pending'`;

  const drafts = rows.map((r): CallDraftView => {
    // 一键确认要的是三要素齐全。缺哪个就明说缺哪个 ——
    // 灰掉一个按钮而不告诉人为什么，前台只会以为系统坏了
    const missing: string[] = [];
    if (!r.service_id) missing.push('项目');
    if (!r.slot_starts_at) missing.push('时间');
    if (!r.customer_id) missing.push('客人');

    return {
      draftId: r.id,
      status: r.status,
      fromE164: r.from_e164,
      fromDisplay: r.from_e164
        ? (canSeeContact ? r.from_e164 : `***${r.from_e164.slice(-4)}`)
        : null,
      createdAt: parseTs(r.created_at).toISOString(),

      service: {
        heard: r.service_name_heard,
        matchedId: r.service_id,
        matchedName: r.service_id ? pickText(r.service_name, ctx.locale) : null,
      },
      staff: {
        heard: r.staff_name_heard,
        matchedId: r.staff_membership_id,
        matchedName: r.staff_membership_id ? pickText(r.staff_name, ctx.locale) : null,
      },
      time: {
        heard: r.time_heard,
        slotStartsAt: r.slot_starts_at ? parseTs(r.slot_starts_at).toISOString() : null,
        durationMin: r.duration_min,
      },

      customer: r.customer_id
        ? { id: r.customer_id, displayName: r.customer_name }
        : null,
      candidates: (r.customer_candidates as CallDraftView['candidates']) ?? [],
      callerNameHeard: r.caller_name_heard,

      confidenceBp: r.confidence_bp,
      lowConfidence: r.confidence_bp < LOW_CONFIDENCE_BP,
      notes: r.notes,
      readyToBook: missing.length === 0,
      missing,
    };
  });

  return { drafts, pendingCount: Number(count!.n) };
}
