/**
 * appointment.create —— Phase 0 的验收命令。
 *
 * 三层约束在这里汇合（01 §7.1）：
 *   资源  → 数据库硬约束（容量触发器），撞了翻译成人话抛出，不给覆盖
 *   技师  → packages/scheduling 的纯函数判，可带 reason 放行
 *   门店  → 同上
 */

import { createHash } from 'node:crypto';
import {
  AppointmentCreate, AppointmentAddItem, AppointmentCancel, AppointmentReschedule,
  AppointmentSaveServiceBrief, AppointmentAssignCustomer,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { renderConfirm, formatWhen } from '../email/render';
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
const PUBLIC_SOURCES = new Set(['web', 'phone_ai']);

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

registerHandler(AppointmentCreate, async ({ input, ctx, tx, audit }: HandlerArgs<Input>): Promise<Output> => {
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

  // ── 营业时间闸门（0046）────────────────────────────────────────────────────
  //
  // 在容量之前判。理由是给人看的错误要按「先大后小」来：
  // 「今天不营业」比「Amy 这个点排满了」有用得多，先报后者会让前台
  // 一路换技师换到最后才发现今天根本不开门。
  const offHoursOverride = assertBusinessHours({
    businessDate, timezone: loc.timezone, hours: loc.hours,
    startsAt: windowStart, endsAt: windowEnd,
    policy: readOffHours(loc.settings),
    isPublic: PUBLIC_SOURCES.has(input.source) || ctx.membershipId === null,
    hasOverride: !!input.override,
    details: { source: input.source },
  });

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

  // ── 官网来的单：先把「填表的那个人」落成客户 ────────────────────────────
  const customerId = input.guest?.customer
    ? await resolveGuestCustomer(tx, ctx, input.guest.customer)
    : input.customerId;

  // ── 写库 ─────────────────────────────────────────────────────────────────
  const [appt] = await tx<{ id: string }[]>`
    insert into appointments
      (org_id, location_id, customer_id, walk_in_name, business_date,
       starts_at, ends_at, source, party_size, notes, created_by, idempotency_key,
       confirmation_code, manage_token_digest, is_backfill, backfill_reason, backfill_notes)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${customerId}, ${input.walkInName ?? null},
       ${businessDate}, ${ts(windowStart)}::timestamptz, ${ts(windowEnd)}::timestamptz, ${input.source},
       ${input.partySize}, ${input.notes ?? null}, ${ctx.membershipId}, null,
       ${input.guest?.confirmationCode ?? null},
       ${input.guest ? createHash('sha256').update(input.guest.manageToken, 'utf8').digest('hex') : null},
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

  await enqueueConfirmEmail(tx, ctx, appt!.id, itemIds[0] ?? null,
    input.guest?.manageToken ?? null);
  await enqueueConfirmSms(tx, ctx, appt!.id, itemIds[0] ?? null, input.guest?.confirmationCode ?? null);

  // 审计由总线统一落库并做金额脱敏
  audit({
    entityType: 'appointment',
    entityId: appt!.id,
    after: {
      businessDate,
      source: input.source,
      itemCount: itemIds.length,
      overbooked: overbookedItemIds.length,
      // 营业时间外被前台带 reason 放行的那一单。查「谁把客人排到八点半」时用得上
      offHours: offHoursOverride,
      overrideReason: input.override?.reason ?? null,
      // ⚠️ 确认码可以留（它不授权任何事），**令牌一个字都不能进审计**
      confirmationCode: input.guest?.confirmationCode ?? null,
    },
  });

  return { appointmentId: appt!.id, itemIds, overbookedItemIds, businessDate };
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
    starts_at: string; shop_name: unknown; timezone: string;
  }[]>`
    select c.email, c.display_name as customer_name, c.phone_e164 as phone,
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
  const manageUrl = manageToken && row!.phone
    ? `${(process.env['APP_BASE_URL'] ?? 'https://desk.geniefront.com').replace(/\/+$/, '')}`
      + `/b/${appointmentId}?t=${encodeURIComponent(manageToken)}`
    : null;

  const msg = renderConfirm({
    customerName: pickText(row!.customer_name, ctx.locale, '您'),
    shopName: pickText(row!.shop_name, ctx.locale, ''),
    serviceName: pickText(row!.service_name, ctx.locale, '预约'),
    whenText: formatWhen(new Date(row!.starts_at).toISOString(), row!.timezone),
    staffName: row!.staff_name ? pickText(row!.staff_name, ctx.locale) : null,
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
  appointmentId: string, firstItemId: string | null, confirmationCode: string | null,
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
  const body = renderConfirmSms({
    shopName: row!.shop_name,
    shopSlug: row!.shop_slug,
    serviceName: pickText(row!.service_name, 'en', 'your appointment'),
    whenText: formatWhenSms(new Date(row!.starts_at).toISOString(), row!.timezone),
    confirmationCode,
    shopPhone: line?.e164 ?? null,
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

/** 邮件没配好就整条路不走 —— 没必要往 outbox 里堆永远发不出去的行 */
function input_hasCustomerEmailSupport(): boolean {
  return Boolean(process.env['RESEND_API_KEY'] && process.env['FROM_EMAIL']);
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
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;
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

  await tx`update appointments set
      status = 'cancelled',
      cancelled_at = now(),
      cancel_reason = ${input.reason},
      cancel_note = ${input.note ?? null}
    where id = ${appt.id}`;

  // item 也要跟着，否则日程表上那几格还占着 —— 而容量判断读的正是 items
  await tx`update appointment_items set status = 'cancelled'
    where appointment_id = ${appt.id} and status <> 'cancelled'`;

  await notifyAppointmentChange(tx, ctx, {
    appointmentId: appt.id,
    event: 'appointment_cancelled',
    staffEvent: 'staff_cancelled',
    oldStartsAt: null,
    newStartsAt: null,
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

  const [appt] = await tx<{ id: string; status: string; starts_at: string }[]>`
    select id, status, starts_at::text as starts_at from appointments
    where id = ${input.appointmentId} and location_id = ${ctx.locationId}`;
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
  const existingRows = await tx<{ membership_id: string | null; starts_at: string; ends_at: string }[]>`
    select ai.membership_id, ai.starts_at, ai.ends_at from appointment_items ai
    where ai.location_id = ${ctx.locationId}
      and ai.status in ('booked','in_service')
      and ai.appointment_id <> ${appt.id}
      and ai.starts_at < ${ts(windowEnd)}::timestamptz
      and ai.ends_at   > ${ts(windowStart)}::timestamptz`;
  const existing = existingRows.map((e) => ({
    membershipId: e.membership_id,
    startsAt: parseTs(e.starts_at),
    endsAt: parseTs(e.ends_at),
  }));

  const staffIds = [...new Set(moved.map((m) => m.membershipId).filter((x): x is string => !!x))];
  const staffRows = staffIds.length
    ? await tx<{ membership_id: string; is_bookable: boolean; max_concurrent: number }[]>`
        select membership_id, is_bookable, max_concurrent_appointments as max_concurrent
        from staff_profiles where membership_id = any(${staffIds})`
    : [];
  const staffById = new Map(staffRows.map((s) => [s.membership_id, s]));

  const [onDuty] = await tx<{ n: number }[]>`
    select count(*)::int as n from staff_profiles
    where location_id = ${ctx.locationId} and is_bookable = true`;

  // ── 容量：和建单走同一个纯函数（宪法第 2 条：唯一实现）──────────────────
  let overbooked = false;
  for (const m of moved) {
    const staff = m.membershipId ? staffById.get(m.membershipId) : undefined;
    if (m.membershipId && !staff) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { membershipId: m.membershipId } });
    }
    const proposed: Interval = { startsAt: m.startsAt, endsAt: m.endsAt };
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
  const otherRows = await tx<{ membership_id: string | null; starts_at: string; ends_at: string }[]>`
    select membership_id, starts_at::text as starts_at, ends_at::text as ends_at
    from appointment_items
    where location_id = ${ctx.locationId} and appointment_id <> ${appt.id}
      and status in ('booked','in_service')
      and starts_at < ${ts(endsAt)}::timestamptz and ends_at > ${ts(startsAt)}::timestamptz`;
  const existing = otherRows.map((row) => ({
    membershipId: row.membership_id, startsAt: parseTs(row.starts_at), endsAt: parseTs(row.ends_at),
  }));
  const [staffRow] = input.membershipId
    ? await tx<{ membership_id: string; max_concurrent: number; is_bookable: boolean }[]>`
        select membership_id, max_concurrent_appointments as max_concurrent, is_bookable
        from staff_profiles where membership_id = ${input.membershipId}`
    : [];
  const [onDuty] = await tx<{ n: number }[]>`
    select count(*)::int as n from staff_profiles
    where location_id = ${ctx.locationId} and is_bookable = true`;
  const issues = checkCapacity({
    proposed: { startsAt, endsAt },
    staff: staffRow ? {
      membershipId: staffRow.membership_id, maxConcurrent: staffRow.max_concurrent,
      isBookable: staffRow.is_bookable,
      existing: existing.filter((row) => row.membershipId === staffRow.membership_id),
    } : null,
    location: {
      maxConcurrentPerSlot: capacity.max_concurrent_per_slot ?? null,
      onDutyBookableCount: onDuty?.n ?? 0, existing,
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
async function notifyAppointmentChange(
  tx: HandlerArgs<unknown>['tx'],
  ctx: HandlerArgs<unknown>['ctx'],
  args: {
    appointmentId: string;
    event: 'appointment_changed' | 'appointment_cancelled';
    staffEvent: 'staff_changed' | 'staff_cancelled';
    oldStartsAt: string | null;
    newStartsAt: string | null;
  },
): Promise<void> {
  const [row] = await tx<{
    email: string | null; phone: string | null; customer_name: unknown;
    locale: string | null; shop_name: unknown; timezone: string;
    service_name: unknown; staff_name: unknown; staff_phone: string | null;
    starts_at: string;
  }[]>`
    select c.email, c.phone_e164 as phone, c.display_name as customer_name, c.locale,
           l.name as shop_name, l.timezone,
           s.name as service_name, sp.display_name as staff_name,
           u.phone as staff_phone,
           ai.starts_at::text as starts_at
    from appointments a
    join locations l on l.id = a.location_id
    left join appointment_items ai on ai.appointment_id = a.id and ai.status <> 'cancelled'
    left join customers c on c.id = a.customer_id
    left join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join memberships m on m.id = ai.membership_id
    left join users u on u.id = m.user_id
    where a.id = ${args.appointmentId}
    limit 1`;
  if (!row) return;

  const [line] = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where location_id = ${ctx.locationId} and purpose = 'main' and active limit 1`;

  const when = formatWhen(
    new Date(args.newStartsAt ?? row.starts_at).toISOString(), row.timezone);
  const vars = {
    customer_name: pickText(row.customer_name, ctx.locale, ''),
    shop_name: pickText(row.shop_name, ctx.locale, ''),
    service_name: pickText(row.service_name, ctx.locale, ''),
    staff_name: row.staff_name ? pickText(row.staff_name, ctx.locale, '') : '',
    when,
    old_when: args.oldStartsAt
      ? formatWhen(new Date(args.oldStartsAt).toISOString(), row.timezone) : '',
    shop_phone: line?.e164 ?? '',
  };

  await notifyEvent(tx, ctx, {
    event: args.event,
    entityType: 'appointment', entityId: args.appointmentId,
    vars, toEmail: row.email, toPhone: row.phone,
    locale: row.locale,
  });

  /*
   * 技师侧走**另一个 entity_type**（`appointment_staff`）。
   *
   * outbox 的幂等键是 (entity_type, entity_id, kind)，两条都用
   * `appointment` 的话，后写的那条会被 `on conflict do nothing` 吞掉 ——
   * 表现是「客人收到了，技师没收到」，而日志里看不出任何异常。
   */
  await notifyEvent(tx, ctx, {
    event: args.staffEvent,
    entityType: 'appointment_staff', entityId: args.appointmentId,
    vars, toEmail: null, toPhone: row.staff_phone,
    locale: row.locale,
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
