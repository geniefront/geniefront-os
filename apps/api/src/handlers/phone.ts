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
  DraftFromCall, ReviewCallDraft, RecordCall, AttachCallTranscript, SavePhoneLine, RequestAiVoice,
  SaveAiChangePolicy,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb, ts } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { generateToolToken, hashToolToken } from '../telnyx/toolToken';
import { loadSlotContext } from '../queries/slots';
import { chargeQuota } from '../billing/usage';

/**
 * 一分钟 AI 电话的**我们这一侧的成本**，单位毫分（1/1000 分）。
 *
 * ⚠️ 这是**成本**，不是向客户收的钱。客户买的是分钟本身
 * （$50 = 200 分钟），扣费走 `chargeQuota({ unit: 'voice_minute' })`，
 * **完全不需要知道单价**。这个数只影响毛利看板与单位经济。
 *
 * 没配 / 配了个不能解析的值 → 返回 0，`cost_cents` 记 0 并留
 * `unitPricePending`。**宁可记 0 也不要塞一个估算值** ——
 * 估算值会被当成真数字拿去算单位经济，而且没人记得它是估的。
 */
function ratePerMinMillicents(): number {
  const raw = process.env.TELNYX_RATE_PER_MIN_MILLICENTS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}


/** 会被 webhook 反查门店的 purpose —— 这几种必须全局唯一（sql/0025） */
const ROUTABLE = ['ai_voice', 'sms'] as const;
type Routable = (typeof ROUTABLE)[number];
const isRoutable = (p: string): p is Routable =>
  (ROUTABLE as readonly string[]).includes(p);

/**
 * 一家店一个 purpose 只留一条 active 记录，换号就是 update 那一条。
 *
 * ⚠️ 冲突目标是 `(location_id, purpose) where active`（sql/0025），
 * **不是 e164** —— e164 的唯一索引现在是部分索引，只覆盖 ROUTABLE，
 * 拿它当冲突目标会报 "no unique or exclusion constraint matching"。
 */
async function upsertLine(
  tx: HandlerArgs<unknown>['tx'], ctx: HandlerArgs<unknown>['ctx'],
  line: {
    e164: string; purpose: string; provider?: string;
    assistantId?: string | null | undefined;
    forwardingMode?: string | null | undefined;
    toolTokenDigest?: string | null | undefined;
    assistantName?: string | null | undefined;
    greetingTemplate?: string | null | undefined;
    greetingAiGenerated?: boolean | undefined;
    aiAnswer?: boolean | undefined;
  },
) {
  await tx`
    insert into phone_lines
      (org_id, location_id, e164, provider, purpose, assistant_id,
       forwarding_mode, tool_token_digest, active,
       assistant_name, greeting_template, greeting_ai_generated, ai_answer)
    values (${ctx.orgId}, ${ctx.locationId}, ${line.e164},
            ${line.provider ?? 'telnyx'}, ${line.purpose},
            ${line.assistantId ?? null}, ${line.forwardingMode ?? null},
            ${line.toolTokenDigest ?? null}, true,
            ${line.assistantName ?? null}, ${line.greetingTemplate ?? null},
            ${line.greetingAiGenerated ?? false}, ${line.aiAnswer ?? true})
    on conflict (location_id, purpose) where active do update set
      e164 = excluded.e164,
      provider = excluded.provider,
      assistant_id = excluded.assistant_id,
      forwarding_mode = excluded.forwarding_mode,
      -- ⚠️ 话术这四个是**没传就不动**（和 tool_token_digest 同一个道理）。
      -- 前台在设置里改个转接方式，不该把老板精心调过的开场白清空。
      -- undefined 走 coalesce 保留旧值；要清空得**显式传 null**，
      -- 那时下面 SavePhoneLine 会把它翻译成空字符串再落库
      assistant_name = coalesce(excluded.assistant_name, phone_lines.assistant_name),
      greeting_template = coalesce(excluded.greeting_template, phone_lines.greeting_template),
      greeting_ai_generated = excluded.greeting_ai_generated,
      ai_answer = excluded.ai_answer,
      -- ⚠️ 没给新摘要就**保留旧的**。前台在设置里改一下转接方式，
      -- 不该把这家店的电话 token 冲掉 —— 冲掉的表现是电话全部 401，
      -- 而她刚才只是点了个下拉框
      tool_token_digest = coalesce(excluded.tool_token_digest, phone_lines.tool_token_digest)`;
}

registerHandler(SavePhoneLine, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePhoneLine.input._type>) => {
  // 会被反查的号才需要查重：同一个号码属于两家店的话，webhook 会随机
  // 落到其中一家 —— 无从复现的串店。不反查的号（main / transfer_target）
  // 反而**不能**要求唯一：人工客服号常常是老板的手机，而一个老板开
  // 两三家店在这行很普遍（sql/0025 的长注释）。
  if (isRoutable(input.purpose)) {
    const [taken] = await tx<{ location_id: string }[]>`
      select location_id from phone_lines
      where e164 = ${input.e164} and purpose in ('ai_voice','sms')`;
    if (taken && taken.location_id !== ctx.locationId) {
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        details: { e164: input.e164, reason: 'number_bound_to_another_location' },
      });
    }
  }

  /*
   * ⭐ 电话工具的第二把钥匙（sql/0036）。
   *
   * 只有 `ai_voice` 线需要 —— 别的线不会被工具调用反查。
   * **第一次建就自动生成**：等人想起来要开这道门，一般是已经出过事了。
   *
   * 明文只在这次返回里出现一次，库里只有摘要。
   */
  let toolToken: string | null = null;
  if (input.active && input.purpose === 'ai_voice') {
    const [existing] = await tx<{ digest: string | null }[]>`
      select tool_token_digest as digest from phone_lines
      where location_id = ${ctx.locationId} and purpose = 'ai_voice' and active`;
    if (input.rotateToolToken || !existing?.digest) toolToken = generateToolToken();
  }

  if (input.active) {
    /*
     * ⚠️ **显式的 null 要变成空字符串再落库。**
     *
     * 上面那条 upsert 用 `coalesce(excluded.x, phone_lines.x)` 实现
     * 「没传就不动」—— 而 SQL 里分不清「没传」和「传了 null」，两者
     * 到了 `excluded` 里都是 NULL。于是「老板想清空开场白」会变成
     * 「什么都没发生」，他会以为界面坏了。
     *
     * 空字符串在读取侧和 null 等价（都回退到系统默认，见 telnyx/routes.ts）。
     */
    const blankIfNull = <T extends string>(v: T | null | undefined): T | '' | undefined =>
      v === null ? '' : v;

    await upsertLine(tx, ctx, {
      ...input,
      assistantName: blankIfNull(input.assistantName),
      greetingTemplate: blankIfNull(input.greetingTemplate),
      ...(toolToken ? { toolTokenDigest: hashToolToken(toolToken) } : {}),
    });
  } else {
    await tx`
      update phone_lines set active = false
      where location_id = ${ctx.locationId} and e164 = ${input.e164}`;
  }

  audit({
    entityType: 'phone_line', entityId: ctx.locationId,
    // ⚠️ 审计里只记「换过」，不记 token 本身 —— audit_log 是给人看的
    after: {
      e164: input.e164, purpose: input.purpose, active: input.active,
      ...(toolToken ? { toolTokenRotated: true } : {}),
    },
  });
  return { e164: input.e164, locationId: ctx.locationId, toolToken };
});

/**
 * 店家确认两个号码，申请开通 AI 客服。开通本身是**人工**做的（`09` §2）。
 *
 * 这里只做三件事：拦死会成环的填法、把两条记录原子地存下来、
 * 告诉前端有没有已经开通的落地号。
 */
registerHandler(RequestAiVoice, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RequestAiVoice.input._type>) => {
  // 「两个号不能相同」在 Zod 里已经拦了。这里拦的是另一种成环：
  // 把**我们的落地号**填进去。落地号是转移的落点，转人工再转回它
  // 就是 AI 转给 AI —— 客人会听见同一句开场白第二遍。
  //
  // ⚠️ 只查得到本 org 的号（RLS）。跨 org 的碰撞不查 ——
  // 那需要一个能看到所有店的连接，而 apps/ 拿不到（宪法第 5 条）。
  // 实际上也不会发生：别家店的落地号不会是这家店老板的手机。
  const ours = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where purpose = 'ai_voice' and active
      and e164 in (${input.storefrontE164}, ${input.transferTargetE164})`;
  if (ours.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        e164: ours[0]!.e164,
        reason: 'cannot_use_our_ai_landing_number',
      },
    });
  }

  await upsertLine(tx, ctx, {
    e164: input.storefrontE164, purpose: 'main',
    forwardingMode: input.forwardingMode,
  });
  await upsertLine(tx, ctx, {
    e164: input.transferTargetE164, purpose: 'transfer_target',
  });

  // 已开通的落地号。为 null 就是「还没开通」—— 这个状态是**推导**的，
  // 不存列：存了就要有人维护它，而它和记录本身随时会对不上（sql/0025）。
  const [ai] = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where location_id = ${ctx.locationId} and purpose = 'ai_voice' and active`;

  audit({
    entityType: 'phone_line', entityId: ctx.locationId,
    after: {
      storefrontE164: input.storefrontE164,
      transferTargetE164: input.transferTargetE164,
      forwardingMode: input.forwardingMode,
      provisioned: Boolean(ai),
    },
  });

  return {
    locationId: ctx.locationId,
    storefrontE164: input.storefrontE164,
    transferTargetE164: input.transferTargetE164,
    aiVoiceE164: ai?.e164 ?? null,
  };
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
       confidence_bp, notes,
       kind, target_appointment_id, requested_text, gate_reason)
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
              : (input.notes ?? null)},
            ${input.kind}, ${input.targetAppointmentId ?? null},
            ${input.requestedText ?? null}, ${input.gateReason ?? null})
    returning id, created_at`;

  audit({
    entityType: 'call_draft', entityId: row!.id,
    after: {
      kind: input.kind,
      targetAppointmentId: input.targetAppointmentId ?? null,
      gateReason: input.gateReason ?? null,
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

/**
 * 把转录/录音补到已经记过的那通电话上。
 *
 * 找不到那一行就**什么都不做**（`updated: false`），不新建 —— 计费和
 * 通话记录的入口只有 `call.record` 一个。这里凭空插一行的话，
 * 就会出现一条「有转录、没时长、没扣过分钟」的幽灵通话。
 */
registerHandler(AttachCallTranscript, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AttachCallTranscript.input._type>) => {
  const rows = await tx<{ id: string }[]>`
    update phone_calls set
      conversation_id = coalesce(${input.conversationId ?? null}, conversation_id),
      transcript      = coalesce(${input.transcript ? jsonb(input.transcript) : null}::jsonb, transcript),
      tools_used      = coalesce(${input.toolsUsed ?? null}, tools_used),
      recording_url   = coalesce(${input.recordingUrl ?? null}, recording_url),
      summary         = coalesce(${input.summary ?? null}, summary)
    where location_id = ${ctx.locationId} and provider_call_id = ${input.providerCallId}
    returning id`;

  const row = rows[0];
  /*
   * ⚠️ **没找到也要记审计**（宪法第 1 条：每条命令都留痕，总线会拦）。
   * 而且这一条恰恰是最该留痕的：补不进去意味着有一通电话的转录**丢了**，
   * 而漏账和漏转录一样是静默的。
   *
   * 记的是「补过料」，**不记转录内容** —— 那里面有客人说出口的全名、
   * 生日、健康状况，而 audit_log 是给人翻的（同宪法第 17 条的道理）。
   */
  audit({
    entityType: 'phone_call',
    // 没匹配上就挂在门店上 —— 审计条目要有一个落点，而这件事本身要留痕
    entityId: row?.id ?? ctx.locationId,
    after: {
      providerCallId: input.providerCallId,
      matched: Boolean(row),
      transcriptLines: input.transcript?.length ?? 0,
      toolsUsed: input.toolsUsed ?? [],
      hasRecording: Boolean(input.recordingUrl),
    },
  });
  return { callId: row?.id ?? null, updated: Boolean(row) };
});

registerHandler(RecordCall, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordCall.input._type>) => {
  // 计费按分钟**向上取整**：29 秒也是一分钟，这是电话行业的通行口径。
  // 存的是秒 —— 存分钟就再也算不回去了，而资费口径以后可能会变。
  const billedMinutes = Math.ceil(input.durationSeconds / 60);

  /*
   * ⚠️ 转录/录音这几列用 `coalesce(excluded, 现有)` 合并，不是直接覆盖。
   *
   * 这一行会被写两次：挂机 webhook 先到（有时长、没转录），对账任务后到
   * （有转录）。直接覆盖的话，后到的那条要是没带时长，就会把已经记下的
   * 通话长度抹成 null —— 而账已经按它扣过了。
   */
  const [row] = await tx<{ id: string }[]>`
    insert into phone_calls
      (org_id, location_id, provider_call_id, from_e164, to_e164,
       started_at, ended_at, duration_seconds, outcome,
       conversation_id, transcript, tools_used, recording_url)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.providerCallId},
            ${input.fromE164 ?? null}, ${input.toE164 ?? null},
            ${input.startedAt ? ts(new Date(input.startedAt)) : null}::timestamptz,
            ${input.endedAt ? ts(new Date(input.endedAt)) : null}::timestamptz,
            ${input.durationSeconds}, ${input.outcome},
            ${input.conversationId ?? null},
            ${input.transcript ? jsonb(input.transcript) : null}::jsonb,
            ${input.toolsUsed ?? null}, ${input.recordingUrl ?? null})
    on conflict (provider_call_id) do update set
      ended_at         = coalesce(excluded.ended_at, phone_calls.ended_at),
      duration_seconds = greatest(excluded.duration_seconds, phone_calls.duration_seconds),
      outcome          = coalesce(excluded.outcome, phone_calls.outcome),
      conversation_id  = coalesce(excluded.conversation_id, phone_calls.conversation_id),
      transcript       = coalesce(excluded.transcript, phone_calls.transcript),
      tools_used       = coalesce(excluded.tools_used, phone_calls.tools_used),
      recording_url    = coalesce(excluded.recording_url, phone_calls.recording_url)
    returning id`;

  // ⚠️ `ai_call_min` 与 `ai_assist` 分开计（决策 8）。
  // 两者成本差 10–16 倍，合成一个「额度」必被套利：
  // 客户会把便宜的副驾额度全用在贵的电话上。
  //
  // 幂等在命令总线那一层（idempotency: required），所以这里不会记两遍；
  // 记两遍的后果是直接给客户多收钱，而账单上只是一个稍微大一点的数字。
  // 我们这一侧的成本。单价没配就记 0 并留 unitPricePending（见上面的 helper）。
  //
  // cost_cents 存整数分（表结构如此），精确的毫分进 meta —— 和 ai_assist
  // 那两条路同一个口径（handlers/ai.ts、handlers/blueprint.ts）。
  // 一通电话几分钱，四舍五入到分之后按月加总会漂出百分之几。
  const rate = ratePerMinMillicents();
  const costMillicents = billedMinutes * rate;

  const [usageRow] = await tx<{ id: string }[]>`
    insert into usage_events (org_id, location_id, kind, qty, cost_cents, meta)
    values (${ctx.orgId}, ${ctx.locationId}, 'ai_call_min', ${billedMinutes},
            ${Math.round(costMillicents / 1000)},
            ${jsonb({
              provider: 'telnyx',
              providerCallId: input.providerCallId,
              durationSeconds: input.durationSeconds,
              outcome: input.outcome,
              costMillicents,
              // ⭐ 把**当时用的单价**一起记下来。单价会变（Telnyx 调价、
              // 换套餐、换供应商），不记的话事后没有任何办法判断某一行
              // 是按 5500 还是 6200 算的 —— 而那正是重算历史毛利时要问的。
              ratePerMinMillicents: rate,
              ...(rate === 0 ? { unitPricePending: true } : {}),
            })}::jsonb)
    returning id`;

  /**
   * 扣语音分钟。**扣的是分钟本身，不是钱** ——
   * 客户买的就是分钟（$50 = 200 分钟），所以这里不需要知道单价。
   *
   * ⚠️ 语音分钟和 AI 积分是**两本独立的账**，不能互换（决策 8）：
   * 一分钟电话的成本是一次副驾操作的 6.2 倍，能换就会被套利。
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

// ───────────────────────────────────────────── AI 电话变更策略（批 3）

/**
 * 存 `locations.settings.ai_change`。
 *
 * ⭐ 和 `online_booking` 一样放 settings 而不是建表：它是一组阈值，
 * 不是实体。为八个布尔值建张表只会多出一处「两边不一致」的可能。
 */
registerHandler(SaveAiChangePolicy, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveAiChangePolicy.input._type>) => {
  const [cur] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const before = (cur.settings['ai_change'] ?? {}) as Record<string, unknown>;
  const next = {
    enabled: input.enabled,
    allow_reschedule: input.allowReschedule,
    allow_cancel: input.allowCancel,
    require_exact_caller: input.requireExactCaller,
    require_single_upcoming: input.requireSingleUpcoming,
    min_hours_ahead: input.minHoursAhead,
    block_group: input.blockGroup,
    block_same_day: input.blockSameDay,
  };

  await tx`update locations set
      settings = jsonb_set(settings, '{ai_change}', ${jsonb(next)}::jsonb, true),
      updated_at = now()
    where id = ${ctx.locationId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { aiChange: before },
    after: { aiChange: next },
  });
  return { locationId: ctx.locationId, enabled: input.enabled };
});
