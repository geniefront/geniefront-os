/**
 * 开店配置的实现。
 *
 * 一条原则：**下架不是删除**。项目下架后历史单据照常显示 ——
 * 开单时项目名和价格已经快照进 ticket_items，改价改名都不会污染历史（02 §8）。
 */

import {
  SaveService, ArchiveService, SaveStaffProfile,
  SetRotationParticipation, SaveBusinessHours,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SaveService, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveService.input._type>) => {
  if (input.serviceId) {
    const [exists] = await tx<{ id: string }[]>`
      select id from services where id = ${input.serviceId} and location_id = ${ctx.locationId}`;
    if (!exists) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });

    await tx`update services set
        name = ${jsonb(input.name)}::jsonb,
        duration_min = ${input.durationMin},
        base_price_cents = ${input.basePriceCents},
        taxable = ${input.taxable},
        online_bookable = ${input.onlineBookable},
        active = ${input.active}
      where id = ${input.serviceId}`;

    audit({ entityType: 'service', entityId: input.serviceId,
            after: { name: pickText(input.name, ctx.locale), durationMin: input.durationMin } });
    return { serviceId: input.serviceId, created: false };
  }

  const [row] = await tx<{ id: string }[]>`
    insert into services
      (org_id, location_id, name, duration_min, base_price_cents,
       taxable, online_bookable, active)
    values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(input.name)}::jsonb,
            ${input.durationMin}, ${input.basePriceCents},
            ${input.taxable}, ${input.onlineBookable}, ${input.active})
    returning id`;

  audit({ entityType: 'service', entityId: row!.id,
          after: { name: pickText(input.name, ctx.locale), created: true } });
  return { serviceId: row!.id, created: true };
});

registerHandler(ArchiveService, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ArchiveService.input._type>) => {
  // 下架而不是删除：历史 ticket_items 里存的是名字快照，但 service_id 外键还在
  const rows = await tx<{ id: string }[]>`
    update services set active = false
    where id = ${input.serviceId} and location_id = ${ctx.locationId}
    returning id`;
  if (rows.length === 0) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });

  audit({ entityType: 'service', entityId: input.serviceId, after: { active: false } });
  return { serviceId: input.serviceId };
});

registerHandler(SaveStaffProfile, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveStaffProfile.input._type>) => {
  const [cur] = await tx<{
    membership_id: string; is_bookable: boolean; max_concurrent: number;
  }[]>`
    select membership_id, is_bookable, max_concurrent_appointments as max_concurrent
    from staff_profiles
    where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

  await tx`update staff_profiles set
      display_name = coalesce(${input.displayName ? jsonb(input.displayName) : null}::jsonb, display_name),
      is_bookable = coalesce(${input.isBookable ?? null}, is_bookable),
      max_concurrent_appointments = coalesce(${input.maxConcurrentAppointments ?? null}, max_concurrent_appointments),
      level_id = ${input.levelId === undefined ? tx`level_id` : input.levelId}
    where membership_id = ${input.membershipId}`;

  audit({
    entityType: 'staff', entityId: input.membershipId,
    before: { isBookable: cur.is_bookable, maxConcurrent: cur.max_concurrent },
    after: {
      isBookable: input.isBookable ?? cur.is_bookable,
      maxConcurrent: input.maxConcurrentAppointments ?? cur.max_concurrent,
    },
  });
  return { membershipId: input.membershipId };
});

registerHandler(SetRotationParticipation, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetRotationParticipation.input._type>) => {
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${ctx.locationId}`;
  const date = input.businessDate ?? businessDateOf(new Date(), loc!.tz, loc!.cutoff);

  await tx`
    insert into rotation_participants (org_id, location_id, business_date, membership_id, in_rotation)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${input.membershipId}, ${input.inRotation})
    on conflict (location_id, business_date, membership_id)
      do update set in_rotation = excluded.in_rotation`;

  audit({ entityType: 'rotation_participant', entityId: input.membershipId,
          after: { businessDate: date, inRotation: input.inRotation } });
  return { membershipId: input.membershipId, inRotation: input.inRotation, businessDate: date };
});

registerHandler(SaveBusinessHours, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveBusinessHours.input._type>) => {
  // 跨午夜是合法的（足疗店开到凌晨 1 点），不做 open < close 的校验 ——
  // 营业日边界由 business_day_cutoff 负责，不是这里
  await tx`update locations set business_hours = ${jsonb(input.hours)}::jsonb
           where id = ${ctx.locationId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    after: { days: Object.entries(input.hours)
      .filter(([, v]) => v !== null).map(([k]) => k) },
  });
  return { locationId: ctx.locationId };
});
