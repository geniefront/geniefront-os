/**
 * 排班命令实现。
 *
 * 铺开逻辑在 @gf/scheduling/roster 的纯函数里（宪法第 2 条），
 * 这里只负责取模板、写班次、以及那条最重要的纪律：
 * **一键铺开绝不覆盖前台手工调过的班**。
 */

import {
  SaveShiftTemplate, ApplyShiftTemplate, SetShift, PublishShifts,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import {
  expandTemplate, assertShiftBounds, addDays,
  type ShiftTemplateEntry, type Weekday,
} from '@gf/scheduling';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SaveShiftTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveShiftTemplate.input._type>) => {
  for (const e of input.entries) assertShiftBounds(e.startMin, e.endMin, e.breakMin);

  // 整周一起提交：先清后写。分条增删会让「这周他到底哪天上班」
  // 变成一堆残留记录的叠加结果，前台看不明白
  await tx`delete from shift_templates
           where location_id = ${ctx.locationId} and membership_id = ${input.membershipId}`;

  for (const e of input.entries) {
    await tx`insert into shift_templates
      (org_id, location_id, membership_id, weekday, start_min, end_min, break_min)
      values (${ctx.orgId}, ${ctx.locationId}, ${input.membershipId},
              ${e.weekday}, ${e.startMin}, ${e.endMin}, ${e.breakMin})`;
  }

  audit({
    entityType: 'shift_template', entityId: input.membershipId,
    after: { entryCount: input.entries.length, weekdays: input.entries.map((e) => e.weekday) },
  });
  return { membershipId: input.membershipId, entryCount: input.entries.length };
});

registerHandler(ApplyShiftTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ApplyShiftTemplate.input._type>) => {
  const rows = await tx<{
    membership_id: string; weekday: number;
    start_min: number; end_min: number; break_min: number;
  }[]>`
    select membership_id, weekday, start_min, end_min, break_min
    from shift_templates
    where location_id = ${ctx.locationId} and active = true
      ${input.membershipIds ? tx`and membership_id = any(${input.membershipIds})` : tx``}`;

  if (rows.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { reason: '还没有周模板，先在排班页设一次每周固定班' },
    });
  }

  const entries: ShiftTemplateEntry[] = rows.map((r) => ({
    membershipId: r.membership_id,
    weekday: r.weekday as Weekday,
    startMin: r.start_min,
    endMin: r.end_min,
    breakMin: r.break_min,
  }));

  const planned = expandTemplate({ entries, fromDate: input.fromDate, days: input.days });
  const toDate = addDays(input.fromDate, input.days - 1);

  let created = 0;
  let skipped = 0;
  for (const p of planned) {
    // ⭐ 冲突处理是这个命令的全部难点。
    // skipExisting = true 时，**任何**已经存在的行都不动 —— 包括请假、
    // 包括昨天前台手工换的班。一键铺开只要冲掉过一次人工安排，
    // 前台就再也不敢点这个按钮了。
    const res = input.skipExisting
      ? await tx<{ id: string }[]>`
          insert into shifts
            (org_id, location_id, membership_id, business_date,
             start_min, end_min, break_min, status, from_template, updated_by)
          values (${ctx.orgId}, ${ctx.locationId}, ${p.membershipId}, ${p.businessDate},
                  ${p.startMin}, ${p.endMin}, ${p.breakMin}, 'planned', true, ${ctx.membershipId})
          on conflict (location_id, business_date, membership_id) do nothing
          returning id`
      : await tx<{ id: string }[]>`
          insert into shifts
            (org_id, location_id, membership_id, business_date,
             start_min, end_min, break_min, status, from_template, updated_by)
          values (${ctx.orgId}, ${ctx.locationId}, ${p.membershipId}, ${p.businessDate},
                  ${p.startMin}, ${p.endMin}, ${p.breakMin}, 'planned', true, ${ctx.membershipId})
          on conflict (location_id, business_date, membership_id) do update set
            start_min = excluded.start_min, end_min = excluded.end_min,
            break_min = excluded.break_min, status = 'planned',
            off_reason = null, from_template = true, updated_by = excluded.updated_by
          returning id`;
    if (res.length > 0) created++; else skipped++;
  }

  audit({
    entityType: 'shift',
    after: {
      fromDate: input.fromDate, toDate, days: input.days,
      created, skipped, overwrote: !input.skipExisting,
    },
  });
  return { created, skipped, fromDate: input.fromDate, toDate };
});

registerHandler(SetShift, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetShift.input._type>) => {
  if (input.action === 'delete') {
    await tx`delete from shifts
             where location_id = ${ctx.locationId}
               and membership_id = ${input.membershipId}
               and business_date = ${input.businessDate}`;
    audit({ entityType: 'shift',
            after: { membershipId: input.membershipId, businessDate: input.businessDate,
                     status: 'deleted' } });
    return { membershipId: input.membershipId, businessDate: input.businessDate, status: 'deleted' };
  }

  if (input.action === 'off') {
    // 请假也占一行：不留行的话，「今天为什么少个人」就没有出处了
    await tx`insert into shifts
      (org_id, location_id, membership_id, business_date,
       start_min, end_min, break_min, status, off_reason, note, from_template, updated_by)
      values (${ctx.orgId}, ${ctx.locationId}, ${input.membershipId}, ${input.businessDate},
              0, 1, 0, 'off', ${input.offReason ?? 'other'}, ${input.note ?? null},
              false, ${ctx.membershipId})
      on conflict (location_id, business_date, membership_id) do update set
        status = 'off', off_reason = excluded.off_reason, note = excluded.note,
        from_template = false, updated_by = excluded.updated_by`;
    audit({ entityType: 'shift',
            after: { membershipId: input.membershipId, businessDate: input.businessDate,
                     status: 'off', reason: input.offReason ?? 'other' } });
    return { membershipId: input.membershipId, businessDate: input.businessDate, status: 'off' };
  }

  if (input.startMin === undefined || input.endMin === undefined) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: '上班要给起止时间' },
    });
  }
  const breakMin = input.breakMin ?? 0;
  assertShiftBounds(input.startMin, input.endMin, breakMin);

  await tx`insert into shifts
    (org_id, location_id, membership_id, business_date,
     start_min, end_min, break_min, status, off_reason, note, from_template, updated_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.membershipId}, ${input.businessDate},
            ${input.startMin}, ${input.endMin}, ${breakMin}, 'planned', null,
            ${input.note ?? null}, false, ${ctx.membershipId})
    on conflict (location_id, business_date, membership_id) do update set
      start_min = excluded.start_min, end_min = excluded.end_min,
      break_min = excluded.break_min, status = 'planned', off_reason = null,
      note = excluded.note,
      -- 手工改过就不再算模板生成的，下次一键铺开不会碰它
      from_template = false, updated_by = excluded.updated_by`;

  audit({ entityType: 'shift',
          after: { membershipId: input.membershipId, businessDate: input.businessDate,
                   status: 'planned' } });
  return { membershipId: input.membershipId, businessDate: input.businessDate, status: 'planned' };
});

registerHandler(PublishShifts, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof PublishShifts.input._type>) => {
  const rows = await tx<{ id: string }[]>`
    update shifts set status = 'published', published_at = now(), updated_by = ${ctx.membershipId}
    where location_id = ${ctx.locationId}
      and business_date between ${input.fromDate} and ${input.toDate}
      and status = 'planned'
    returning id`;

  audit({
    entityType: 'shift',
    after: { fromDate: input.fromDate, toDate: input.toDate, published: rows.length },
  });
  return { published: rows.length };
});
