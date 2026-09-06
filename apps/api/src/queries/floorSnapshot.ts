/**
 * 现场快照的取数（05 §6.1）
 *
 * 这个文件**只负责查**，格式化在 `@gf/ai` 的 `formatFloorSnapshot`
 *（纯函数、有测试）。分开是因为「快照长什么样」这件事会反复调，
 * 而每调一次都要能被测 —— 混在 SQL 里就只能靠眼看。
 *
 * ⚠️ **这一段只查「此刻」。** 服务目录、员工花名册、房间清单在
 * `storeProfile.ts`（进缓存前缀），预约日历在 `bookingCalendar.ts`。
 * 三段各查各的，不要往这里加不随分钟变化的东西。
 *
 * ⚠️ **快照不脱敏**（决策 23）：客人真实姓名照给。前台需要一眼认人，
 * 脱敏会拖慢高频操作。技师端那边的手机号脱敏（决策 16）是防挖客，两回事。
 *
 * ⚠️ **健康表内容永远不进快照**（05 §10.5）。要看健康表得有
 * `customer.view_health_form`，而且是另外一条明确的路径。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import { pickText, type CommandContext } from '@gf/contracts';
import { computeStanding, FULL_TURN } from '@gf/rotation';
import { businessDateOf } from '@gf/scheduling';
import type { FloorSnapshot } from '@gf/ai';
import { loadRotation, currentBusinessDate, stripRank } from '../handlers/rotation';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** 门店墙上时间的 HH:MM */
function wallClock(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function wallWeekday(d: Date, timezone: string): string {
  const idx = new Date(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)).getDay();
  return WEEKDAYS[idx] ?? 'Mon';
}

export async function loadFloorSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<FloorSnapshot> {
  const now = new Date();

  const [loc] = await tx<{ name: unknown; tz: string; cutoff: string }[]>`
    select name, timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${ctx.locationId}`;
  const tz = loc?.tz ?? 'America/New_York';
  const businessDate = businessDateOf(now, tz, loc?.cutoff ?? '04:00');

  // ── 轮牌：顺序是算出来的，不是存出来的（决策 12）─────────────────────
  //
  // 复用 desk 那一屏用的同一段计算。两边看到的顺序必须一致 ——
  // 副驾说「轮到 Kim」而轮牌板上写着 Amy，前台会立刻不信任它
  const { policy } = await currentBusinessDate(tx, ctx.locationId);
  const { participants, events } = await loadRotation(tx, ctx, businessDate);
  const standing = computeStanding(participants, events, policy);

  // ── 在做的单 ─────────────────────────────────────────────────────────
  const working = await tx<{
    staff_name: unknown; customer_name: string | null; walk_in_name: string | null;
    service_name: unknown; ends_at: string | Date; overbooked: boolean;
    membership_id: string;
  }[]>`
    select sp.display_name as staff_name, c.display_name as customer_name,
           a.walk_in_name, s.name as service_name, ai.ends_at, ai.overbooked,
           ai.membership_id
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join services s on s.id = ai.service_id
    join staff_profiles sp on sp.membership_id = ai.membership_id
    left join customers c on c.id = a.customer_id
    where ai.location_id = ${ctx.locationId}
      and a.business_date = ${businessDate}
      and ai.status = 'in_progress'
    order by ai.ends_at`;

  // ── 接下来的预约 ─────────────────────────────────────────────────────
  //
  // 只要「现在之后」的。已经过去的时段对前台的下一个动作没有帮助，
  // 而它们会把快照撑大
  const upcoming = await tx<{
    starts_at: string | Date; customer_name: string | null; walk_in_name: string | null;
    service_name: unknown; duration_min: number; staff_name: unknown;
    is_request: boolean; details: unknown;
  }[]>`
    select ai.starts_at, c.display_name as customer_name, a.walk_in_name,
           s.name as service_name, ai.duration_min, sp.display_name as staff_name,
           ai.is_request, ai.details
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join customers c on c.id = a.customer_id
    where ai.location_id = ${ctx.locationId}
      and a.business_date = ${businessDate}
      and ai.status in ('booked', 'confirmed', 'arrived')
      and ai.starts_at >= now()
    order by ai.starts_at
    limit 20`;

  // ── 等位队列 ─────────────────────────────────────────────────────────
  const queue = await tx<{
    ticket_number: number; customer_name: string | null; walk_in_name: string | null;
    joined_at: string | Date; quoted_wait_min: number | null; service_name: unknown;
  }[]>`
    select q.ticket_number, c.display_name as customer_name, q.walk_in_name,
           q.joined_at, q.quoted_wait_min, s.name as service_name
    from walkin_queue q
    left join customers c on c.id = q.customer_id
    left join services s on s.id = q.requested_service_id
    where q.location_id = ${ctx.locationId} and q.business_date = ${businessDate}
      and q.status = 'waiting'
    order by q.ticket_number`;

  // ── 房间 ─────────────────────────────────────────────────────────────
  //
  // 决策 25：一间房可以有 capacity。所以「空几间」算的是**还能放下人的房间数**，
  // 不是「没人的房间数」—— 足疗房排 6 张躺椅，坐了 2 个人它照样能接客
  //
  // ⚠️ 列别名刻意叫 `room_count` / `busy_rooms`，不用那几个钱味儿的词
  //（amount / price / tip / 以及那个表示合计的词）：`scripts/lint-guards.sh`
  // 见到它们被 Number() 包着就会按「金额走了浮点解析」拦下（宪法第 4 条）。
  // 那条规则宁可误伤也不放过是对的 —— 房间数改个名字比给它开例外便宜。
  const [rooms] = await tx<{
    room_count: string; busy_rooms: string; unavailable_rooms: string;
  }[]>`
    select
      (select count(*) from resources
        where location_id = ${ctx.locationId}) as room_count,
      (select count(*) from resources
        where location_id = ${ctx.locationId}
          and status in ('maintenance', 'cleaning', 'cleaning_required')) as unavailable_rooms,
      (select count(distinct ai.resource_id) from appointment_items ai
         join appointments a on a.id = ai.appointment_id
        where ai.location_id = ${ctx.locationId}
          and a.business_date = ${businessDate}
          and ai.status = 'in_progress' and ai.resource_id is not null) as busy_rooms`;
  const roomsTotal = Number(rooms?.room_count ?? 0);
  const roomsFree = Math.max(0, roomsTotal
    - Number(rooms?.busy_rooms ?? 0)
    - Number(rooms?.unavailable_rooms ?? 0));

  const busy = new Set(working.map((w) => w.membership_id));
  const nowMs = now.getTime();

  const turn = standing.entries.map((e) => {
    // stripRank：手动调序的备注里带着内部位次编号，对模型没用还占 token
    const note = stripRank(e.trail[0]?.note ?? null);
    return {
      name: e.name,
      turns: e.turnsBp / FULL_TURN,
      // 正在做单的人，轮牌里显示成 busy —— 「Amy 有空吗」的答案取决于这个
      state: busy.has(e.membershipId) && e.state === 'available' ? 'working' : e.state,
      ...(note ? { note } : {}),
      ...(e.owed ? { owed: true } : {}),
    };
  });

  return {
    header: {
      clock: wallClock(now, tz),
      weekday: wallWeekday(now, tz),
      shopName: pickText(loc?.name, ctx.locale),
      onFloor: standing.entries.filter((e) => e.state !== 'off').length,
      roomsFree,
      roomsTotal,
      queueWaiting: queue.length,
      queueLongestWaitMin: queue.reduce((m, q) => Math.max(
        m, Math.round((nowMs - parseTs(q.joined_at).getTime()) / 60_000)), 0),
    },

    turn,

    now: working.map((w) => ({
      staffName: pickText(w.staff_name, ctx.locale),
      customerName: w.customer_name ?? w.walk_in_name ?? '临时客人',
      serviceName: pickText(w.service_name, ctx.locale),
      endsAt: wallClock(parseTs(w.ends_at), tz),
      ...(w.overbooked ? { overbooked: true } : {}),
    })),

    next: upcoming.map((u) => ({
      startsAt: wallClock(parseTs(u.starts_at), tz),
      customerName: u.customer_name ?? u.walk_in_name ?? '临时客人',
      serviceName: pickText(u.service_name, ctx.locale),
      durationMin: u.duration_min,
      staffName: u.staff_name ? pickText(u.staff_name, ctx.locale) : null,
      ...(u.is_request ? { isRequest: true } : {}),
      ...(formatDetails(u.details) ? { details: formatDetails(u.details) } : {}),
    })),

    queue: queue.map((q) => {
      const waitedMin = Math.max(0, Math.round(
        (nowMs - parseTs(q.joined_at).getTime()) / 60_000));
      return {
        ticketNumber: q.ticket_number,
        name: q.customer_name ?? q.walk_in_name ?? '临时客人',
        waitedMin,
        // 超过估计时间十分钟以上 —— 和前台那一屏用的是同一个口径
        ...(q.quoted_wait_min !== null && waitedMin > q.quoted_wait_min + 10
          ? { overdue: true } : {}),
        ...(q.service_name ? { wants: pickText(q.service_name, ctx.locale) } : {}),
      };
    }),

    idle: standing.entries
      .filter((e) => e.state === 'available' && !busy.has(e.membershipId))
      .map((e) => e.name),
  };
}

/**
 * 落单要素压成一行。
 *
 * ⭐ 「避开腰部」「力度 4/5」这类是**漏掉就会出事**的信息 ——
 * 按摩师照着做错一次，客人下次就不来了。所以宁可多花几个 token 也要带上。
 *
 * 但只带**看得懂的标量**：嵌套对象和长文本跳过，它们既占 token
 * 又不是模型能拿来做判断的东西。
 */
function formatDetails(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined || val === '') continue;
    if (typeof val === 'object') continue;
    const s = String(val);
    if (s.length > 40) continue;
    parts.push(`${k}:${s}`);
  }
  return parts.length > 0 ? `[${parts.join(' ')}]` : '';
}
