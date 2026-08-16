/**
 * 员工端命令实现（Phase 1c）。
 *
 * 宪法第 14 条贯穿全篇：每个命令都支持「前台代做」，
 * 代做时多记一个 `on_behalf_by` —— Desk-Only 的店天天在用这条路。
 */

import type postgres from 'postgres';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  TicketStartItem, TicketFinishItem, TimeclockPunch, SetMyLocale,
  AppError, ERROR_CODES, actingMembership, type CommandContext,
} from '@gf/contracts';
import { businessDateOf } from '@gf/scheduling';
import { parseTs } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { assertDayOpen } from '../money';

async function bizDate(tx: postgres.TransactionSql, locationId: string): Promise<string> {
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
  return businessDateOf(new Date(), loc.tz, loc.cutoff);
}

/**
 * 「这条命令是给谁做的」。
 *
 * 不传 membershipId = 给自己做，任何人都可以。
 * 传了别人 = 代做，必须有 punch_others / ticket.write 之类的权限。
 */
function targetOf(
  ctx: CommandContext, given: string | undefined, needPermission: 'timeclock.punch_others' | 'ticket.write',
): { membershipId: string; onBehalf: boolean } {
  if (!given || given === ctx.membershipId) {
    // 打卡必须有具体的人 —— 系统 actor 打卡是没有意义的
    return { membershipId: actingMembership(ctx), onBehalf: false };
  }
  if (!ctx.permissions.has(needPermission)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { need: needPermission, reason: '替别人操作需要额外权限' },
    });
  }
  return { membershipId: given, onBehalf: true };
}

// ─────────────────────────────────────────────────────────── 开始 / 完成

registerHandler(TicketStartItem, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketStartItem.input._type>) => {
  const [row] = await tx<{
    id: string; ticket_id: string; started_at: string | null; status: string;
    business_date: string;
  }[]>`
    select ti.id, ti.ticket_id, ti.started_at, t.status,
           t.business_date::text as business_date
    from ticket_items ti join tickets t on t.id = ti.ticket_id
    where ti.id = ${input.ticketItemId}`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket_item' } });
  if (row.status === 'closed' || row.status === 'voided') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { status: row.status } });
  }
  await assertDayOpen(tx, ctx.locationId, row.business_date);

  // 重复点「开始」不报错，保持原来的时刻 —— 技师在嘈杂环境里多点一下很常见，
  // 而把开始时间往后推会让工时凭空缩水
  const [updated] = await tx<{ started_at: string }[]>`
    update ticket_items
       set started_at = coalesce(started_at, now())
     where id = ${input.ticketItemId}
     returning started_at`;

  await tx`update tickets set status = 'in_service'
           where id = ${row.ticket_id} and status in ('open','ready_to_pay')`;

  audit({ entityType: 'ticket', entityId: row.ticket_id,
          after: { itemId: input.ticketItemId, action: 'start',
                   alreadyStarted: row.started_at !== null } });
  emit({ type: 'ticket.changed', entityId: row.ticket_id, businessDate: row.business_date });

  return {
    ticketItemId: input.ticketItemId,
    startedAt: parseTs(updated!.started_at).toISOString(),
  };
});

registerHandler(TicketFinishItem, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketFinishItem.input._type>) => {
  const [row] = await tx<{
    id: string; ticket_id: string; started_at: string | null; finished_at: string | null;
    status: string; business_date: string;
  }[]>`
    select ti.id, ti.ticket_id, ti.started_at, ti.finished_at, t.status,
           t.business_date::text as business_date
    from ticket_items ti join tickets t on t.id = ti.ticket_id
    where ti.id = ${input.ticketItemId}`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket_item' } });
  if (row.status === 'closed' || row.status === 'voided') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { status: row.status } });
  }
  await assertDayOpen(tx, ctx.locationId, row.business_date);

  // 没点过开始就点完成：前台代点时很常见（技师早就在做了，前台才想起来）。
  // 不报错，把开始时间补成「预估时长之前」，并在审计里标出来是补的 ——
  // 拒绝的话前台只能放弃记录，那还不如记一个标注过的估计值。
  const [updated] = await tx<{ started_at: string; finished_at: string; mins: number }[]>`
    update ticket_items
       set started_at = coalesce(started_at, now() - make_interval(mins => duration_min)),
           finished_at = coalesce(finished_at, now())
     where id = ${input.ticketItemId}
     returning started_at, finished_at,
               (extract(epoch from (coalesce(finished_at, now()) -
                 coalesce(started_at, now() - make_interval(mins => duration_min)))) / 60)::int as mins`;

  const [rest] = await tx<{ n: number }[]>`
    select count(*)::int as n from ticket_items
    where ticket_id = ${row.ticket_id} and finished_at is null`;
  const done = (rest?.n ?? 0) === 0;

  if (done) {
    await tx`update tickets set status = 'ready_to_pay'
             where id = ${row.ticket_id} and status = 'in_service'`;
  }

  audit({
    entityType: 'ticket', entityId: row.ticket_id,
    after: {
      itemId: input.ticketItemId, action: 'finish',
      startBackfilled: row.started_at === null,
      ticketDone: done,
    },
  });
  emit({ type: 'ticket.changed', entityId: row.ticket_id, businessDate: row.business_date });

  return {
    ticketItemId: input.ticketItemId,
    finishedAt: parseTs(updated!.finished_at).toISOString(),
    actualMinutes: Math.max(0, updated!.mins),
    ticketDone: done,
  };
});

// ─────────────────────────────────────────────────────────────── 打卡

/** PIN 只存 hash。和密码一个道理：泄库时不该能直接拿去打卡 */
function pinHash(membershipId: string, pin: string): string {
  return createHash('sha256').update(`${membershipId}:${pin}`).digest('hex');
}

async function assertPin(
  tx: postgres.TransactionSql, membershipId: string, pin: string | undefined,
): Promise<void> {
  const [row] = await tx<{ pin_hash: string | null }[]>`
    select pin_hash from staff_profiles where membership_id = ${membershipId}`;
  if (!row?.pin_hash) return;    // 没设 PIN 的店不强制（很多店就是不设）
  if (!pin) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: '这位技师设了 PIN，打卡要输 PIN' },
    });
  }
  const a = Buffer.from(pinHash(membershipId, pin), 'hex');
  const b = Buffer.from(row.pin_hash, 'hex');
  // 定长比较：PIN 只有四位，时序差异足以被用来一位一位试出来
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { reason: 'PIN 不对' } });
  }
}

/** 重放当天的打卡流水，得出「现在在不在岗」与「做了多少分钟」 */
export function replayPunches(
  punches: ReadonlyArray<{ kind: string; at: Date }>, now = new Date(),
): { onDuty: boolean; workedMinutes: number } {
  let onDuty = false;
  let onBreak = false;
  let worked = 0;
  let since: Date | null = null;

  const acc = (until: Date) => {
    if (since) worked += (until.getTime() - since.getTime()) / 60_000;
    since = null;
  };

  for (const p of [...punches].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    switch (p.kind) {
      case 'clock_in':    if (!onDuty) { onDuty = true; onBreak = false; since = p.at; } break;
      case 'clock_out':   if (onDuty) { acc(p.at); onDuty = false; onBreak = false; } break;
      case 'break_start': if (onDuty && !onBreak) { acc(p.at); onBreak = true; } break;
      case 'break_end':   if (onDuty && onBreak) { onBreak = false; since = p.at; } break;
    }
  }
  if (onDuty && !onBreak) acc(now);
  return { onDuty, workedMinutes: Math.max(0, Math.round(worked)) };
}

registerHandler(TimeclockPunch, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TimeclockPunch.input._type>) => {
  const target = targetOf(ctx, input.membershipId, 'timeclock.punch_others');
  const date = await bizDate(tx, ctx.locationId);

  // 代打卡也要 PIN：Desk-Only 模式下前台代打是常态，
  // 但「前台随手替谁都能打」和「技师本人确认过」在纠纷里是两回事
  await assertPin(tx, target.membershipId, input.pin);

  const before = await tx<{ kind: string; at: string }[]>`
    select kind, at::text as at from time_punches
    where location_id = ${ctx.locationId} and membership_id = ${target.membershipId}
      and business_date = ${date}
    order by at`;
  const state = replayPunches(before.map((p) => ({ kind: p.kind, at: parseTs(p.at) })));

  // 顺序检查：没上班不能下班、已经在岗不能再上班。
  // 报错文案是给前台看的，不是给工程师看的
  const legal =
    input.kind === 'clock_in' ? !state.onDuty
    : input.kind === 'clock_out' ? state.onDuty
    : state.onDuty;
  if (!legal) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: state.onDuty ? '这位已经在岗了' : '这位还没打上班卡',
        kind: input.kind,
      },
    });
  }

  const method = target.onBehalf ? 'desk' : (input.pin ? 'pin' : 'app');
  const [row] = await tx<{ id: string; at: string }[]>`
    insert into time_punches
      (org_id, location_id, membership_id, business_date, kind, method, on_behalf_by, note, ip)
    values (${ctx.orgId}, ${ctx.locationId}, ${target.membershipId}, ${date},
            ${input.kind}, ${method},
            ${target.onBehalf ? ctx.membershipId : null},
            ${input.note ?? null}, ${ctx.ip ?? null})
    returning id, at::text as at`;

  const after = replayPunches([
    ...before.map((p) => ({ kind: p.kind, at: parseTs(p.at) })),
    { kind: input.kind, at: parseTs(row!.at) },
  ]);

  audit({
    entityType: 'time_punch', entityId: row!.id,
    after: {
      membershipId: target.membershipId, kind: input.kind,
      method, onBehalf: target.onBehalf, businessDate: date,
    },
  });
  emit({ type: 'shift.changed', membershipId: target.membershipId, businessDate: date });

  return {
    punchId: row!.id,
    kind: input.kind,
    at: parseTs(row!.at).toISOString(),
    onDuty: after.onDuty,
    workedMinutes: after.workedMinutes,
  };
});

// ─────────────────────────────────────────────────────────── 界面语言

registerHandler(SetMyLocale, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetMyLocale.input._type>) => {
  // users 是全局表（没有 org_id），这里只改自己那一行
  await tx`update users set locale = ${input.locale} where id = ${ctx.userId}`;
  audit({ entityType: 'user', entityId: ctx.userId, after: { locale: input.locale } });
  return { locale: input.locale };
});

export { pinHash };
