/**
 * appointment.create —— Phase 0 的验收命令。
 *
 * 三层约束在这里汇合（01 §7.1）：
 *   资源  → 数据库硬约束（容量触发器），撞了翻译成人话抛出，不给覆盖
 *   技师  → packages/scheduling 的纯函数判，可带 reason 放行
 *   门店  → 同上
 */

import { AppointmentCreate, AppError, ERROR_CODES } from '@gf/contracts';
import { checkCapacity, businessDateOf, hasBlocking, type Interval } from '@gf/scheduling';
import { ts, jsonb, parseTs } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

type Input = typeof AppointmentCreate.input._type;
type Output = typeof AppointmentCreate.output._type;

/**
 * 资源冲突的两种 SQLSTATE。
 *
 * 23P01 是排他约束（capacity = 1 的老写法，历史库里可能还有）；
 * 23001 是 0008 那个容量触发器抛的 restrict_violation ——
 * 一间房能同时服务多人之后，排他约束表达不了「最多 N 个」，
 * 换成了计数触发器（约束强度没变，仍在数据库层）。
 *
 * 两个都要认：只认一个的话，改成多容量的那天前台会看到
 * "23001 Room 2 这个时段已经满了" 这种半生不熟的原始报错。
 */
const RESOURCE_CONFLICT_CODES = new Set(['23P01', '23001']);

registerHandler(AppointmentCreate, async ({ input, ctx, tx, audit }: HandlerArgs<Input>): Promise<Output> => {
  // ── 门店配置 ──────────────────────────────────────────────────────────────
  const [loc] = await tx<{ timezone: string; cutoff: string; settings: Record<string, unknown> }[]>`
    select timezone, business_day_cutoff::text as cutoff, settings
    from locations where id = ${ctx.locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const capacityCfg = (loc.settings['capacity'] ?? {}) as {
    max_concurrent_per_slot?: number | null;
    overbook?: 'warn' | 'block';
  };

  // ── 项目与时长 ────────────────────────────────────────────────────────────
  const serviceIds = [...new Set(input.items.map((i) => i.serviceId))];
  const services = await tx<{ id: string; duration_min: number; base_price_cents: number }[]>`
    select id, duration_min, base_price_cents from services
    where id = any(${serviceIds}) and active = true`;
  const svcById = new Map(services.map((s) => [s.id, s]));

  const resolved = input.items.map((item) => {
    const svc = svcById.get(item.serviceId);
    if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: item.serviceId } });
    const startsAt = new Date(item.startsAt);
    const durationMin = item.durationMin ?? svc.duration_min;
    return {
      ...item,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
      durationMin,
      priceCents: item.priceCentsOverride ?? svc.base_price_cents,
    };
  });

  const windowStart = new Date(Math.min(...resolved.map((r) => r.startsAt.getTime())));
  const windowEnd = new Date(Math.max(...resolved.map((r) => r.endsAt.getTime())));
  const businessDate = businessDateOf(windowStart, loc.timezone, loc.cutoff);

  // ── 当天已有的活跃时段（供容量判断）────────────────────────────────────────
  const existingRows = await tx<{ membership_id: string | null; starts_at: string; ends_at: string }[]>`
    select membership_id, starts_at, ends_at from appointment_items
    where location_id = ${ctx.locationId}
      and status in ('booked','in_service')
      and starts_at < ${ts(windowEnd)}::timestamptz
      and ends_at   > ${ts(windowStart)}::timestamptz`;

  // timestamptz 读回来是字符串，容量引擎要的是 Date —— 在边界上一次转清楚
  const existing = existingRows.map((e) => ({
    membershipId: e.membership_id,
    startsAt: parseTs(e.starts_at),
    endsAt: parseTs(e.ends_at),
  }));

  const staffIds = [...new Set(resolved.map((r) => r.membershipId).filter((x): x is string => !!x))];
  const staffRows = staffIds.length
    ? await tx<{ membership_id: string; is_bookable: boolean; max_concurrent: number }[]>`
        select membership_id, is_bookable,
               max_concurrent_appointments as max_concurrent
        from staff_profiles where membership_id = any(${staffIds})`
    : [];
  const staffById = new Map(staffRows.map((s) => [s.membership_id, s]));

  const [onDuty] = await tx<{ n: number }[]>`
    select count(*)::int as n from staff_profiles
    where location_id = ${ctx.locationId} and is_bookable = true`;

  // ── 容量检查（纯函数，唯一实现）────────────────────────────────────────────
  const overbookedIdx = new Set<number>();

  for (const [idx, item] of resolved.entries()) {
    const staff = item.membershipId ? staffById.get(item.membershipId) : undefined;
    if (item.membershipId && !staff) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { membershipId: item.membershipId } });
    }

    const proposed: Interval = { startsAt: item.startsAt, endsAt: item.endsAt };
    const issues = checkCapacity({
      proposed,
      staff: staff
        ? {
            membershipId: staff.membership_id,
            maxConcurrent: staff.max_concurrent,
            isBookable: staff.is_bookable,
            existing: existing.filter((e) => e.membershipId === staff.membership_id),
          }
        : null,
      location: {
        maxConcurrentPerSlot: capacityCfg.max_concurrent_per_slot ?? null,
        onDutyBookableCount: onDuty?.n ?? 0,
        existing,
      },
    });

    if (issues.length === 0) continue;

    // 覆盖不了的（比如这人根本不接客）—— 有 reason 也没用
    const blocking = issues.find((i) => !i.overridable);
    if (blocking) {
      throw new AppError(ERROR_CODES.STAFF_NOT_BOOKABLE, { details: { itemIndex: idx, ...blocking } });
    }

    // 软约束：门店把 overbook 设成 block 时不给覆盖入口
    if (capacityCfg.overbook === 'block' || !input.override) {
      const first = issues[0]!;
      throw new AppError(
        first.code === 'STAFF_OVER_CAPACITY'
          ? ERROR_CODES.STAFF_OVER_CAPACITY
          : ERROR_CODES.LOCATION_OVER_CAPACITY,
        { details: { itemIndex: idx, issues } },
      );
    }

    overbookedIdx.add(idx);
  }

  // ── 写库 ─────────────────────────────────────────────────────────────────
  const [appt] = await tx<{ id: string }[]>`
    insert into appointments
      (org_id, location_id, customer_id, walk_in_name, business_date,
       starts_at, ends_at, source, party_size, notes, created_by, idempotency_key)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${input.customerId}, ${input.walkInName ?? null},
       ${businessDate}, ${ts(windowStart)}::timestamptz, ${ts(windowEnd)}::timestamptz, ${input.source},
       ${input.partySize}, ${input.notes ?? null}, ${ctx.membershipId}, null)
    returning id`;

  const itemIds: string[] = [];
  const overbookedItemIds: string[] = [];

  for (const [idx, item] of resolved.entries()) {
    const isOver = overbookedIdx.has(idx);
    try {
      const [row] = await tx<{ id: string }[]>`
        insert into appointment_items
          (org_id, location_id, appointment_id, service_id, addon_ids, membership_id,
           is_request, resource_id, starts_at, ends_at, price_cents_snapshot,
           duration_min, seq, overbooked, overbook_reason, overbook_note, details)
        values
          (${ctx.orgId}, ${ctx.locationId}, ${appt!.id}, ${item.serviceId},
           ${item.addonIds}, ${item.membershipId}, ${item.isRequest}, ${item.resourceId},
           ${ts(item.startsAt)}::timestamptz, ${ts(item.endsAt)}::timestamptz,
           ${item.priceCents}, ${item.durationMin}, ${idx},
           ${isOver}, ${isOver ? input.override!.reason : null},
           ${isOver ? (input.override!.note ?? null) : null},
           ${jsonb(item.details)}::jsonb)
        returning id`;
      itemIds.push(row!.id);
      if (isOver) overbookedItemIds.push(row!.id);
    } catch (e) {
      // 资源硬冲突：前台看不懂 "23P01 conflicting key value"，翻译成人话
      if (isExclusionViolation(e)) {
        throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
          details: {
            itemIndex: idx,
            resourceId: item.resourceId,
            startsAt: item.startsAt.toISOString(),
            endsAt: item.endsAt.toISOString(),
          },
          cause: e,
        });
      }
      throw e;
    }
  }

  // 审计由总线统一落库并做金额脱敏
  audit({
    entityType: 'appointment',
    entityId: appt!.id,
    after: {
      businessDate,
      source: input.source,
      itemCount: itemIds.length,
      overbooked: overbookedItemIds.length,
      overrideReason: input.override?.reason ?? null,
    },
  });

  return { appointmentId: appt!.id, itemIds, overbookedItemIds, businessDate };
});

function isExclusionViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e
    && typeof e.code === 'string' && RESOURCE_CONFLICT_CODES.has(e.code);
}

// 让 hasBlocking 保持被引用：容量结果的语义检查在上面按 issue 逐条做，
// 这里导出一个便捷判断给后续的 reschedule 复用。
export const _hasBlocking = hasBlocking;
