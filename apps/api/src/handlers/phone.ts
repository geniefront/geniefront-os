/**
 * AI 电话接单的命令实现（09-TELNYX §4）
 *
 * 两条贯穿全篇的纪律：
 *
 * 1. **AI 只写草案队列，写不出预约。** 前台点确认时才走
 *    `appointment.create`，用的是前台自己的身份。
 * 2. **AI 报的时间必须被排期引擎验过。** 模型说「明天四点」不算数，
 *    要 `findOpenSlots` 也说四点有空才算。见 `assertRealSlot`。
 */

import {
  DraftFromCall, ReviewCallDraft, RecordCall, SavePhoneLine,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb, ts } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { loadSlotContext } from '../queries/slots';
import { chargeQuota } from '../billing/usage';


registerHandler(SavePhoneLine, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePhoneLine.input._type>) => {
  // e164 全局唯一：同一个号码属于两家店的话，webhook 会随机落到其中一家 ——
  // 那是一种无从复现的串店事故。冲突时明确报错，别 upsert 到别人店里去。
  const [taken] = await tx<{ location_id: string }[]>`
    select location_id from phone_lines where e164 = ${input.e164}`;
  if (taken && taken.location_id !== ctx.locationId) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
      details: { e164: input.e164, reason: 'number_bound_to_another_location' },
    });
  }

  await tx`
    insert into phone_lines
      (org_id, location_id, e164, provider, purpose, assistant_id, active)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.e164}, ${input.provider},
            ${input.purpose}, ${input.assistantId ?? null}, ${input.active})
    on conflict (e164) do update set
      purpose = excluded.purpose,
      provider = excluded.provider,
      assistant_id = excluded.assistant_id,
      active = excluded.active`;

  audit({
    entityType: 'phone_line', entityId: ctx.locationId,
    after: { e164: input.e164, purpose: input.purpose, active: input.active },
  });
  return { e164: input.e164, locationId: ctx.locationId };
});

/**
 * ⭐ 拿排期引擎验一遍 AI 报的时间（09 §8 那条护栏的执行点）。
 *
 * 模型很擅长说出一个听起来完全合理的时间。「明天下午四点可以」——
 * 而那天下午四点店里一个人都没有。客人在电话里已经听到了肯定答复，
 * 前台复核时看到「明天 16:00」也不会觉得有什么问题，
 * 于是错误一路走到客人白跑一趟为止。
 *
 * 所以：AI 填的 `slotStartsAt` 必须**恰好等于** findOpenSlots 返回过的某个时刻。
 * 对不上就把时间清空、把原话留着，让前台自己排 —— 这比塞一个假时间强。
 */
async function assertRealSlot(
  tx: HandlerArgs<unknown>['tx'],
  locationId: string,
  slotStartsAt: string,
  durationMin: number,
  preferredMembershipId: string | null,
): Promise<boolean> {
  const wanted = new Date(slotStartsAt);
  const ctxSlots = await loadSlotContext(tx, locationId, wanted, durationMin, preferredMembershipId);
  return ctxSlots.slots.some((s) => s.startsAt.getTime() === wanted.getTime());
}

registerHandler(DraftFromCall, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof DraftFromCall.input._type>) => {
  const [call] = input.providerCallId
    ? await tx<{ id: string }[]>`
        select id from phone_calls
        where provider_call_id = ${input.providerCallId} and location_id = ${ctx.locationId}`
    : [];

  // ── 同号多客户（决策 21）────────────────────────────────────────────────
  //
  // 夫妻/母女共号很普遍。**不许自动挑一个** —— 挑错了整通电话的记录
  // 会挂到另一个人头上，而没有人会发现。候选全部带上，前台一眼选。
  let candidates: Array<{ customerId: string; displayName: string; lastVisitOn: string | null }> = [];
  if (input.fromE164) {
    const digits = input.fromE164.replace(/\D/g, '');
    const rows = await tx<{ id: string; display_name: string; last_visit_on: string | null }[]>`
      select c.id, c.display_name,
             (select max(a.business_date)::text from appointments a
               where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
      from customers c
      where c.merged_into_id is null
        and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
      order by c.display_name limit 10`;
    candidates = rows.map((r) => ({
      customerId: r.id, displayName: r.display_name, lastVisitOn: r.last_visit_on,
    }));
  }
  // 只有一位老客时才敢自动带上；多位一律留空等前台选
  const customerId = input.customerId
    ?? (candidates.length === 1 ? candidates[0]!.customerId : null);

  // ── 时间必须过排期引擎 ──────────────────────────────────────────────────
  let slotStartsAt = input.slotStartsAt ?? null;
  let slotRejected = false;
  if (slotStartsAt && input.durationMin) {
    const real = await assertRealSlot(
      tx, ctx.locationId, slotStartsAt, input.durationMin,
      input.staffMembershipId ?? null);
    if (!real) {
      slotStartsAt = null;
      slotRejected = true;
    }
  }

  const [row] = await tx<{ id: string; created_at: Date | string }[]>`
    insert into call_drafts
      (org_id, location_id, call_id, from_e164,
       service_name_heard, service_id, staff_name_heard, staff_membership_id,
       time_heard, slot_starts_at, duration_min,
       customer_id, customer_candidates, caller_name_heard,
       confidence_bp, notes)
    values (${ctx.orgId}, ${ctx.locationId}, ${call?.id ?? null}, ${input.fromE164 ?? null},
            ${input.serviceNameHeard ?? null}, ${input.serviceId ?? null},
            ${input.staffNameHeard ?? null}, ${input.staffMembershipId ?? null},
            ${input.timeHeard ?? null},
            ${slotStartsAt ? ts(new Date(slotStartsAt)) : null}::timestamptz,
            ${input.durationMin ?? null},
            ${customerId}, ${jsonb(candidates)}::jsonb, ${input.callerNameHeard ?? null},
            ${slotRejected ? Math.min(input.confidenceBp, 5000) : input.confidenceBp},
            ${slotRejected
              ? `${input.notes ?? ''}\n⚠️ AI 报的时间在排期表上并不空闲，已清空，请前台重排。`.trim()
              : (input.notes ?? null)})
    returning id, created_at`;

  audit({
    entityType: 'call_draft', entityId: row!.id,
    after: {
      fromE164: input.fromE164 ?? null,
      serviceHeard: input.serviceNameHeard ?? null,
      staffHeard: input.staffNameHeard ?? null,
      timeHeard: input.timeHeard ?? null,
      slotAccepted: !slotRejected && slotStartsAt !== null,
      candidateCount: candidates.length,
    },
  });

  // 前台屏幕上那个「待复核 (N)」的角标要当场跳 ——
  // 客人还在电话里，前台这时候看到才有意义（决策 6 的「1 秒复核队列」）
  emit({ type: 'call.drafted', entityId: row!.id });

  return {
    draftId: row!.id,
    queuedAt: new Date(row!.created_at).toISOString(),
  };
});

registerHandler(ReviewCallDraft, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof ReviewCallDraft.input._type>) => {
  const [cur] = await tx<{ id: string; status: string }[]>`
    select id, status from call_drafts
    where id = ${input.draftId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'call_draft' } });
  if (cur.status !== 'pending') {
    throw new AppError(ERROR_CODES.ALREADY_CANCELLED, {
      details: { status: cur.status, reason: 'draft_already_reviewed' },
    });
  }

  // 忽略必须给原因 —— 这是「AI 到底准不准」唯一诚实的度量（05 §9）。
  // 不强制的话半年后回头问「电话 AI 值不值这个钱」，没有任何数据能回答。
  if (input.decision === 'dismissed' && !input.dismissReason) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'dismiss_reason_required' },
    });
  }

  await tx`
    update call_drafts set
      status = ${input.decision},
      appointment_id = ${input.appointmentId ?? null},
      reviewed_by = ${ctx.membershipId},
      reviewed_at = now(),
      dismiss_reason = ${input.dismissReason ?? null},
      notes = case when ${input.note ?? null}::text is null then notes
                   else coalesce(notes || E'\n', '') || ${input.note ?? ''} end
    where id = ${input.draftId}`;

  audit({
    entityType: 'call_draft', entityId: input.draftId,
    before: { status: cur.status },
    after: {
      status: input.decision,
      appointmentId: input.appointmentId ?? null,
      dismissReason: input.dismissReason ?? null,
    },
  });
  emit({ type: 'call.drafted', entityId: input.draftId });

  return { draftId: input.draftId, status: input.decision };
});

registerHandler(RecordCall, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordCall.input._type>) => {
  // 计费按分钟**向上取整**：29 秒也是一分钟，这是电话行业的通行口径。
  // 存的是秒 —— 存分钟就再也算不回去了，而资费口径以后可能会变。
  const billedMinutes = Math.ceil(input.durationSeconds / 60);

  const [row] = await tx<{ id: string }[]>`
    insert into phone_calls
      (org_id, location_id, provider_call_id, from_e164, to_e164,
       started_at, ended_at, duration_seconds, outcome)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.providerCallId},
            ${input.fromE164 ?? null}, ${input.toE164 ?? null},
            ${input.startedAt ? ts(new Date(input.startedAt)) : null}::timestamptz,
            ${input.endedAt ? ts(new Date(input.endedAt)) : null}::timestamptz,
            ${input.durationSeconds}, ${input.outcome})
    on conflict (provider_call_id) do update set
      ended_at = excluded.ended_at,
      duration_seconds = excluded.duration_seconds,
      outcome = excluded.outcome
    returning id`;

  // ⚠️ `ai_call_min` 与 `ai_assist` 分开计（决策 8）。
  // 两者成本差 10–16 倍，合成一个「额度」必被套利：
  // 客户会把便宜的副驾额度全用在贵的电话上。
  //
  // 幂等在命令总线那一层（idempotency: required），所以这里不会记两遍；
  // 记两遍的后果是直接给客户多收钱，而账单上只是一个稍微大一点的数字。
  const [usageRow] = await tx<{ id: string }[]>`
    insert into usage_events (org_id, location_id, kind, qty, cost_cents, meta)
    values (${ctx.orgId}, ${ctx.locationId}, 'ai_call_min', ${billedMinutes}, 0,
            ${jsonb({
              provider: 'telnyx',
              providerCallId: input.providerCallId,
              durationSeconds: input.durationSeconds,
              outcome: input.outcome,
              // cost_cents 先记 0：Telnyx 的实测单价还没填（09 §6）。
              // 填成一个估算值比留 0 更糟 —— 那会被当成真数字拿去算单位经济。
              unitPricePending: true,
            })}::jsonb)
    returning id`;

  /**
   * 扣语音分钟。**扣的是分钟本身，不是钱** ——
   * 客户买的就是分钟（$50 = 200 分钟），所以这里不需要知道单价。
   *
   * ⚠️ 语音分钟和 AI 积分是**两本独立的账**，不能互换（决策 8）：
   * 一分钟电话的成本是一次副驾操作的 5.6 倍，能换就会被套利。
   */
  const charge = await chargeQuota(tx, ctx, {
    unit: 'voice_minute',
    amount: billedMinutes,
    usageEventId: usageRow!.id,
    source: 'ai_call_min',
  });

  audit({
    entityType: 'phone_call', entityId: row!.id,
    after: {
      billedMinutes, outcome: input.outcome, durationSeconds: input.durationSeconds,
      fromIncluded: charge?.fromIncluded ?? 0,
      fromBalance: charge?.fromBalance ?? 0,
    },
  });
  return {
    callId: row!.id, billedMinutes,
    fromIncluded: charge?.fromIncluded ?? 0,
    fromBalance: charge?.fromBalance ?? 0,
  };
});

export { assertRealSlot };
