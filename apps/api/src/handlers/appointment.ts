/**
 * appointment.create —— Phase 0 的验收命令。
 *
 * 三层约束在这里汇合（01 §7.1）：
 *   资源  → 数据库硬约束（容量触发器），撞了翻译成人话抛出，不给覆盖
 *   技师  → packages/scheduling 的纯函数判，可带 reason 放行
 *   门店  → 同上
 */

import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  AppointmentCreate, AppointmentCreateBatch, AppointmentAddItem, AppointmentCancel, AppointmentReschedule,
  AppointmentSaveServiceBrief, AppointmentAssignCustomer,
  AppError, ERROR_CODES, pickText, type CommandContext,
} from '@gf/contracts';
import { renderConfirm, formatWhen } from '../email/render';
import { emailConfigured } from '../email/send';
import { hostedManageBookingUrl } from '../links';
import { generateConfirmationCode, generateManageToken, hashManageToken, wrapManageToken } from '../public/bookingToken';
import { guestManageLink, manageUrlVar } from '../notify/manageUrl';
import { enqueueShopCopy } from '../email/shopCopy';
import { renderConfirmSms } from '../sms/render';
import { segmentsOf } from '../sms/segments';
import { smsConfigured, smsFrom } from '../sms/send';
import {
  checkCapacity, businessDateOf, hasBlocking, checkBusinessHours, NO_OFF_HOURS,
  type Interval, type WeeklyHours, type OffHoursWindow,
} from '@gf/scheduling';
import { ts, jsonb, parseTs } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { notifyEvent } from '../notify/dispatch';

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

/**
 * 官网和电话 AI 这两条路上**没有人**。
 *
 * 它们和前台的区别不是权限大小，是**有没有一个能负责的人在现场**：
 * 前台把客人排到八点半，是他看着排班表、知道谁会提前来开门；
 * 官网把八点半卖出去，没有任何人知道这件事，直到客人到了门口。
 */
/**
 * 客人**自己发起**的预约来路。
 *
 * 这个集合有两个用途，而且刚好是同一条判据：
 * 1. 营业时间闸门按公开渠道处理（客人订到打烊后要拦，前台代订可以放行）；
 * 2. **只有这两条路才自动发确认信/短信** —— 见 `executeSingleAppointmentInTx`
 *    末尾那段长注释。
 */
export const PUBLIC_SOURCES = new Set(['web', 'phone_ai']);

interface OffHoursPolicy {
  enforce: boolean;
  window: OffHoursWindow;
  beyond: 'warn' | 'block';
}

/** 读 `settings.off_hours`（0046）。读到脏值一律退回「不拦」——闸门宁可漏也不能误伤 */
function readOffHours(settings: Record<string, unknown>): OffHoursPolicy {
  const raw = (settings['off_hours'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(240, Math.floor(n)) : 0;
  };
  return {
    enforce: raw['enforce'] === true,
    window: {
      beforeOpenMinutes: num(raw['before_open_minutes']),
      afterCloseMinutes: num(raw['after_close_minutes']),
    },
    beyond: raw['beyond'] === 'block' ? 'block' : 'warn',
  };
}

/**
 * 营业时间闸门（0046）。返回 true = 越界了但被前台带 reason 放行。
 *
 * 三条渠道三种待遇，都在这里：
 *
 * | | 宽限窗口 | 越界之后 |
 * | :--- | :--- | :--- |
 * | 官网 / 电话 AI | **不给** | 一律拒，reason 也没用 |
 * | 前台（闸门关着）| — | 不查，想约几点约几点 |
 * | 前台（闸门开着）| 给 | `warn` 带 reason 放行 / `block` 一律拒 |
 *
 * ⚠️ 公开渠道那一行**不看 `enforce`**。老板那个开关管的是
 * 「前台能不能通融」，不是「要不要把营业时间外的格子挂到网上卖」——
 * 后者从来不是一个选项。
 */
function assertBusinessHours(args: {
  businessDate: string;
  timezone: string;
  hours: WeeklyHours | null | undefined;
  startsAt: Date;
  endsAt: Date;
  policy: OffHoursPolicy;
  isPublic: boolean;
  hasOverride: boolean;
  details: Record<string, unknown>;
}): boolean {
  const { policy, isPublic, hasOverride } = args;
  if (!isPublic && !policy.enforce) return false;

  const issue = checkBusinessHours({
    businessDate: args.businessDate,
    timezone: args.timezone,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    hours: args.hours,
    // 公开渠道不吃宽限：宽限是「前台可以通融」，不是「网上可以卖」
    window: isPublic ? NO_OFF_HOURS : policy.window,
  });
  if (!issue) return false;

  const overridable = !isPublic && policy.beyond === 'warn';
  if (overridable && hasOverride) return true;

  /*
   * ⚠️ `overridable` 放在**顶层**，不放 details。
   *
   * 顶层那个字段的默认值来自 `OVERRIDABLE_CODES`（按码给的静态答案，
   * 这个码是 true）。而这里的真实答案按渠道变 —— 官网越界时是 false。
   * 两处都写就会出现「顶层 true、details 里 false」的自相矛盾响应，
   * 前端读哪个都像对的。
   */
  throw new AppError(ERROR_CODES.OUTSIDE_BUSINESS_HOURS, {
    details: { ...args.details, issue },
    overridable,
  });
}

/**
 * 技师容量的并发闸门。
 *
 * ## 为什么必须有这一把锁
 *
 * 容量检查是「读一遍当前时段有谁 → 纯函数判断 → 写入」。这三步之间
 * 没有任何东西阻止**另一个事务做同样的事**：两条并发的官网预约各自
 * 读到「这个格子是空的」，各自通过 `checkCapacity`，各自插入成功。
 * 技师被双排，而系统里没有任何痕迹说明它发生过 —— 直到客人到店。
 *
 * ⚠️ 数据库那道硬约束**接不住这个场景**：`resource_capacity_guard()`
 * 第一行就是 `if new.resource_id is null then return new`，而
 * 「约技师、不指定房间」正是官网预约最常见的形态。`appointment_items`
 * 上也没有任何针对 `membership_id` 的排他约束 —— 有多技师、多容量、
 * 可超排三层语义之后，那个约束表达不出来，判断只能留在应用层。
 * 判断留在应用层，就必须自己把并发窗口关上。
 *
 * ## 为什么按门店锁，而不是按技师或按时段
 *
 * 按技师锁挡不住门店级容量（`max_concurrent_per_slot`）—— 那一条要看
 * 全店同时段的总数，锁住 Amy 不妨碍别人把全店排爆。按（门店，营业日）
 * 锁则要先算出营业日，而改期涉及**两个**营业日（原来的和新的），
 * 顺序不一致就会死锁。
 *
 * 按门店锁最钝也最不会错。代价是同一家店的预约写入串行 —— 对一家
 * 沙龙来说这是每分钟个位数的量级，而正确性换的是「技师不会被双排」。
 *
 * ⚠️ 三个入口（create / reschedule / addItem）**必须都加**，而且都要
 * 加在任何容量相关读取**之前**：漏一个等于没加，因为漏掉的那条路
 * 仍然可以和其余两条并发。加在最前面还顺带统一了加锁顺序，
 * 避免和 `for update` 交叉成环。
 */
/**
 * 门店层容量的分母：这个营业日**在岗且接客**的人数。
 *
 * 优先按已发布的班表算 —— 这和 queries/slots.ts 报给客人的可约时间是同一个
 * 口径，两处算法漂开的话，官网显示有空、建单却说满了。
 *
 * 没有任何已发布班次时退回「在册可接客人数」：不排班的小店（这行里很常见）
 * 班表恒为空，按班表算等于 0，而 0 在容量引擎里意味着**关闭门店层检查**，
 * 那就把一整层约束悄悄取消了。
 */
async function countOnDutyBookable(
  tx: postgres.TransactionSql, locationId: string, businessDate: string,
): Promise<number> {
  const [shifted] = await tx<{ n: number }[]>`
    select count(distinct s.membership_id)::int as n
    from shifts s
    join staff_profiles sp on sp.membership_id = s.membership_id
    join memberships m on m.id = s.membership_id and m.status = 'active'
    where s.location_id = ${locationId}
      and s.business_date = ${businessDate}
      and s.status = 'published'
      and sp.is_bookable = true`;
  if ((shifted?.n ?? 0) > 0) return shifted!.n;

  const [roster] = await tx<{ n: number }[]>`
    select count(*)::int as n from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.location_id = ${locationId} and sp.is_bookable = true`;
  return roster?.n ?? 0;
}

async function lockBookingCapacity(
  tx: postgres.TransactionSql, locationId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtext(${locationId}), hashtext('appointment.capacity'))`;
}

export async function executeSingleAppointmentInTx(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  input: Input,
): Promise<{
  appointmentId: string;
  itemIds: string[];
  overbookedItemIds: string[];
  businessDate: string;
  offHoursOverride: boolean;
}> {
  await lockBookingCapacity(tx, ctx.locationId);

  // ── 门店配置 ──────────────────────────────────────────────────────────────
  const [loc] = await tx<{
    timezone: string; cutoff: string; settings: Record<string, unknown>; hours: WeeklyHours;
  }[]>`
    select timezone, business_day_cutoff::text as cutoff, settings,
           business_hours as hours
    from locations where id = ${ctx.locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const capacityCfg = (loc.settings['capacity'] ?? {}) as {
    max_concurrent_per_slot?: number | null;
    overbook?: 'warn' | 'block';
  };

  // ── 项目、加项与时长 ──────────────────────────────────────────────────────
  //
  // ⭐ **加项是独立收费的服务，必须算进价格快照。**
  //
  // 这里以前只查主项目，`addonIds` 原样存进 `addon_ids` 就不管了 —— 而
  // `ticket.ts` 开工单时直接取 `price_cents_snapshot`，全链路没有任何一处
  // 回头读 `addon_ids` 去补价。结果是：凡是从前台或副驾建的带加项的单
  //（「足疗 60 分钟 + 拔罐」），加项的钱最后一分都收不到。
  //
  // 公开预约那条路（`public/routes.ts` 的 `priceAndDuration`）本来就是累加的，
  // 所以这不是「改规则」，是把另外两条路对齐到同一个口径上。
  //
  // 时长的口径和价格不同：调用方**显式给了 `durationMin` 就以它为准**
  //（截图导入时「60min + 拔罐」往往已经写成了总时长 75），没给才按
  // 主项目 + 各加项的标准时长累加。价格没有这个歧义，一律累加。
  const serviceIds = [...new Set(input.items.flatMap((i) => [i.serviceId, ...i.addonIds]))];
  const services = await tx<{ id: string; duration_min: number; base_price_cents: number }[]>`
    select id, duration_min, base_price_cents from services
    where id = any(${serviceIds}) and active = true`;
  const svcById = new Map(services.map((s) => [s.id, s]));

  const resolved = input.items.map((item) => {
    const svc = svcById.get(item.serviceId);
    if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: item.serviceId } });

    const addons = item.addonIds.map((id) => {
      const a = svcById.get(id);
      // 加项查不到就直接拒，不静默丢掉：存一个悬空的 addon_id 比报错糟糕得多
      if (!a) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { addonId: id } });
      return a;
    });

    const addonCents = addons.reduce((n, a) => n + a.base_price_cents, 0);
    const addonMinutes = addons.reduce((n, a) => n + a.duration_min, 0);

    const startsAt = new Date(item.startsAt);
    const durationMin = item.durationMin ?? (svc.duration_min + addonMinutes);
    return {
      ...item,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
      durationMin,
      priceCents: item.priceCentsOverride ?? (svc.base_price_cents + addonCents),
    };
  });

  const windowStart = new Date(Math.min(...resolved.map((r) => r.startsAt.getTime())));
  const windowEnd = new Date(Math.max(...resolved.map((r) => r.endsAt.getTime())));
  const businessDate = businessDateOf(windowStart, loc.timezone, loc.cutoff);

  // ── 营业时间闸门（0046）────────────────────────────────────────────────────
  const offHoursOverride = assertBusinessHours({
    businessDate, timezone: loc.timezone, hours: loc.hours,
    startsAt: windowStart, endsAt: windowEnd,
    policy: readOffHours(loc.settings),
    isPublic: PUBLIC_SOURCES.has(input.source) || ctx.membershipId === null,
    hasOverride: !!input.override,
    details: { source: input.source },
  });

  // ── 当天已有的活跃时段（供容量判断）────────────────────────────────────────
  const existingRows = await tx<{
    group_key: string; membership_id: string | null; starts_at: string; ends_at: string;
  }[]>`
    select case when a.party_size > 1 then ai.id::text else ai.appointment_id::text end as group_key,
           ai.membership_id, ai.starts_at, ai.ends_at
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    where ai.location_id = ${ctx.locationId}
      and ai.status in ('booked','in_service')
      and ai.starts_at < ${ts(windowEnd)}::timestamptz
      and ai.ends_at   > ${ts(windowStart)}::timestamptz`;

  const existing: Array<Interval & { membershipId: string | null }> = existingRows.map((e) => ({
    membershipId: e.membership_id,
    startsAt: parseTs(e.starts_at),
    endsAt: parseTs(e.ends_at),
    groupKey: e.group_key,
  }));

  const staffIds = [...new Set(resolved.map((r) => r.membershipId).filter((x): x is string => !!x))];
  const staffRows = staffIds.length
    ? await tx<{ membership_id: string; is_bookable: boolean; max_concurrent: number }[]>`
        select membership_id, is_bookable,
               max_concurrent_appointments as max_concurrent
        from staff_profiles
        where membership_id = any(${staffIds}) and location_id = ${ctx.locationId}`
    : [];
  const staffById = new Map(staffRows.map((s) => [s.membership_id, s]));

  const onDutyBookableCount = await countOnDutyBookable(tx, ctx.locationId, businessDate);

  const newApptKey = input.partySize > 1 ? null : `pending:${randomUUID()}`;
  const overbookedIdx = new Set<number>();

  for (const [idx, item] of resolved.entries()) {
    const staff = item.membershipId ? staffById.get(item.membershipId) : undefined;
    if (item.membershipId && !staff) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { membershipId: item.membershipId } });
    }

    const proposed: Interval = {
      startsAt: item.startsAt, endsAt: item.endsAt,
      groupKey: newApptKey ?? `pending-item:${idx}`,
    };
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
        onDutyBookableCount,
        existing,
      },
    });

    existing.push({ ...proposed, membershipId: item.membershipId ?? null });

    if (issues.length === 0) continue;

    const blocking = issues.find((i) => !i.overridable);
    if (blocking) {
      throw new AppError(ERROR_CODES.STAFF_NOT_BOOKABLE, { details: { itemIndex: idx, ...blocking } });
    }

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

  // ── 官网来的单：先把「填表的那个人」落成客户 ────────────────────────────
  const customerId = input.guest?.customer
    ? await resolveGuestCustomer(tx, ctx, input.guest.customer)
    : input.customerId;

  let issuedManageToken = input.guest?.manageToken ?? null;
  if (!issuedManageToken && customerId
      && (input.source === 'desk' || input.source === 'phone_manual')) {
    const [cust] = await tx<{ phone: string | null }[]>`
      select phone_e164 as phone from customers where id = ${customerId}`;
    if (cust?.phone) issuedManageToken = generateManageToken();
  }
  const manageDigest = issuedManageToken ? hashManageToken(issuedManageToken) : null;
  const manageWrapped = issuedManageToken ? wrapManageToken(issuedManageToken) : null;

  // ── 写库 ─────────────────────────────────────────────────────────────────
  const [appt] = await tx<{ id: string }[]>`
    insert into appointments
      (org_id, location_id, customer_id, walk_in_name, business_date,
       starts_at, ends_at, source, party_size, notes, created_by, idempotency_key,
       confirmation_code, manage_token_digest, manage_token_wrapped,
       is_backfill, backfill_reason, backfill_notes)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${customerId}, ${input.walkInName ?? null},
       ${businessDate}, ${ts(windowStart)}::timestamptz, ${ts(windowEnd)}::timestamptz, ${input.source},
       ${input.partySize}, ${input.notes ?? null}, ${ctx.membershipId}, null,
       ${input.guest?.confirmationCode ?? null},
       ${manageDigest}, ${manageWrapped},
       ${input.isBackfill ?? false}, ${input.backfillReason ?? null}, ${input.backfillNotes ?? null})
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

  /*
   * ⚠️ **只有客人自己发起的预约才自动发确认信/短信。**
   *
   * `PUBLIC_SOURCES`（`web` 官网自助、`phone_ai` AI 语音来电）这两条路上，
   * 客人是主动把手机号/邮箱交给我们、并且知道自己刚订了一单的 —— 一封确认
   * 是他期待收到的。
   *
   * 其余来路（`desk` 前台代订、`walkin` 到店散客、`ai_copilot` 副驾录入）
   * **一律不发**：那些号码多半是历史档案里的，客人从没勾过任何接收同意。
   * 往这些号码上群发确认短信，轻则被投诉，重则整个发送域被运营商和
   * 邮件服务商标记成垃圾源 —— 那会连带把上面两条**该发的**也一起送进垃圾箱，
   * 代价远大于「前台代订的客人没收到确认信」。
   *
   * 要给这类客人补一条通知，走前台显式点击的那条路（有 notifyCustomer 开关），
   * 不要在这里放开。
   */
  if (PUBLIC_SOURCES.has(input.source)) {
    await enqueueConfirmEmail(tx, ctx, appt!.id, itemIds[0] ?? null, issuedManageToken);
    await enqueueConfirmSms(tx, ctx, appt!.id, itemIds[0] ?? null, issuedManageToken);
  }

  return {
    appointmentId: appt!.id,
    itemIds,
    overbookedItemIds,
    businessDate,
    offHoursOverride,
  };
}

registerHandler(AppointmentCreate, async ({ input, ctx, tx, audit }: HandlerArgs<Input>): Promise<Output> => {
  const result = await executeSingleAppointmentInTx(tx, ctx, input);

  audit({
    entityType: 'appointment',
    entityId: result.appointmentId,
    after: {
      businessDate: result.businessDate,
      source: input.source,
      itemCount: result.itemIds.length,
      overbooked: result.overbookedItemIds.length,
      offHours: result.offHoursOverride,
      overrideReason: input.override?.reason ?? null,
      confirmationCode: input.guest?.confirmationCode ?? null,
    },
  });

  return {
    appointmentId: result.appointmentId,
    itemIds: result.itemIds,
    overbookedItemIds: result.overbookedItemIds,
    businessDate: result.businessDate,
  };
});

registerHandler(AppointmentCreateBatch, async ({ input, ctx, tx, audit }: HandlerArgs<typeof AppointmentCreateBatch.input._type>) => {
  const results: Array<{
    subKey: string;
    appointmentId: string;
    itemIds: string[];
    businessDate: string;
  }> = [];

  for (const item of input.items) {
    let guestObj: Input['guest'] | undefined = undefined;
    if (item.guest) {
      const g = item.guest;
      const custName = g.customer?.name ?? g.name ?? 'Guest';
      const custPhone = g.customer?.phoneE164 ?? g.phoneE164 ?? '';
      guestObj = {
        confirmationCode: g.confirmationCode ?? generateConfirmationCode('GF'),
        manageToken: g.manageToken ?? generateManageToken(),
        customer: {
          name: custName,
          phoneE164: custPhone,
          email: g.customer?.email ?? g.email,
          smsOptIn: g.customer?.smsOptIn ?? g.smsOptIn ?? false,
        },
      };
    }

    const singleInput: Input = {
      customerId: item.customerId ?? null,
      walkInName: item.walkInName,
      items: item.serviceItems,
      partySize: 1,
      notes: item.notes,
      source: input.source,
      override: item.override,
      guest: guestObj,
    };

    const res = await executeSingleAppointmentInTx(tx, ctx, singleInput);
    results.push({
      subKey: item.subKey,
      appointmentId: res.appointmentId,
      itemIds: res.itemIds,
      businessDate: res.businessDate,
    });
  }

  audit({
    entityType: 'appointment_batch',
    entityId: input.batchId,
    after: {
      batchId: input.batchId,
      count: results.length,
      source: input.source,
    },
  });

  return {
    batchId: input.batchId,
    results,
  };
});

/**
 * 官网订单里那个填表的人 → 一条 customers 记录。
 *
 * ## ⭐ 宪法第 16 条在这里是怎么落的
 *
 * 「客户的唯一凭证是 customers.id，手机号只是查找键。**同号多客户必须走
 * 选择器，默认不自动匹配**。」—— 而公开预约页上**没有选择器可走**：
 * 那头是客人自己，我们既不能把同号的几个人列给他看（那是在泄露
 * 「这个号码在这家店还有谁」），也不能替他挑一个。
 *
 * 所以规则是：**只在手机号和姓名都一模一样、而且只有一条时才复用**。
 *
 *   · 妈妈和女儿共用一个号（决策 16 里那个真实场景）→ 名字不同 → 各是各的
 *   · 同一个人第三次上网订 → 号和名都一样 → 复用，不会攒出三条重复客户
 *   · 同号同名有两条（前台以前手滑建重了）→ **不猜**，建新的，
 *     让前台事后用 `customer.merge` 合并。猜错的代价是把两个人的
 *     消费记录并到一起，而那是不可逆的
 *
 * ## 为什么不干脆只用 walk_in_name 不建客户
 *
 * 那样确认信发不出去（邮箱没地方存），而且这位客人第二次来时
 * 前台看不到他上次做了什么 —— 网上订的客人恰恰是最该被记住的那批。
 */
async function resolveGuestCustomer(
  tx: HandlerArgs<Input>['tx'],
  ctx: HandlerArgs<Input>['ctx'],
  c: NonNullable<NonNullable<Input['guest']>['customer']>,
): Promise<string> {
  const name = c.name.trim();

  const same = await tx<{ id: string }[]>`
    select id from customers
    where org_id = ${ctx.orgId}
      and phone_e164 = ${c.phoneE164}
      and lower(trim(display_name)) = lower(${name})
      and merged_into_id is null
      and blocked_at is null
    limit 2`;

  if (same.length === 1) {
    // 邮箱可能是这次才留的。只在原来没有时补，**不覆盖** ——
    // 前台后来改过的那一版比官网表单里随手填的可信
    if (c.email) {
      await tx`
        update customers set email = ${c.email}
        where id = ${same[0]!.id} and (email is null or email = '')`;
    }
    return same[0]!.id;
  }

  const [row] = await tx<{ id: string }[]>`
    insert into customers
      (org_id, primary_location_id, display_name, phone_e164, email, locale,
       source, marketing_sms_opt_in, marketing_email_opt_in)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${name}, ${c.phoneE164},
       ${c.email ?? null}, ${ctx.locale}, 'web',
       ${c.smsOptIn}, false)
    returning id`;
  return row!.id;
}

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
  manageToken: string | null,
): Promise<void> {
  if (!input_hasCustomerEmailSupport() || !firstItemId) return;

  const [row] = await tx<{
    email: string | null; customer_name: unknown; phone: string | null;
    service_name: unknown; staff_name: unknown;
    starts_at: string; shop_name: unknown; timezone: string; slug: string;
  }[]>`
    select c.email, c.display_name as customer_name, c.phone_e164 as phone,
           s.name as service_name, sp.display_name as staff_name,
           ai.starts_at::text as starts_at,
           l.name as shop_name, l.timezone, l.slug
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

  /**
   * ⭐ 自助管理链接（批 2，docs/13 §4.6）。初版**刻意不放**，理由是
   * 「一封会被转发、会被同事看到的邮件不该自带一个能改动预约的凭证」。
   *
   * 现在放了，因为那个凭证不再是单因素：打开链接之后还要输**手机后四位**
   * 才动得了（`public/routes.ts` §assertLast4）。捡到链接的同事没有那四位数。
   *
   * ⚠️ **没留手机号的单不放链接。** 那种单验不了后四位，令牌就又变回单因素了 ——
   * 那条路只留给官网（建单响应里返回过一次令牌），不进邮件。
   */
  /*
   * ⚠️ 链接由 `links.ts` 的 `manageBookingUrl()` 构造，禁止在此处拼接：
   *
   *   · origin 必须是**对外预约页**（`BOOKING_PAGE_ORIGIN`）。此前取的是
   *     `APP_BASE_URL`，即员工工作台 —— 顾客点开只会落到登录页；
   *   · 必须携带门店 `public_key`。该页面调用公开预约 API，每一次请求都
   *     要求 `X-GF-Public-Key` 头，缺少该参数时页面无法完成任何请求；
   *   · 兜底值按环境分流，staging 发出的邮件不得指向生产站点。
   */
  const manageUrl = manageToken && row!.phone
    ? hostedManageBookingUrl({ shopSlug: row!.slug, manageToken })
    : null;

  /*
   * ⚠️ 顾客侧邮件**恒为英语**（`email/render.ts` 文件头的语言策略）。
   * 门店名、服务名、技师名一律按 `'en'` 取，不跟随 `ctx.locale` ——
   * 后者是当前操作员的界面语言，与收件人无关。
   */
  const msg = renderConfirm({
    customerName: pickText(row!.customer_name, 'en', 'there'),
    shopName: pickText(row!.shop_name, 'en', ''),
    serviceName: pickText(row!.service_name, 'en', 'your appointment'),
    whenText: formatWhen(new Date(row!.starts_at).toISOString(), row!.timezone, 'en-US'),
    staffName: row!.staff_name ? pickText(row!.staff_name, 'en') : null,
    shopPhone: line?.e164 ?? null,
    manageUrl,
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

  // 抄送门店一份（默认开，可在设置里关）。正文与顾客那一封逐字相同
  await enqueueShopCopy(tx, {
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    kind: 'appointment_confirm',
    entityType: 'appointment',
    entityId: appointmentId,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    customerEmail: to,
  });
}


/**
 * 把预约确认**短信**放进发件箱（**事务内**，和预约同生共死）。
 *
 * 结构和上面那封邮件一模一样，理由也一样：只入队、不发，发在事务提交之后
 * （`sms/flush.ts`）。在事务里发的话，回滚之后客人已经收到
 * 「You're booked」而库里没有这条预约 —— 短信和扣款一样收不回来。
 *
 * ## ⚠️ 三条边界
 *
 * 1. **没有手机号就安静跳过。** 走进来的散客常常只留个名字，这不是错误
 * 2. **不看 `marketing_sms_opt_in`。** 那是营销订阅开关，而预约确认是
 *    **事务性短信** —— 客人自己刚订了这个预约，我们回执一条。
 *    两者在 TCPA 下是分开的。把确认卡在营销开关后面，
 *    结果是「订了但没收到确认」，客人会打电话来问
 * 3. **退订（STOP）拦在 flush 那一层**，不在这里。入队时他可能还没退订，
 *    而发出去之前必须再判一次（`sms/flush.ts` 里那段）
 */
async function enqueueConfirmSms(
  tx: HandlerArgs<Input>['tx'], ctx: HandlerArgs<Input>['ctx'],
  appointmentId: string, firstItemId: string | null,
  manageToken: string | null,
): Promise<void> {
  if (!smsConfigured() || !firstItemId) return;

  const [row] = await tx<{
    phone: string | null; service_name: unknown;
    starts_at: string; shop_name: unknown; shop_slug: string; timezone: string;
  }[]>`
    select c.phone_e164 as phone, s.name as service_name,
           ai.starts_at::text as starts_at, l.name as shop_name, l.slug as shop_slug, l.timezone
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join locations l on l.id = a.location_id
    left join customers c on c.id = a.customer_id
    left join services s on s.id = ai.service_id
    where ai.id = ${firstItemId} and a.location_id = ${ctx.locationId}`;

  const to = row?.phone?.trim();
  if (!to) return;   // 没留手机号 —— 常态，不是错误

  const [line] = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where location_id = ${ctx.locationId} and purpose = 'main' and active limit 1`;

  /**
   * ⚠️ 项目名和店名都强制走**英文**，不跟 ctx.locale 走。
   *
   * 一个中文字符就能把整条短信从 GSM-7（160 字符/段）推进 UCS-2（70 字符/段），
   * 成本翻倍而客人看到的完全一样（`sms/segments.ts`）。
   * 店主 2026-08-22 定：短信只做英文。
   */
  const manageUrl = manageToken
    ? hostedManageBookingUrl({ shopSlug: row!.shop_slug, manageToken })
    : null;
  const body = renderConfirmSms({
    shopName: row!.shop_name,
    shopSlug: row!.shop_slug,
    serviceName: pickText(row!.service_name, 'en', 'your appointment'),
    whenText: formatWhenSms(new Date(row!.starts_at).toISOString(), row!.timezone),
    shopPhone: line?.e164 ?? null,
    manageUrl,
  });

  await tx`
    insert into sms_outbox
      (org_id, location_id, kind, to_e164, from_e164, body, segments, entity_type, entity_id)
    values (${ctx.orgId}, ${ctx.locationId}, 'appointment_confirm', ${to}, ${smsFrom()},
            ${body}, ${segmentsOf(body)}, 'appointment', ${appointmentId})
    on conflict (entity_type, entity_id, kind) do nothing`;
}

/**
 * 短信里的时间。**门店时区**，英文，短 —— 每个字符都要付钱。
 *
 * 和 `email/render.ts` 的 `formatWhen` 分开而不是复用：那个是中文长格式
 * （「8月26日 周三 下午12:30」），在短信里既是 UCS-2 又占地方。
 */
function formatWhenSms(iso: string, timezone: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit',
  }).format(d);
  return `${date}, ${time}`;
}

/**
 * 邮件未配置时整条路不走 —— 没必要往 outbox 里堆永远发不出去的行。
 *
 * ⚠️ 判据复用 `email/send.ts` 的 `emailConfigured()`，不在此处重复拼一遍条件。
 * 两处各写一份的话，capture 模式与测试进程这两个例外只会被其中一处照顾到，
 * 而表现是「测试收件箱永远是空的」，且看不出与本函数有关。
 */
function input_hasCustomerEmailSupport(): boolean {
  return emailConfigured();
}

/**
 * appointment.cancel
 *
 * ⚠️ **这条命令在 2026-08-21 之前一直没有实现** —— 契约在
 * `packages/contracts` 里躺着，`EditBookingSheet.tsx` 也已经在调它，
 * 但总线上没人注册，所以前台点「取消这一单」拿到的是一个
 * `NOT_FOUND { command: 'appointment.cancel' }`。做公开预约的自助取消时
 * 撞出来的，顺手补上。
 *
 * ## `keepStaffTurn` 在这里的边界 ⭐
 *
 * 契约里那段话（「不问的话系统会默认技师没干活，释放档期并打乱轮牌队列」）
 * 说的是**已经开单**的情形。而实际的数据模型里，轮次是**开单/结单**
 * 消耗的（`rotation_events.reason = 'served'`，由 ticket 那条路写），
 * **不是订单消耗的** —— 一条 `booked` 但还没开单的预约，
 * 轮牌上根本没有它的痕迹，没有什么可保留也没有什么可释放。
 *
 * 所以这里的处理是：
 *
 *   · 还没开单 → 直接取消。`keepStaffTurn` 只进审计（它是一句意图，
 *     不是一次状态变更）
 *   · **已经开过单 → 拒绝**，让调用方去作废那张单（`ticket.void`）。
 *     那条路才知道钱和轮次该怎么退，而在这里猜一遍等于把同一个规则
 *     实现两次（宪法第 2 条），两份早晚会不一致
 *
 * 拒绝而不是猜，是因为猜错的方向是「凭空给技师记了一次没干过的活」
 * 或者「抹掉他真干过的一次」—— 两个都会被技师当场发现并投诉。
 */
registerHandler(AppointmentCancel, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AppointmentCancel.input._type>): Promise<typeof AppointmentCancel.output._type> => {
  const [appt] = await tx<{
    id: string; status: string; source: string; business_date: string;
  }[]>`
    select id, status, source, business_date::text as business_date
    from appointments
    where id = ${input.appointmentId} and location_id = ${ctx.locationId} for update`;
  if (!appt) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });

  if (appt.status === 'cancelled') {
    throw new AppError(ERROR_CODES.ALREADY_CANCELLED, {
      details: { appointmentId: appt.id },
    });
  }

  const [ticket] = await tx<{ id: string; status: string }[]>`
    select id, status from tickets
    where appointment_id = ${appt.id} and status <> 'voided' limit 1`;
  if (ticket) {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, {
      details: { reason: 'ticket_exists', ticketId: ticket.id, ticketStatus: ticket.status },
    });
  }

  // Capture service/time/staff/phone before items are marked cancelled.
  // Filtering `status <> 'cancelled'` after the update makes those joins null.
  const snapshot = await loadChangeNotifySnapshot(tx, appt.id);

  await tx`update appointments set
      status = 'cancelled',
      cancelled_at = now(),
      cancel_reason = ${input.reason},
      cancel_note = ${input.note ?? null}
    where id = ${appt.id}`;

  // item 也要跟着，否则日程表上那几格还占着 —— 而容量判断读的正是 items
  await tx`update appointment_items set status = 'cancelled'
    where appointment_id = ${appt.id} and status <> 'cancelled'`;

  // Checked-in appointments also own a queue entry; cancelling must end both.
  await tx`update walkin_queue set status = 'left', left_at = now(),
      left_reason = coalesce(left_reason, 'appointment_cancelled')
    where appointment_id = ${appt.id} and location_id = ${ctx.locationId}
      and status in ('waiting', 'called', 'seated')`;

  await notifyAppointmentChange(tx, ctx, {
    appointmentId: appt.id,
    event: 'appointment_cancelled',
    staffEvent: 'staff_cancelled',
    oldStartsAt: null,
    newStartsAt: null,
    snapshot,
  });

  audit({
    entityType: 'appointment', entityId: appt.id,
    before: { status: appt.status },
    after: {
      status: 'cancelled',
      reason: input.reason,
      keepStaffTurn: input.keepStaffTurn,
      source: appt.source,
    },
  });

  // 没有开过单 = 轮牌上没有这条预约的痕迹，所以「保留」与否不改变任何状态。
  // 如实返回调用方问的那件事有没有发生，而不是回一个好看的 true
  return { appointmentId: appt.id, turnKept: false };
});

// ─────────────────────────────────────────────────────────────────── 改期

/**
 * `appointment.reschedule` —— 把一单挪到新时间（批 2 补实现）。
 *
 * ## ⭐ 为什么这条命令的存在本身就是需求
 *
 * `docs/13` 初版拒绝自助改期，理由是「改期在公开页面上会变成
 * **取消 + 重订**两步，中间那一格可能被人订走，客人两头落空」。
 *
 * 那个顾虑成立 —— 但它成立的前提是「改期由两条命令拼出来」。
 * 这一条命令**在同一个事务里**先把 item 挪到新时间，让容量触发器
 * 在新位置上判一次；撞了就整体回滚，原单一个字节都没动。
 * 于是没有中间态：要么改成功，要么原样还在。
 *
 * ## 三条实现约束
 *
 * 1. **`update` 而不是 `delete + insert`。** 后者会换掉 item id，
 *    而 `ticket_items` / `earnings` / 审计流水都是按 id 引的。
 * 2. **整单平移时保持各 item 的相对间隔。** 一单两个项目
 *    （60 分钟按摩 + 30 分钟修脚）挪动之后仍然是前后相接，
 *    而不是两个都压到同一个新起点上。
 * 3. **已经开过单的不让改。** 有 ticket 说明人已经到店、技师已经开工，
 *    这时候「改期」是运营动作不是客人动作 —— 让前台去处理。
 */
registerHandler(AppointmentReschedule, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AppointmentReschedule.input._type>
): Promise<typeof AppointmentReschedule.output._type> => {
  await lockBookingCapacity(tx, ctx.locationId);

  const [loc] = await tx<{
    timezone: string; cutoff: string; settings: Record<string, unknown>; hours: WeeklyHours;
  }[]>`
    select timezone, business_day_cutoff::text as cutoff, settings,
           business_hours as hours
    from locations where id = ${ctx.locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const capacityCfg = (loc.settings['capacity'] ?? {}) as {
    max_concurrent_per_slot?: number | null;
    overbook?: 'warn' | 'block';
  };

  const [appt] = await tx<{ id: string; status: string; party_size: number; starts_at: string }[]>`
    select id, status, party_size, starts_at::text as starts_at from appointments
    where id = ${input.appointmentId} and location_id = ${ctx.locationId} for update`;
  if (!appt) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });
  if (appt.status === 'cancelled') {
    throw new AppError(ERROR_CODES.ALREADY_CANCELLED, { details: { appointmentId: appt.id } });
  }

  // 开过单就不是「改期」了 —— 人已经在店里，让前台处理
  const [ticket] = await tx<{ id: string; status: string }[]>`
    select id, status from tickets
    where appointment_id = ${appt.id} and status <> 'voided' limit 1`;
  if (ticket) {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, {
      details: { reason: 'ticket_exists', ticketId: ticket.id, ticketStatus: ticket.status },
    });
  }

  const itemRows = await tx<{
    id: string; membership_id: string | null; starts_at: string; ends_at: string;
  }[]>`
    select id, membership_id, starts_at::text as starts_at, ends_at::text as ends_at
    from appointment_items
    where appointment_id = ${appt.id} and status <> 'cancelled'
    order by starts_at`;
  if (itemRows.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment_items' } });
  }

  const targets = input.itemId
    ? itemRows.filter((r) => r.id === input.itemId)
    : itemRows;
  if (targets.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { itemId: input.itemId } });
  }

  /**
   * 平移量 = 新起点 − 这次要动的那批 item 里最早的那个。
   *
   * ⚠️ 用**减去锚点再加回去**而不是「都设成 newStart」：
   * 一单两个项目要保持前后相接，否则 60 分钟按摩和 30 分钟修脚
   * 会被压到同一个起点上，变成两个技师同时伺候一个人。
   */
  const newStart = new Date(input.startsAt);
  const anchor = Math.min(...targets.map((t) => parseTs(t.starts_at).getTime()));
  const deltaMs = newStart.getTime() - anchor;

  const moved = targets.map((t) => ({
    id: t.id,
    membershipId: input.membershipId === undefined ? t.membership_id : input.membershipId,
    startsAt: new Date(parseTs(t.starts_at).getTime() + deltaMs),
    endsAt: new Date(parseTs(t.ends_at).getTime() + deltaMs),
  }));

  const windowStart = new Date(Math.min(...moved.map((m) => m.startsAt.getTime())));
  const windowEnd = new Date(Math.max(...moved.map((m) => m.endsAt.getTime())));
  const businessDate = businessDateOf(windowStart, loc.timezone, loc.cutoff);

  /*
   * 营业时间闸门（0046）—— 和建单同一个函数。
   *
   * ⚠️ 这条命令没有 `source` 字段，渠道只能看 `ctx.membershipId`：
   * 官网自助改期和电话 AI 改期都是 `null`（背后没有人），前台是真实
   * membership。这不是凑合 —— 那个 null 本来就是**为了表达同一件事**
   * 才这么设计的（见 telnyx/routes.ts 里 phoneContext 的注释）。
   */
  const offHoursOverride = assertBusinessHours({
    businessDate, timezone: loc.timezone, hours: loc.hours,
    startsAt: windowStart, endsAt: windowEnd,
    policy: readOffHours(loc.settings),
    isPublic: ctx.membershipId === null,
    hasOverride: !!input.override,
    details: { appointmentId: appt.id },
  });

  /**
   * 新窗口里已经有谁。
   *
   * ⚠️ **要排除本单自己的 item** —— 不排除的话，「原地往后延 15 分钟」
   * 这种最常见的改法会和自己撞车，永远改不成。
   */
  const existingRows = await tx<{
    group_key: string; membership_id: string | null; starts_at: string; ends_at: string;
  }[]>`
    select case when a.party_size > 1 then ai.id::text else ai.appointment_id::text end as group_key,
           ai.membership_id, ai.starts_at, ai.ends_at
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    where ai.location_id = ${ctx.locationId}
      and ai.status in ('booked','in_service')
      and ai.appointment_id <> ${appt.id}
      and ai.starts_at < ${ts(windowEnd)}::timestamptz
      and ai.ends_at   > ${ts(windowStart)}::timestamptz`;
  const existing: Array<Interval & { membershipId: string | null }> = existingRows.map((e) => ({
    membershipId: e.membership_id,
    startsAt: parseTs(e.starts_at),
    endsAt: parseTs(e.ends_at),
    groupKey: e.group_key,
  }));

  const staffIds = [...new Set(moved.map((m) => m.membershipId).filter((x): x is string => !!x))];
  // ⚠️ location_id 同建单那处：跨店技师的档案不能混用
  const staffRows = staffIds.length
    ? await tx<{ membership_id: string; is_bookable: boolean; max_concurrent: number }[]>`
        select membership_id, is_bookable, max_concurrent_appointments as max_concurrent
        from staff_profiles
        where membership_id = any(${staffIds}) and location_id = ${ctx.locationId}`
    : [];
  const staffById = new Map(staffRows.map((s) => [s.membership_id, s]));

  const onDutyBookableCount = await countOnDutyBookable(tx, ctx.locationId, businessDate);

  // ── 容量：和建单走同一个纯函数（宪法第 2 条：唯一实现）──────────────────
  let overbooked = false;
  for (const m of moved) {
    const staff = m.membershipId ? staffById.get(m.membershipId) : undefined;
    if (m.membershipId && !staff) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { membershipId: m.membershipId } });
    }
    // groupKey 用本单 id：一次改多项时，同一位客人的项目之间互不冲突，
    // 对别的技师和门店层则照常计入（`existing` 已排除本单的旧时段）
    const proposed: Interval = {
      startsAt: m.startsAt, endsAt: m.endsAt,
      groupKey: appt.party_size > 1 ? `moved-item:${m.id}` : appt.id,
    };
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
        onDutyBookableCount,
        existing,
      },
    });
    existing.push({ ...proposed, membershipId: m.membershipId ?? null });
    if (issues.length === 0) continue;

    if (hasBlocking(issues)) {
      const blocking = issues.find((i) => !i.overridable)!;
      throw new AppError(ERROR_CODES.STAFF_NOT_BOOKABLE, { details: { itemId: m.id, ...blocking } });
    }
    if (capacityCfg.overbook === 'block' || !input.override) {
      const first = issues[0]!;
      throw new AppError(
        first.code === 'STAFF_OVER_CAPACITY'
          ? ERROR_CODES.STAFF_OVER_CAPACITY
          : ERROR_CODES.LOCATION_OVER_CAPACITY,
        { details: { itemId: m.id, issues } },
      );
    }
    overbooked = true;
  }

  // ── 写库 ─────────────────────────────────────────────────────────────────
  //
  // ⚠️ update 而不是 delete+insert：换掉 item id 会让 ticket_items、
  // earnings、审计流水全部指向一个不存在的行。
  //
  // 资源（房间）的硬约束由数据库触发器兜底 —— 撞了会抛 23001/23P01，
  // 整个事务回滚，原单原封不动。这正是「原子改期」那句话的兑现处。
  for (const m of moved) {
    try {
      await tx`
        update appointment_items set
          starts_at = ${ts(m.startsAt)}::timestamptz,
          ends_at   = ${ts(m.endsAt)}::timestamptz,
          membership_id = ${m.membershipId},
          resource_id = ${input.resourceId === undefined ? tx`resource_id` : input.resourceId}
        where id = ${m.id}`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code && RESOURCE_CONFLICT_CODES.has(code)) {
        throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
          details: { itemId: m.id, startsAt: m.startsAt.toISOString() },
          cause: e,
        });
      }
      throw e;
    }
  }

  // 父行的窗口要跟着重算 —— 只改 item 的话，日程表上那一条还画在旧位置
  const [span] = await tx<{ s: string; e: string }[]>`
    select min(starts_at)::text as s, max(ends_at)::text as e
    from appointment_items
    where appointment_id = ${appt.id} and status <> 'cancelled'`;
  await tx`
    update appointments set
      starts_at = ${span!.s}::timestamptz,
      ends_at   = ${span!.e}::timestamptz,
      business_date = ${businessDate}
    where id = ${appt.id}`;

  /*
   * ⭐ 通知客人和技师（批 8 收尾，补上批 3 留的口子）。
   *
   * 在此之前 AI 在电话里改期是**静默**的 —— 客人挂了电话不会收到任何
   * 确认，而 telnyx/routes.ts 的权限注释里明写了这个缺口。现在补上。
   *
   * ⚠️ `notifyEvent` **不抛错**：规则关着、模板没配、客人没留手机号
   * 都返回 0。一条改期因为「模板没配」而整个失败，是最不能接受的失败方式
   * （宪法第 13/14 条：短信永不成为阻断点）。
   */
  await notifyAppointmentChange(tx, ctx, {
    appointmentId: appt.id,
    event: 'appointment_changed',
    staffEvent: 'staff_changed',
    oldStartsAt: appt.starts_at,
    newStartsAt: newStart.toISOString(),
  });

  audit({
    entityType: 'appointment', entityId: appt.id,
    before: { startsAt: appt.starts_at },
    after: {
      startsAt: newStart.toISOString(),
      itemIds: moved.map((m) => m.id),
      wholeAppointment: !input.itemId,
      overbooked,
      offHours: offHoursOverride,
    },
  });

  return { appointmentId: appt.id, overbooked };
});

/**
 * `appointment.addItem` —— 前台在预约尚未开单时追加正式服务项目。
 *
 * 这一步不能直接调用 ticket.addItem：ticket.addItem 会创建/修改账单，
 * 而预约详情里的追加项目应该先进入 appointment_items，待之后开单时由
 * ticket.open 按预约快照整单带入。
 */
registerHandler(AppointmentAddItem, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof AppointmentAddItem.input._type>
): Promise<typeof AppointmentAddItem.output._type> => {
  await lockBookingCapacity(tx, ctx.locationId);

  const [appt] = await tx<{ id: string; status: string }[]>`
    select id, status from appointments
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;
  if (!appt) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });
  if (appt.status === 'cancelled' || appt.status === 'completed') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'appointment_not_editable', status: appt.status },
    });
  }

  const [ticket] = await tx<{ id: string }[]>`
    select id from tickets where appointment_id = ${appt.id} and status <> 'voided' limit 1`;
  if (ticket) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'appointment_ticket_exists', ticketId: ticket.id },
    });
  }

  const [service] = await tx<{ id: string; duration_min: number; base_price_cents: number }[]>`
    select id, duration_min, base_price_cents from services
    where id = ${input.serviceId} and location_id = ${ctx.locationId} and active = true`;
  if (!service) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: input.serviceId } });

  const [loc] = await tx<{ timezone: string; cutoff: string; settings: Record<string, unknown>; hours: WeeklyHours }[]>`
    select timezone, business_day_cutoff::text as cutoff, settings, business_hours as hours
    from locations where id = ${ctx.locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const oldItems = await tx<{ ends_at: string }[]>`
    select ends_at::text as ends_at from appointment_items
    where appointment_id = ${appt.id} and status <> 'cancelled' order by ends_at`;
  const latestEnd = oldItems.reduce((latest, item) => Math.max(latest, parseTs(item.ends_at).getTime()), 0);
  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date(latestEnd || Date.now());
  const durationMin = input.durationMin ?? service.duration_min;
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const businessDate = businessDateOf(startsAt, loc.timezone, loc.cutoff);
  const offHoursOverride = assertBusinessHours({
    businessDate, timezone: loc.timezone, hours: loc.hours,
    startsAt, endsAt, policy: readOffHours(loc.settings), isPublic: false,
    hasOverride: !!input.override, details: { appointmentId: appt.id },
  });

  if (input.membershipId) {
    const [member] = await tx<{ membership_id: string; max_concurrent: number; is_bookable: boolean }[]>`
      select membership_id, max_concurrent_appointments as max_concurrent, is_bookable
      from staff_profiles
      where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}`;
    if (!member || !member.is_bookable) {
      throw new AppError(ERROR_CODES.STAFF_NOT_BOOKABLE, { details: { membershipId: input.membershipId } });
    }
  }
  if (input.resourceId) {
    const [resource] = await tx<{ id: string }[]>`
      select id from resources where id = ${input.resourceId} and location_id = ${ctx.locationId}`;
    if (!resource) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'resource' } });
  }

  const capacity = (loc.settings['capacity'] ?? {}) as {
    max_concurrent_per_slot?: number | null; overbook?: 'warn' | 'block';
  };
  const otherRows = await tx<{
    group_key: string; membership_id: string | null; starts_at: string; ends_at: string;
  }[]>`
    select case when a.party_size > 1 then ai.id::text else ai.appointment_id::text end as group_key,
           ai.membership_id, ai.starts_at::text as starts_at, ai.ends_at::text as ends_at
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    where ai.location_id = ${ctx.locationId} and ai.appointment_id <> ${appt.id}
      and ai.status in ('booked','in_service')
      and ai.starts_at < ${ts(endsAt)}::timestamptz and ai.ends_at > ${ts(startsAt)}::timestamptz`;
  const existing = otherRows.map((row) => ({
    membershipId: row.membership_id, startsAt: parseTs(row.starts_at), endsAt: parseTs(row.ends_at),
    groupKey: row.group_key,
  }));
  const [staffRow] = input.membershipId
    ? await tx<{ membership_id: string; max_concurrent: number; is_bookable: boolean }[]>`
        select membership_id, max_concurrent_appointments as max_concurrent, is_bookable
        from staff_profiles
        where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}`
    : [];
  const onDutyBookableCount = await countOnDutyBookable(
    tx, ctx.locationId, businessDateOf(startsAt, loc.timezone, loc.cutoff),
  );
  const issues = checkCapacity({
    // 本单自己的项目已被 `appointment_id <> appt.id` 排除，groupKey 在这里
    // 只是把语义写明：加项加在同一位客人身上，不产生新的占位
    proposed: { startsAt, endsAt, groupKey: appt.id },
    staff: staffRow ? {
      membershipId: staffRow.membership_id, maxConcurrent: staffRow.max_concurrent,
      isBookable: staffRow.is_bookable,
      existing: existing.filter((row) => row.membershipId === staffRow.membership_id),
    } : null,
    location: {
      maxConcurrentPerSlot: capacity.max_concurrent_per_slot ?? null,
      onDutyBookableCount, existing,
    },
  });
  if (hasBlocking(issues)) {
    throw new AppError(ERROR_CODES.STAFF_NOT_BOOKABLE, { details: { issues } });
  }
  const overbooked = issues.length > 0;
  if (overbooked && (capacity.overbook === 'block' || !input.override)) {
    const first = issues[0]!;
    throw new AppError(
      first.code === 'STAFF_OVER_CAPACITY' ? ERROR_CODES.STAFF_OVER_CAPACITY : ERROR_CODES.LOCATION_OVER_CAPACITY,
      { details: { issues } },
    );
  }

  const [seq] = await tx<{ n: number }[]>`
    select coalesce(max(seq), -1)::int as n from appointment_items where appointment_id = ${appt.id}`;
  let item: { id: string } | undefined;
  try {
    [item] = await tx<{ id: string }[]>`
      insert into appointment_items
        (org_id, location_id, appointment_id, service_id, addon_ids, membership_id,
         is_request, resource_id, starts_at, ends_at, price_cents_snapshot,
         duration_min, seq, overbooked, overbook_reason, overbook_note, details)
      values (${ctx.orgId}, ${ctx.locationId}, ${appt.id}, ${service.id}, '{}',
              ${input.membershipId}, ${input.isRequest}, ${input.resourceId ?? null},
              ${ts(startsAt)}::timestamptz, ${ts(endsAt)}::timestamptz,
              ${service.base_price_cents}, ${durationMin}, ${(seq?.n ?? -1) + 1},
              ${overbooked}, ${overbooked ? input.override?.reason ?? null : null},
              ${overbooked ? input.override?.note ?? null : null}, ${jsonb({})}::jsonb)
      returning id`;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && RESOURCE_CONFLICT_CODES.has(code)) {
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        details: { resourceId: input.resourceId, startsAt: startsAt.toISOString() }, cause: error,
      });
    }
    throw error;
  }

  const [span] = await tx<{ s: string; e: string }[]>`
    select min(starts_at)::text as s, max(ends_at)::text as e
    from appointment_items where appointment_id = ${appt.id} and status <> 'cancelled'`;
  await tx`update appointments set starts_at = ${span!.s}::timestamptz,
    ends_at = ${span!.e}::timestamptz, business_date = ${businessDate}
    where id = ${appt.id}`;
  audit({ entityType: 'appointment', entityId: appt.id, after: {
    addedItemId: item!.id, serviceId: service.id, membershipId: input.membershipId,
    overbooked, offHours: offHoursOverride,
  } });
  emit({ type: 'appointment.changed', entityId: appt.id, businessDate });
  return { appointmentId: appt.id, itemId: item!.id, businessDate, overbooked };
});

/**
 * 改期 / 取消之后通知客人与技师（批 8 收尾）。
 *
 * ⚠️ **两条都发**：客人要知道自己的单动了，技师要知道自己的班动了。
 * 只发客人的话，技师会按旧时间来上班；只发技师的话，客人会按旧时间来。
 *
 * ⚠️ 整个函数**不抛错**。这是有意的 —— 通知失败绝不该让一条已经
 * 生效的改期回滚（那会变成「客人以为改好了，其实没改」，比不通知糟得多）。
 */
type ChangeNotifySnapshot = {
  email: string | null; phone: string | null; customer_name: unknown;
  shop_name: unknown; timezone: string; slug: string;
  service_name: unknown; staff_name: unknown; staff_phone: string | null;
  starts_at: string;
  manage_token_digest: string | null;
  manage_token_wrapped: Buffer | Uint8Array | null;
  /** 这条预约当初是从哪条路进系统的。决定改期/取消要不要通知顾客 */
  source: string;
};

async function loadChangeNotifySnapshot(
  tx: HandlerArgs<unknown>['tx'],
  appointmentId: string,
): Promise<ChangeNotifySnapshot | null> {
  const [row] = await tx<ChangeNotifySnapshot[]>`
    select a.source,
           c.email, c.phone_e164 as phone, c.display_name as customer_name,
           l.name as shop_name, l.timezone, l.slug,
           s.name as service_name, sp.display_name as staff_name,
           u.phone as staff_phone,
           ai.starts_at::text as starts_at,
           a.manage_token_digest, a.manage_token_wrapped
    from appointments a
    join locations l on l.id = a.location_id
    left join appointment_items ai on ai.appointment_id = a.id
    left join customers c on c.id = a.customer_id
    left join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join memberships m on m.id = ai.membership_id
    left join users u on u.id = m.user_id
    where a.id = ${appointmentId}
    order by ai.seq
    limit 1`;
  return row ?? null;
}

async function notifyAppointmentChange(
  tx: HandlerArgs<unknown>['tx'],
  ctx: HandlerArgs<unknown>['ctx'],
  args: {
    appointmentId: string;
    event: 'appointment_changed' | 'appointment_cancelled';
    staffEvent: 'staff_changed' | 'staff_cancelled';
    oldStartsAt: string | null;
    newStartsAt: string | null;
    snapshot?: ChangeNotifySnapshot | null;
  },
): Promise<void> {
  const row = args.snapshot ?? await loadChangeNotifySnapshot(tx, args.appointmentId);
  if (!row) return;

  const [line] = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where location_id = ${ctx.locationId} and purpose = 'main' and active limit 1`;

  /*
   * ⚠️ 模板变量**全部按英语取值**，且时间用短信格式化函数。
   *
   * 同一组变量会同时喂给邮件与短信两个渠道，因此其中任何一个非 GSM-7 字符
   * 都会使整条短信从 GSM-7 退化为 UCS-2（每段 70 字符，计费翻倍，
   * `sms/segments.ts`）。此前的实现有两个来源会引入中文：
   *
   *   · `formatWhen()` 的 locale 缺省为 `zh-CN`，生成「9月1日 周一 下午2:30」；
   *   · `pickText(..., ctx.locale, ...)` 跟随**当前操作员**的界面语言 ——
   *     前台把界面切成中文，顾客收到的短信随之变成中文。
   *
   * 两者均与收件人无关，故一律锁定英语。
   */
  const when = formatWhenSms(
    new Date(args.newStartsAt ?? row.starts_at).toISOString(), row.timezone);
  const manageUrl = guestManageLink({
    shopSlug: row.slug,
    wrapped: row.manage_token_wrapped,
    digest: row.manage_token_digest,
  });
  const vars = {
    customer_name: pickText(row.customer_name, 'en', ''),
    shop_name: pickText(row.shop_name, 'en', ''),
    service_name: pickText(row.service_name, 'en', ''),
    staff_name: row.staff_name ? pickText(row.staff_name, 'en', '') : '',
    when,
    old_when: args.oldStartsAt
      ? formatWhenSms(new Date(args.oldStartsAt).toISOString(), row.timezone) : '',
    shop_phone: line?.e164 ?? '',
    manage_url: manageUrlVar(manageUrl),
  };

  /*
   * ⚠️ 模板语言锁定 `'en'`，不使用 `customers.locale`。
   *
   * 顾客侧的邮件与短信恒为英语（`email/render.ts` 文件头）。按顾客档案
   * 选模板时，只要店主配过一份中文模板，`locale = 'zh-Hans'` 的顾客收到的
   * 就是中文 —— 邮件与短信皆然。
   */
  /*
   * ⚠️ **顾客侧只通知「客人自己订的」那些单**（判据同建单：`PUBLIC_SOURCES`）。
   *
   * 前台代订、到店散客、副驾录入的单，客人从没勾过任何接收同意 —— 建单时
   * 我们没发确认信，改期/取消时更不该突然冒出来一条短信。那些号码多半来自
   * 历史档案，往上面发变更通知同样会招来投诉，把整个发送域拖进垃圾名单，
   * 连带把官网自助和 AI 语音那两条**该发的**一起送进垃圾箱。
   *
   * 这类单要通知客人，走前台显式点击的那条路，由人决定发不发。
   *
   * ⚠️ **技师侧不受此限**（见下方那次 notifyEvent）：排班变了技师必须知道，
   * 那是内部通知，和顾客的接收同意是两码事。
   */
  if (PUBLIC_SOURCES.has(row.source)) {
    await notifyEvent(tx, ctx, {
      event: args.event,
      entityType: 'appointment', entityId: args.appointmentId,
      vars, toEmail: row.email, toPhone: row.phone,
      locale: 'en',
    });
  }

  /*
   * 技师侧走**另一个 entity_type**（`appointment_staff`）。
   *
   * outbox 的幂等键是 (entity_type, entity_id, kind)，两条都用
   * `appointment` 的话，后写的那条会被 `on conflict do nothing` 吞掉 ——
   * 表现是「客人收到了，技师没收到」，而日志里看不出任何异常。
   */
  /*
   * ⚠️ 技师侧同样锁 `'en'`。
   *
   * 此前传的是 `row.locale`，即**顾客**的语言 —— 技师因此按顾客的语言
   * 收到通知。技师侧仅走短信渠道，而短信恒为英语；待日后按渠道分别渲染
   * 变量之后，技师邮件可再改为跟随其本人的界面语言。
   */
  await notifyEvent(tx, ctx, {
    event: args.staffEvent,
    entityType: 'appointment_staff', entityId: args.appointmentId,
    vars, toEmail: null, toPhone: row.staff_phone,
    locale: 'en',
  });
}


// ─────────────────────────────────────────── 服务前提示 / 客户关联（AUD-04）

/**
 * 服务前提示。
 *
 * 从 `POST /v1/desk/appointments/:id/service-brief` 的裸 SQL 搬过来。
 * 搬过来之后白拿三样东西，一样都不是可选的：
 * 审计（谁改的）、幂等（网络差的门店重试安全）、欠费冻结（总线统一管）。
 */
registerHandler(AppointmentSaveServiceBrief, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AppointmentSaveServiceBrief.input._type>) => {
  const note = input.note.trim() || null;

  const [before] = await tx<{ notes: string | null }[]>`
    select notes from appointments
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;
  if (!before) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'appointment', id: input.appointmentId },
    });
  }

  await tx`
    update appointments set notes = ${note}
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;

  audit({
    entityType: 'appointment', entityId: input.appointmentId,
    before: { note: before.notes },
    after: { note },
  });

  return { appointmentId: input.appointmentId, note };
});

/**
 * 把预约 / 排队记录关联到客户档案。
 *
 * ⭐ **这条命令存在的主要理由是那句 `assertCustomerInOrg`**（AUD-05）。
 *
 * `appointments.customer_id` 的外键是 `references customers(id)`，
 * 没有 org 谓词；而 Postgres 的外键检查以表 owner 身份执行，**不受 RLS 约束**。
 * 于是「写一个别家门店的 customer uuid」在数据库看来完全合法。
 * 写进去之后所有读路径都被 RLS 过滤成 NULL —— 客人在界面上凭空消失，
 * 库里留一条跨租户引用，而且没有任何报错。
 *
 * 校验必须在**写之前**做，不能指望读的时候发现。
 */
registerHandler(AppointmentAssignCustomer, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AppointmentAssignCustomer.input._type>) => {
  const customerId = input.customerId ?? null;
  const walkInName = input.walkInName === undefined
    ? undefined
    : (input.walkInName?.trim() || null);

  if (customerId) {
    const [owned] = await tx<{ id: string }[]>`
      select id from customers
      where id = ${customerId} and org_id = ${ctx.orgId}`;
    // 找不到 = 不存在，或者属于别家。两者返回同一个错误，防枚举。
    if (!owned) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'customer', id: customerId },
      });
    }
  }

  const [appt] = await tx<{ id: string; customer_id: string | null; walk_in_name: string | null }[]>`
    select id, customer_id, walk_in_name from appointments
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;

  if (appt) {
    await tx`
      update appointments set
        customer_id = coalesce(${customerId}, customer_id),
        walk_in_name = coalesce(${walkInName ?? null}, walk_in_name)
      where id = ${appt.id} and location_id = ${ctx.locationId}`;
    if (customerId) {
      await tx`
        update walkin_queue set customer_id = ${customerId}
        where appointment_id = ${appt.id} and location_id = ${ctx.locationId}`;
    }
    audit({
      entityType: 'appointment', entityId: appt.id,
      before: { customerId: appt.customer_id, walkInName: appt.walk_in_name },
      after: { customerId: customerId ?? appt.customer_id, walkInName: walkInName ?? appt.walk_in_name },
    });
    return { appointmentId: appt.id, customerId: customerId ?? appt.customer_id };
  }

  // 不是 appointments.id 的话，再按 walkin_queue.id 试一次 ——
  // 前台那一屏的两种卡片用的是同一个「打开详情」入口
  const [wq] = await tx<{
    id: string; appointment_id: string | null; customer_id: string | null; walk_in_name: string | null;
  }[]>`
    select id, appointment_id, customer_id, walk_in_name from walkin_queue
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;
  if (!wq) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'appointment', id: input.appointmentId },
    });
  }

  if (wq.appointment_id && customerId) {
    await tx`
      update appointments set customer_id = ${customerId}
      where id = ${wq.appointment_id} and location_id = ${ctx.locationId}`;
  }
  if (customerId || walkInName !== undefined) {
    await tx`
      update walkin_queue set
        customer_id = coalesce(${customerId}, customer_id),
        walk_in_name = coalesce(${walkInName ?? null}, walk_in_name)
      where id = ${wq.id} and location_id = ${ctx.locationId}`;
  }

  audit({
    entityType: 'walkin_queue', entityId: wq.id,
    before: { customerId: wq.customer_id, walkInName: wq.walk_in_name },
    after: { customerId: customerId ?? wq.customer_id, walkInName: walkInName ?? wq.walk_in_name },
  });

  return { appointmentId: wq.id, customerId: customerId ?? wq.customer_id };
});
