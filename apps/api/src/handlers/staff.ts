/**
 * 员工端命令实现（Phase 1c）。
 *
 * 宪法第 14 条贯穿全篇：每个命令都支持「前台代做」，
 * 代做时多记一个 `on_behalf_by` —— Desk-Only 的店天天在用这条路。
 */

import type postgres from 'postgres';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  TicketStartItem, TicketFinishItem, TimeclockPunch, SetMyLocale,
  AddStaff, SetEmployment, StaffSaveProfile, IssueStaffClaimCode, RevokeStaffSessions,
  AppError, ERROR_CODES, actingMembership, type CommandContext,
} from '@gf/contracts';
import { businessDateOf } from '@gf/scheduling';
import { parseTs, ts, jsonb } from '@gf/db';
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
    await tx`update appointments a set status = 'done'
             from tickets t
             where t.id = ${row.ticket_id} and a.id = t.appointment_id`;
    await tx`update appointment_items ai set status = 'completed'
             from tickets t
             where t.id = ${row.ticket_id} and ai.appointment_id = t.appointment_id
               and ai.status <> 'cancelled'`;
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
  /**
   * 语言存在哪，取决于这个人有没有平台账号：
   *
   *   · 用邮箱登录的人 → `users.locale`（跨店跟着人走）
   *   · **手机上机的技师** → `staff_profiles.locale`
   *     他没有 users 行（Ghost Profile，sql/0031），而语言这件事
   *     本来就该跟着「他在这家店的身份」走
   *
   * ⚠️ 不能退回「存 localStorage」：共享 iPad 上换个人就该换语言，
   * 而那台设备只有一个 localStorage（`00` §2）。
   */
  if (ctx.userId) {
    // users 是全局表（没有 org_id），这里只改自己那一行
    await tx`update users set locale = ${input.locale} where id = ${ctx.userId}`;
    audit({ entityType: 'user', entityId: ctx.userId, after: { locale: input.locale } });
    return { locale: input.locale };
  }

  const membershipId = actingMembership(ctx);
  await tx`update staff_profiles set locale = ${input.locale}
           where membership_id = ${membershipId} and location_id = ${ctx.locationId}`;
  audit({ entityType: 'staff', entityId: membershipId, after: { locale: input.locale } });
  return { locale: input.locale };
});

export { pinHash };

// ─────────────────────────────────────────────────── 员工花名册（sql/0031）

/** 上机码：6 位数字，几分钟有效。库里只存摘要 */
const CLAIM_CODE_TTL_MIN = 15;

function generateClaimCode(): string {
  // ⚠️ 用 randomInt 而不是 Math.random：这串数字几分钟内等于一个身份，
  // 而 Math.random 的序列是可以从几次输出反推出来的
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * 上机码的摘要。
 *
 * ⚠️ **刻意不按门店加盐**：输码的技师不知道自己在哪家店（他就是来上机的），
 * 所以兑换那一侧没有门店可以拿来算摘要。两家店同时发出同一个 6 位数字
 * 的风险由 sql/0031 那个唯一索引堵掉 —— 撞了就换一个再发。
 */
export function claimCodeHash(code: string): string {
  return createHash('sha256').update(`gf-claim:${code}`).digest('hex');
}

registerHandler(AddStaff, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AddStaff.input._type>) => {
  /**
   * ⭐ 建的是一条**没有账号的身份**（Ghost Profile）。
   *
   * `user_id` 留空 = 这个人还没在自己手机上上机过。他照样能被派单、
   * 能开单、能算提成 —— 上机是后来的事（sql/0031 头部有完整论证）。
   */
  const [m] = await tx<{ id: string }[]>`
    insert into memberships (org_id, location_id, user_id, status)
    values (${ctx.orgId}, ${ctx.locationId}, null, 'active')
    returning id`;

  /**
   * ⚠️ **加不出老板**：contracts 的 enum 已经把 `owner` 挡在外面，
   * 这里再确认一次角色是这家店里真实存在的预设 —— 传一个别家店的
   * role id 进来的话，membership_roles 的 RLS 会拒绝，但报出来的是
   * 一个看不懂的约束错误，不如在这里说清楚。
   */
  const keys = input.roleKeys.length > 0 ? input.roleKeys : ['tech'];
  const roles = await tx<{ id: string; key: string }[]>`
    select id, key from roles
    where location_id = ${ctx.locationId} and key = any(${keys as string[]})`;
  if (roles.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'role', wanted: keys },
    });
  }
  for (const r of roles) {
    await tx`insert into membership_roles (membership_id, role_id) values (${m!.id}, ${r.id})`;
  }

  const phone = input.phoneE164 ?? null;
  try {
    await tx`
      insert into staff_profiles
        (membership_id, org_id, location_id, display_name, is_bookable,
         max_concurrent_appointments, level_id, phone_e164)
      values (${m!.id}, ${ctx.orgId}, ${ctx.locationId},
              ${jsonb({ en: input.displayName })}::jsonb, ${input.isBookable},
              ${input.maxConcurrentAppointments}, ${input.levelId ?? null}, ${phone})`;
  } catch (e) {
    // 店内手机号唯一（sql/0031）。撞了要说人话：老板看到的应该是
    //「这个号码已经是店里另一个人的」，而不是一个索引名
    if ((e as { code?: string }).code === '23505') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'phone_already_used_in_location', phone },
      });
    }
    throw e;
  }

  if (input.inRotation && input.isBookable) {
    const [loc] = await tx<{ tz: string; cutoff: string }[]>`
      select timezone as tz, business_day_cutoff::text as cutoff
      from locations where id = ${ctx.locationId}`;
    const date = businessDateOf(new Date(), loc!.tz, loc!.cutoff);
    await tx`
      insert into rotation_participants (org_id, location_id, business_date, membership_id, in_rotation)
      values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${m!.id}, true)
      on conflict (location_id, business_date, membership_id) do nothing`;
  }

  audit({
    entityType: 'staff', entityId: m!.id,
    after: {
      displayName: input.displayName, roles: roles.map((r) => r.key),
      isBookable: input.isBookable, hasPhone: Boolean(phone), ghost: true,
    },
  });
  return { membershipId: m!.id, displayName: input.displayName };
});

registerHandler(SetEmployment, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetEmployment.input._type>) => {
  const [cur] = await tx<{ status: string }[]>`
    select status from memberships
    where id = ${input.membershipId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

  let dbStatus = input.status;
  if (input.status === 'on_leave') dbStatus = 'suspended';
  if (input.status === 'resigned') dbStatus = 'left';

  await tx`update memberships set status = ${dbStatus}
           where id = ${input.membershipId}`;

  /**
   * 离职/停用要把他手机上的登录一起掐掉。
   *
   * 不掐的话，一个已经离职的技师手里还揣着一个能看店里单子的会话 ——
   * 而「他已经不在花名册上了」和「他的手机还能刷出今天的单」
   * 是两件不会有人主动去核对的事。
   */
  if (dbStatus !== 'active') {
    await tx`update staff_sessions set revoked_at = now()
             where membership_id = ${input.membershipId} and revoked_at is null`;
  }

  audit({
    entityType: 'staff', entityId: input.membershipId,
    before: { status: cur.status }, after: { status: input.status, dbStatus },
  });
  return { membershipId: input.membershipId, status: input.status };
});

registerHandler(StaffSaveProfile, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof StaffSaveProfile.input._type>) => {
  let dbStatus = input.status;
  if (input.status === 'on_leave') dbStatus = 'suspended';
  if (input.status === 'resigned') dbStatus = 'left';

  // 1. 解析/创建职级 levelId
  let levelId = input.levelId;
  if (!levelId && input.level) {
    const [existingLevel] = await tx<{ id: string }[]>`
      select id from staff_levels
      where location_id = ${ctx.locationId} and (key = ${input.level} or name->>'zh-Hans' = ${input.level} or name->>'en' = ${input.level})
      limit 1`;
    if (existingLevel) {
      levelId = existingLevel.id;
    } else {
      const [newLevel] = await tx<{ id: string }[]>`
        insert into staff_levels (org_id, location_id, key, name, sort)
        values (${ctx.orgId}, ${ctx.locationId}, ${input.level}, ${jsonb({ en: input.level, 'zh-Hans': input.level })}::jsonb, 5)
        returning id`;
      levelId = newLevel!.id;
    }
  }

  let membershipId = input.membershipId;
  let isNew = false;

  if (membershipId) {
    const [existing] = await tx<{ id: string }[]>`
      select id from memberships where id = ${membershipId} and location_id = ${ctx.locationId}`;
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff', id: membershipId } });
    }

    await tx`
      update memberships set status = ${dbStatus}
      where id = ${membershipId}`;

    if (dbStatus !== 'active') {
      await tx`update staff_sessions set revoked_at = now()
               where membership_id = ${membershipId} and revoked_at is null`;
    }

    await tx`
      update staff_profiles set
        display_name = ${jsonb({ en: input.name, 'zh-Hans': input.name })}::jsonb,
        employee_no = ${input.employeeNo ?? null},
        job_title = ${input.jobTitle ?? null},
        notes = ${input.note ?? null},
        hire_date = ${input.hireDate ?? null},
        phone_e164 = ${input.phone || null},
        level_id = ${levelId ?? null},
        is_bookable = ${input.isBookable},
        max_concurrent_appointments = ${input.maxConcurrentAppointments}
      where membership_id = ${membershipId}`;
  } else {
    isNew = true;
    const [m] = await tx<{ id: string }[]>`
      insert into memberships (org_id, location_id, user_id, status)
      values (${ctx.orgId}, ${ctx.locationId}, null, ${dbStatus})
      returning id`;
    membershipId = m!.id;

    // 默认分配 tech role
    const [role] = await tx<{ id: string }[]>`
      select id from roles where location_id = ${ctx.locationId} and key = 'tech' limit 1`;
    if (role) {
      await tx`insert into membership_roles (membership_id, role_id) values (${membershipId}, ${role.id})
               on conflict do nothing`;
    }

    await tx`
      insert into staff_profiles (
        membership_id, org_id, location_id, display_name, employee_no,
        job_title, notes, hire_date, phone_e164, level_id,
        is_bookable, max_concurrent_appointments
      ) values (
        ${membershipId}, ${ctx.orgId}, ${ctx.locationId},
        ${jsonb({ en: input.name, 'zh-Hans': input.name })}::jsonb,
        ${input.employeeNo ?? null}, ${input.jobTitle ?? null}, ${input.note ?? null},
        ${input.hireDate ?? null}, ${input.phone || null}, ${levelId ?? null},
        ${input.isBookable}, ${input.maxConcurrentAppointments}
      )`;

    if (input.inRotation && input.isBookable) {
      const [loc] = await tx<{ tz: string; cutoff: string }[]>`
        select timezone as tz, business_day_cutoff::text as cutoff
        from locations where id = ${ctx.locationId}`;
      const date = businessDateOf(new Date(), loc!.tz, loc!.cutoff);
      await tx`
        insert into rotation_participants (org_id, location_id, business_date, membership_id, in_rotation)
        values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${membershipId}, true)
        on conflict (location_id, business_date, membership_id) do nothing`;
    }
  }

  // 2. 技能标签同步
  if (input.skills) {
    await tx`delete from staff_skills where membership_id = ${membershipId}`;
    for (const skName of input.skills) {
      if (!skName.trim()) continue;
      const [existingSkill] = await tx<{ id: string }[]>`
        select id from skills
        where location_id = ${ctx.locationId} and (key = ${skName} or name->>'zh-Hans' = ${skName} or name->>'en' = ${skName})
        limit 1`;
      let skillId = existingSkill?.id;
      if (!skillId) {
        const [newSkill] = await tx<{ id: string }[]>`
          insert into skills (org_id, location_id, key, name)
          values (${ctx.orgId}, ${ctx.locationId}, ${skName}, ${jsonb({ en: skName, 'zh-Hans': skName })}::jsonb)
          returning id`;
        skillId = newSkill!.id;
      }
      await tx`
        insert into staff_skills (membership_id, skill_id, proficiency)
        values (${membershipId}, ${skillId}, 1)
        on conflict do nothing`;
    }
  }

  // 3. 薪酬方案联动
  if (input.payroll) {
    const plan = {
      kind: input.payroll.kind,
      rateBp: Math.round(input.payroll.ratePercent * 100),
      categoryRateBp: {},
      retailRateBp: 1000,
      hourlyRateCents: Math.round(input.payroll.hourlyRateDollars * 100),
      base: input.payroll.base,
      roleWeightBp: 10000,
    };

    const [prev] = await tx<{ v: number }[]>`
      select coalesce(max(version), 0)::int as v from compensation_plans
      where location_id = ${ctx.locationId}
        and membership_id = ${membershipId}`;
    const nextVer = (prev?.v ?? 0) + 1;

    await tx`
      insert into compensation_plans
        (org_id, location_id, membership_id, version, config, created_by)
      values (${ctx.orgId}, ${ctx.locationId}, ${membershipId}, ${nextVer},
              ${jsonb(plan)}::jsonb, ${ctx.membershipId})`;
  }

  audit({
    entityType: 'staff', entityId: membershipId,
    after: {
      name: input.name, employeeNo: input.employeeNo, jobTitle: input.jobTitle,
      skills: input.skills, status: input.status, isNew,
    },
  });

  emit({ type: 'staff.changed', entityId: membershipId, membershipId });

  return { membershipId, created: isNew };
});

registerHandler(IssueStaffClaimCode, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof IssueStaffClaimCode.input._type>) => {
  const [row] = await tx<{ membership_id: string }[]>`
    select membership_id from staff_profiles
    where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

  const [m] = await tx<{ status: string }[]>`
    select status from memberships where id = ${input.membershipId}`;
  if (m!.status !== 'active') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'staff_not_active', status: m!.status },
    });
  }

  const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MIN * 60_000);

  /**
   * 撞码就换一个。
   *
   * 全局同时只允许一个活码（sql/0031 的唯一索引）—— 活码总共只有几个，
   * 所以这个循环实际上永远只跑一次。它存在的意义是：万一真撞上，
   * 老板看到的是一个正常的码，而不是一句「唯一约束冲突」。
   */
  let code = '';
  for (let attempt = 0; ; attempt++) {
    code = generateClaimCode();
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          update staff_profiles
          set claim_code_hash = ${claimCodeHash(code)},
              claim_code_expires_at = ${ts(expiresAt)}::timestamptz
          where membership_id = ${input.membershipId}`;
      });
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || attempt >= 5) throw e;
    }
  }

  // ⚠️ 审计里只留「给谁发过一张码」。码本身连摘要都不记 ——
  // audit_log 是给人翻的，翻的人不该有机会看到任何和钥匙沾边的东西
  audit({
    entityType: 'staff', entityId: input.membershipId,
    after: { issuedClaimCode: true, expiresAt: expiresAt.toISOString() },
  });

  // 明文只在这一次返回里存在
  return {
    membershipId: input.membershipId, code, expiresAt: expiresAt.toISOString(),
  };
});

registerHandler(RevokeStaffSessions, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RevokeStaffSessions.input._type>) => {
  const [row] = await tx<{ membership_id: string }[]>`
    select membership_id from staff_profiles
    where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

  const revoked = await tx<{ id: string }[]>`
    update staff_sessions set revoked_at = now()
    where membership_id = ${input.membershipId} and revoked_at is null
    returning id`;

  // 顺手把还没用掉的上机码也作废：踢下线的场景（手机丢了）里，
  // 那张码和那个会话是同一件事的两半
  await tx`update staff_profiles
           set claim_code_hash = null, claim_code_expires_at = null
           where membership_id = ${input.membershipId}`;

  audit({
    entityType: 'staff', entityId: input.membershipId,
    after: { revokedSessions: revoked.length },
  });
  return { membershipId: input.membershipId, revoked: revoked.length };
});
