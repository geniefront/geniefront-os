/**
 * appointment.create —— Phase 0 的验收命令。
 *
 * 三层约束在这里汇合（01 §7.1）：
 *   资源  → 数据库硬约束（容量触发器），撞了翻译成人话抛出，不给覆盖
 *   技师  → packages/scheduling 的纯函数判，可带 reason 放行
 *   门店  → 同上
 */

import { AppointmentCreate, AppError, ERROR_CODES, pickText } from '@gf/contracts';
import { renderConfirm, formatWhen } from '../email/render';
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

  await enqueueConfirmEmail(tx, ctx, appt!.id, itemIds[0] ?? null);

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


/**
 * 把预约确认信放进发件箱（**事务内**，和预约同生共死）。
 *
 * ⭐ 只是**入队**，不发。发在事务提交之后（`email/flush.ts`）——
 * 在事务里发的话，事务回滚了但邮件已经飞出去了：客人收到
 * 「您的预约已确认」而库里根本没有这条预约。邮件和扣款一样收不回来。
 *
 * ⚠️ **不看 `marketing_email_opt_in`。** 那是营销订阅开关，
 * 而预约确认是**事务性邮件**（他自己刚订了这个预约，我们回执一封）——
 * 两者在 CAN-SPAM 下也是分开的。把确认信卡在营销开关后面，
 * 结果是「订了但没收到确认」，客人会打电话来问。
 *
 * ⚠️ 任何一步取不到就**安静跳过**。没邮箱的客人是常态（走进来的散客），
 * 这不是错误；为它抛异常会让一个本来成功的建单失败。
 */
async function enqueueConfirmEmail(
  tx: HandlerArgs<Input>['tx'], ctx: HandlerArgs<Input>['ctx'],
  appointmentId: string, firstItemId: string | null,
): Promise<void> {
  if (!input_hasCustomerEmailSupport() || !firstItemId) return;

  const [row] = await tx<{
    email: string | null; customer_name: unknown;
    service_name: unknown; staff_name: unknown;
    starts_at: string; shop_name: unknown; timezone: string;
  }[]>`
    select c.email, c.display_name as customer_name,
           s.name as service_name, sp.display_name as staff_name,
           ai.starts_at::text as starts_at,
           l.name as shop_name, l.timezone
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join locations l on l.id = a.location_id
    left join customers c on c.id = a.customer_id
    left join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    where ai.id = ${firstItemId} and a.location_id = ${ctx.locationId}`;

  const to = row?.email?.trim();
  if (!to) return;   // 散客没留邮箱 —— 常态，不是错误

  const [line] = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where location_id = ${ctx.locationId} and purpose = 'main' and active limit 1`;

  const msg = renderConfirm({
    customerName: pickText(row!.customer_name, ctx.locale, '您'),
    shopName: pickText(row!.shop_name, ctx.locale, ''),
    serviceName: pickText(row!.service_name, ctx.locale, '预约'),
    whenText: formatWhen(new Date(row!.starts_at).toISOString(), row!.timezone),
    staffName: row!.staff_name ? pickText(row!.staff_name, ctx.locale) : null,
    shopPhone: line?.e164 ?? null,
  });

  // 幂等键是 (entity_type, entity_id, kind) 上的唯一索引 ——
  // 重投同一条命令不会发第二封。重复的确认信会让客人以为自己订了两次。
  await tx`
    insert into email_outbox
      (org_id, location_id, kind, to_email, subject, body_html, body_text,
       entity_type, entity_id)
    values (${ctx.orgId}, ${ctx.locationId}, 'appointment_confirm', ${to},
            ${msg.subject}, ${msg.html}, ${msg.text},
            'appointment', ${appointmentId})
    on conflict (entity_type, entity_id, kind) do nothing`;
}

/** 邮件没配好就整条路不走 —— 没必要往 outbox 里堆永远发不出去的行 */
function input_hasCustomerEmailSupport(): boolean {
  return Boolean(process.env['RESEND_API_KEY'] && process.env['FROM_EMAIL']);
}
