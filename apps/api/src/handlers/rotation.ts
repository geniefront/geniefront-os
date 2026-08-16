/**
 * 轮牌命令的实现。
 *
 * 所有写操作都只做一件事：**往 rotation_events 追加一条事件**。
 * 当前顺序永远由 packages/rotation 重放算出，不存快照 ——
 * 存快照就意味着「为什么是这个顺序」会随着时间失传，
 * 而那恰恰是门店里最需要说清楚的东西（决策 12）。
 */

import type postgres from 'postgres';
import {
  RotationAssign, RotationReorder, RotationSetBreak, RotationSkip,
  AppError, ERROR_CODES, type CommandContext, pickText
} from '@gf/contracts';
import {
  computeStanding, turnValueByAmount, FULL_TURN, HALF_TURN,
  DEFAULT_POLICY, type Participant, type RotationEvent, type RotationPolicy,
} from '@gf/rotation';
import { businessDateOf } from '@gf/scheduling';
import { registerHandler, type HandlerArgs } from '../bus';

/** 默认阶梯：≤$30 半轮，其余整轮（00 §1.2 的常见配置） */
const DEFAULT_TIERS = [
  { maxCents: 3000, turnBp: HALF_TURN },
  { maxCents: null, turnBp: FULL_TURN },
];

export async function currentBusinessDate(
  tx: postgres.TransactionSql, locationId: string,
): Promise<{ date: string; policy: RotationPolicy; tiers: typeof DEFAULT_TIERS }> {
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const [pol] = await tx<{ config: Record<string, unknown> }[]>`
    select config from rotation_policies
    where location_id = ${locationId}
    order by version desc limit 1`;

  const c = (pol?.config ?? {}) as {
    request_counts_as_turn?: boolean;
    skip_no_skill?: 'no_penalty' | 'counts_as_turn';
    owed_turn_priority?: boolean;
    on_break?: 'off_rotation' | 'stay_in_place';
    turn_value?: { tiers?: Array<{ max_cents: number | null; turn_bp: number }> };
  };

  return {
    date: businessDateOf(new Date(), loc.tz, loc.cutoff),
    policy: {
      requestCountsAsTurn: c.request_counts_as_turn ?? DEFAULT_POLICY.requestCountsAsTurn,
      skipNoSkill: c.skip_no_skill ?? DEFAULT_POLICY.skipNoSkill,
      owedTurnPriority: c.owed_turn_priority ?? DEFAULT_POLICY.owedTurnPriority,
      onBreak: c.on_break ?? DEFAULT_POLICY.onBreak,
    },
    tiers: c.turn_value?.tiers?.map((t) => ({ maxCents: t.max_cents, turnBp: t.turn_bp }))
      ?? DEFAULT_TIERS,
  };
}

export async function loadRotation(
  tx: postgres.TransactionSql, ctx: CommandContext, businessDate: string,
): Promise<{ participants: Participant[]; events: RotationEvent[] }> {
  const rows = await tx<{
    membership_id: string; name: unknown; in_rotation: boolean | null;
    is_bookable: boolean; seed: number;
  }[]>`
    select sp.membership_id, sp.display_name as name, sp.is_bookable,
           rp.in_rotation,
           row_number() over (order by sp.display_name->>'en')::int as seed
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    left join rotation_participants rp
      on rp.membership_id = sp.membership_id and rp.business_date = ${businessDate}
    where sp.location_id = ${ctx.locationId} and sp.is_bookable = true`;

  const evs = await tx<{
    id: string; membership_id: string; delta_bp: number; reason: string;
    at: string; actor_id: string | null; note: string | null;
  }[]>`
    select id, membership_id, delta_bp, reason, at::text as at, actor_id, note
    from rotation_events
    where location_id = ${ctx.locationId} and business_date = ${businessDate}
    order by at`;

  return {
    participants: rows.map((r) => ({
      membershipId: r.membership_id,
      name: pickText(r.name, ctx.locale),
      inRotation: r.in_rotation ?? r.is_bookable,
      seedOrder: r.seed,
    })),
    events: evs.map((e) => ({
      id: e.id,
      membershipId: e.membership_id,
      deltaBp: e.delta_bp,
      reason: e.reason as RotationEvent['reason'],
      at: e.at,
      actorId: e.actor_id,
      note: e.note,
      // manualRank 存在 note 的结构化前缀里：@rank:N|原因
      manualRank: e.reason === 'manual_override' ? parseRank(e.note) : null,
    })),
  };
}

const parseRank = (note: string | null): number | null => {
  const m = /^@rank:(\d+)\|/.exec(note ?? '');
  return m ? Number(m[1]) : null;
};
export const stripRank = (note: string | null): string | null =>
  note?.replace(/^@rank:\d+\|/, '') ?? null;

async function insertEvent(
  tx: postgres.TransactionSql, ctx: CommandContext, businessDate: string,
  membershipId: string, reason: string, deltaBp: number, note: string | null,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into rotation_events
      (org_id, location_id, business_date, membership_id, delta_bp, reason, actor_id, note)
    values (${ctx.orgId}, ${ctx.locationId}, ${businessDate}, ${membershipId},
            ${deltaBp}, ${reason}, ${ctx.membershipId}, ${note})
    returning id`;
  return row!.id;
}

// ─────────────────────────────────────────────────────────────────── 手动调序

registerHandler(RotationReorder, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof RotationReorder.input._type>) => {
  const { date } = await currentBusinessDate(tx, ctx.locationId);
  // 原因编码进 note，重放时解析回位次
  const note = `@rank:${input.toPosition}|${input.reason}${input.note ? `：${input.note}` : ''}`;
  const eventId = await insertEvent(
    tx, ctx, date, input.membershipId, 'manual_override', 0, note);

  audit({
    entityType: 'rotation', entityId: input.membershipId,
    after: { toPosition: input.toPosition, reason: input.reason, note: input.note ?? null },
  });
  emit({ type: 'rotation.changed', membershipId: input.membershipId, businessDate: date });
  return { eventId, membershipId: input.membershipId, toPosition: input.toPosition };
});

// ─────────────────────────────────────────────────────────────────── 跳过

registerHandler(RotationSkip, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof RotationSkip.input._type>) => {
  const { date, policy } = await currentBusinessDate(tx, ctx.locationId);
  const reason = input.kind === 'no_skill' ? 'skipped_no_skill' : 'skipped_off';
  // 「跳过也算一轮」是店规，由策略决定扣不扣
  const delta = input.kind === 'no_skill' && policy.skipNoSkill === 'counts_as_turn'
    ? FULL_TURN : 0;
  const eventId = await insertEvent(tx, ctx, date, input.membershipId, reason, delta,
    input.note ?? null);

  const { participants, events } = await loadRotation(tx, ctx, date);
  const st = computeStanding(participants, events, policy);
  const me = st.entries.find((e) => e.membershipId === input.membershipId);

  audit({ entityType: 'rotation', entityId: input.membershipId,
          after: { kind: input.kind, owed: me?.owed ?? 0 } });
  emit({ type: 'rotation.changed', membershipId: input.membershipId, businessDate: date });
  return { eventId, owed: me?.owed ?? 0 };
});

// ─────────────────────────────────────────────────────────────────── 休息

registerHandler(RotationSetBreak, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof RotationSetBreak.input._type>) => {
  const { date } = await currentBusinessDate(tx, ctx.locationId);
  const eventId = await insertEvent(tx, ctx, date, input.membershipId,
    input.onBreak ? 'break' : 'back', 0, input.note ?? null);

  audit({ entityType: 'rotation', entityId: input.membershipId,
          after: { onBreak: input.onBreak } });
  emit({ type: 'rotation.changed', membershipId: input.membershipId, businessDate: date });
  return { eventId, onBreak: input.onBreak };
});

// ─────────────────────────────────────────────────────────────────── 派单

registerHandler(RotationAssign, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof RotationAssign.input._type>) => {
  const { date, policy, tiers } = await currentBusinessDate(tx, ctx.locationId);

  const before = await loadRotation(tx, ctx, date);
  const beforeStanding = computeStanding(before.participants, before.events, policy);
  const target = beforeStanding.entries.find((e) => e.membershipId === input.membershipId);
  if (!target) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { membershipId: input.membershipId } });
  }
  if (target.state === 'off') {
    throw new AppError(ERROR_CODES.STAFF_NOT_BOOKABLE, {
      details: { reason: '今天不参与轮牌' },
    });
  }

  const consumedBp = input.amountCents !== undefined
    ? turnValueByAmount(input.amountCents, tiers)
    : FULL_TURN;

  // 点钟单走 request_not_counted —— 是否真的消耗由策略决定，不在这里判断
  const reason = input.isRequest ? 'request_not_counted' : 'served';
  const note = [input.customerName, input.note].filter(Boolean).join(' · ') || null;
  const eventId = await insertEvent(tx, ctx, date, input.membershipId, reason, consumedBp, note);

  const after = await loadRotation(tx, ctx, date);
  const afterStanding = computeStanding(after.participants, after.events, policy);

  audit({
    entityType: 'rotation', entityId: input.membershipId,
    before: { position: target.position, turnsBp: target.turnsBp },
    after: {
      isRequest: input.isRequest, consumedBp,
      nextUp: afterStanding.nextUp?.membershipId ?? null,
    },
  });

  emit({ type: 'rotation.changed', membershipId: input.membershipId, businessDate: date });

  return {
    eventId,
    membershipId: input.membershipId,
    consumedBp: policy.requestCountsAsTurn || !input.isRequest ? consumedBp : 0,
    nextUpMembershipId: afterStanding.nextUp?.membershipId ?? null,
  };
});
