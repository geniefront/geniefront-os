/**
 * 技师端只读快照（Phase 1c）。
 *
 * 面向的是「40–60 岁、英文不好、戴着手套、店里嘈杂」的人（宪法第 11 条），
 * 所以这一份数据的取舍和前台那份完全不同：
 *
 *   · **一次给全**：今日单 + 下一位 + 收入 + 打卡状态。门店网络差，
 *     一次往返比四次可靠得多，而技师那台手机的网通常比前台还差
 *   · **手机号默认打码**（决策 16 防挖客）—— 脱敏在**服务端**做，
 *     不是前端 CSS 遮一下。前端遮的东西 F12 一开就在那儿
 *   · **安全信息置顶**：避开部位 / 过敏 / 胶水敏感红底高亮（`02` §3.3）。
 *     戴着手套扫一眼最需要看到的就是这个
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';
import { parseTs } from '@gf/db';
import { replayPunches } from '../handlers/staff';
import { currentBusinessDate, loadRotation } from '../handlers/rotation';
import { computeStanding } from '@gf/rotation';

/**
 * 手机号脱敏：`+19175551234` → `917-***-1234`。
 *
 * ⚠️ 保留尾号是故意的：技师要能对上「上次那个尾号 1234 的客人」，
 * 但拿不到完整号码就没法私下联系。全遮会让技师端变成一个认不出人的界面，
 * 全给就等于把客户名单送出门。
 */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.length < 7) return '***';
  const area = d.slice(-10, -7);
  const last4 = d.slice(-4);
  return area ? `${area}-***-${last4}` : `***-${last4}`;
}

export interface StaffTask {
  ticketId: string;
  ticketItemId: string;
  customerName: string;
  /** 决策 16：默认打码。有 customer.view_contact 的人才看得到完整号 */
  customerPhone: string | null;
  serviceName: string;
  durationMin: number;
  /** 座位/房间 —— 戴手套扫一眼要知道去哪 */
  resourceName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** waiting | in_service | done */
  state: 'waiting' | 'in_service' | 'done';
  isRequest: boolean;
  /** ⭐ 落单要素里 to_staff = true 的项：力度、重点部位、甲型色号… */
  details: Array<{ key: string; label: string; value: string }>;
  /** ⭐ 安全提示：避开部位 / 过敏 / 胶水敏感。红底置顶 */
  alerts: string[];
  /** 客人偏好的语言，技师好知道该说什么话 */
  customerLocale: string | null;
  note: string | null;
  serviceNotes: Array<{
    authorMembershipId: string;
    visibility: 'management' | 'assigned_staff';
    content: string;
    containsSensitiveData: boolean;
    updatedAt: string;
  }>;
  tip: {
    cashCents: number;
    cardCents: number;
    directCashCents: number;
    status: 'awaiting_checkout' | 'no_tip' | 'received_direct' | 'awaiting_payout' | 'settled';
    editable: boolean;
  };
}

export interface StaffToday {
  businessDate: string;
  membershipId: string;
  name: string;
  /** 现在正在做的那一条（没有就是 null） */
  current: StaffTask | null;
  /** ⭐ 下一位：翻转大卡片显示的就是它 */
  next: StaffTask | null;
  tasks: StaffTask[];
  /** 今天做完几单 */
  doneCount: number;
  onDuty: boolean;
  workedMinutes: number;
  /** 轮牌上的位置，技师最关心「我什么时候轮到」 */
  rotation: { position: number | null; isNextUp: boolean; onBreak: boolean };
  earnings: {
    serviceRevenueCents: number;
    commissionCents: number;
    tipCashCents: number;
    tipCardCents: number;
    payCents: number;
    /** 今晚要拿到手的现金 */
    cashTipOwedCents: number;
  };
}

export interface TaskRow {
  ticket_id: string;
  item_id: string;
  customer_name: string | null;
  walk_in_name: string | null;
  phone: string | null;
  customer_locale: string | null;
  service_name: string;
  duration_min: number;
  started_at: string | null;
  finished_at: string | null;
  resource_name: string | null;
  is_request: boolean;
  details: Record<string, unknown> | null;
  prefs: Record<string, unknown> | null;
  cust_notes: string | null;
  allergies: Record<string, unknown> | null;
  service_notes?: unknown;
  ticket_status: string;
  tip_cash: number;
  tip_card: number;
  direct_cash: number;
  payout_settled: boolean;
}

/** 落单要素目录：key → 给技师看的标签 + 是否显示 */
async function loadOptionDefs(
  tx: postgres.TransactionSql, ctx: CommandContext,
): Promise<Map<string, { label: string; toStaff: boolean }>> {
  const rows = await tx<{ key: string; label: unknown; to_staff: boolean }[]>`
    select key, label, to_staff from service_option_defs
    where location_id = ${ctx.locationId} and active = true`;
  return new Map(rows.map((r) => [r.key, {
    label: pickText(r.label, ctx.locale, r.key), toStaff: r.to_staff,
  }]));
}

/**
 * 一行任务 → 技师端看到的那张卡。
 *
 * ⚠️ 导出只是为了让它能被单独测（`staff.test.ts` 里的「床边看到什么」那一组）——
 * 这一层决定的是「技师在床边先看到哪一句」，而那件事值得钉住。
 */
export function buildTask(
  r: TaskRow,
  defs: Map<string, { label: string; toStaff: boolean }>,
  canSeeContact: boolean,
): StaffTask {
  const details: StaffTask['details'] = [];
  const alerts: string[] = [];

  for (const [key, raw] of Object.entries(r.details ?? {})) {
    const def = defs.get(key);
    // 目录里没有的 key 也显示：宁可多显示一个看不懂的，也别把技师
    // 需要知道的东西悄悄吞掉（例如刚加的新要素还没同步到目录）
    if (def && !def.toStaff) continue;
    const value = Array.isArray(raw) ? raw.join('、') : String(raw ?? '');
    if (!value) continue;
    // ⭐ 避开部位单独提到 alerts 里红底置顶（02 §3.3）
    if (key === 'avoid_areas' || key.includes('allerg') || key.includes('sensitiv')) {
      alerts.push(`${def?.label ?? key}：${value}`);
    } else {
      details.push({ key, label: def?.label ?? key, value });
    }
  }

  // 客人长期档案里的过敏史优先级最高
  for (const [k, v] of Object.entries(r.allergies ?? {})) {
    const value = Array.isArray(v) ? v.join('、') : String(v ?? '');
    if (value) alerts.unshift(`过敏 ${k}：${value}`);
  }
  const prefAvoid = (r.prefs ?? {})['avoid_areas'];
  if (Array.isArray(prefAvoid) && prefAvoid.length > 0) {
    alerts.unshift(`长期避开：${prefAvoid.join('、')}`);
  }

  /**
   * ⭐ 「有禁忌，见前台」（`02` §3.1 那张表的最后一列）。
   *
   * 这个布尔由客人交健康表时回填（`handlers/kiosk.ts` 的 `syncToProfile`），
   * 而**技师这一端只看得到这一句，看不到明细** —— 「怀孕 28 周」「血栓史」
   * 留在加密的 `form_submissions` 里，要 `customer.view_health_form` 才打得开，
   * 而且打开一次留一条痕（`docs/15` §2）。
   *
   * ⚠️ 排在最前面：技师在床边先看到的应该是「这位有事，去问一句」，
   * 而不是排在三条偏好后面的第四行。
   */
  if ((r.prefs ?? {})['health_flag'] === true) {
    alerts.unshift('⚠ 健康表里有禁忌 —— 开始之前问一下前台');
  }

  return {
    ticketId: r.ticket_id,
    ticketItemId: r.item_id,
    customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
    customerPhone: canSeeContact ? r.phone : maskPhone(r.phone),
    serviceName: r.service_name,
    durationMin: r.duration_min,
    resourceName: r.resource_name,
    startedAt: r.started_at ? parseTs(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? parseTs(r.finished_at).toISOString() : null,
    state: r.finished_at ? 'done' : r.started_at ? 'in_service' : 'waiting',
    isRequest: r.is_request,
    details,
    alerts,
    customerLocale: r.customer_locale,
    note: r.cust_notes,
    serviceNotes: Array.isArray(r.service_notes)
      ? r.service_notes.filter((note): note is StaffTask['serviceNotes'][number] => {
        if (!note || typeof note !== 'object') return false;
        const value = note as Record<string, unknown>;
        return typeof value.authorMembershipId === 'string'
          && (value.visibility === 'management' || value.visibility === 'assigned_staff')
          && typeof value.content === 'string'
          && typeof value.containsSensitiveData === 'boolean'
          && typeof value.updatedAt === 'string';
      })
      : [],
    tip: {
      cashCents: r.tip_cash,
      cardCents: r.tip_card,
      directCashCents: r.direct_cash,
      status: r.ticket_status !== 'closed' && r.direct_cash === 0
        ? 'awaiting_checkout'
        : r.tip_cash === 0 && r.tip_card === 0
          ? 'no_tip'
          : r.tip_cash === r.direct_cash && r.direct_cash > 0 && r.tip_card === 0
            ? 'received_direct'
            : r.tip_cash - r.direct_cash > 0 && !r.payout_settled
              ? 'awaiting_payout'
              : 'settled',
      editable: r.finished_at !== null && r.ticket_status !== 'voided',
    },
  };
}

export async function loadStaffToday(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  businessDate: string,
  membershipId: string,
): Promise<StaffToday> {
  const canSeeContact = ctx.permissions.has('customer.view_contact');
  const defs = await loadOptionDefs(tx, ctx);

  const [me] = await tx<{ name: unknown }[]>`
    select display_name as name from staff_profiles where membership_id = ${membershipId}`;

  const rows = await tx<TaskRow[]>`
    select t.id as ticket_id, ti.id as item_id,
           c.display_name as customer_name, t.walk_in_name,
           c.phone_e164 as phone, c.locale as customer_locale, c.notes as cust_notes,
           ti.name_snapshot as service_name, ti.duration_min,
           ti.started_at, ti.finished_at, ti.details,
           ai.is_request, coalesce(item_resource.name, appointment_resource.name) as resource_name,
           cp.profile as prefs, cp.allergies, t.status as ticket_status,
           coalesce(tips.tip_cash, 0)::int as tip_cash,
           coalesce(tips.tip_card, 0)::int as tip_card,
           coalesce(tips.direct_cash, 0)::int as direct_cash,
           coalesce(payout.acknowledged and payout.paid_cents >= payout.owed_cents, false) as payout_settled,
           coalesce(notes.value, '[]'::jsonb) as service_notes
    from ticket_items ti
    join tickets t on t.id = ti.ticket_id
    join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join customers c on c.id = t.customer_id
    left join customer_preferences cp on cp.customer_id = c.id
    left join appointment_items ai on ai.appointment_id = t.appointment_id
                                  and ai.membership_id = tis.membership_id
    left join resources item_resource on item_resource.id = ti.resource_id
    left join resources appointment_resource on appointment_resource.id = ai.resource_id
    left join lateral (
      select
        coalesce(sum(amount_cents) filter (where kind = 'tip_cash'), 0)::int as tip_cash,
        coalesce(sum(amount_cents) filter (where kind = 'tip_card'), 0)::int as tip_card,
        coalesce(sum(amount_cents) filter (
          where kind = 'tip_cash' and basis->>'method' = 'direct_cash'
            and basis->>'ticketItemId' = ti.id::text
        ), 0)::int as direct_cash
      from earnings e
      where e.ticket_id = t.id and e.membership_id = tis.membership_id
        and e.reversed_at is null
    ) tips on true
    left join tip_payouts payout
      on payout.location_id = t.location_id
     and payout.business_date = t.business_date
     and payout.membership_id = tis.membership_id
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'authorMembershipId', n.author_membership_id,
        'visibility', n.visibility,
        'content', n.content,
        'containsSensitiveData', n.contains_sensitive_data,
        'updatedAt', n.updated_at
      ) order by n.updated_at) as value
      from ticket_service_notes n
      where n.ticket_item_id = ti.id
        and (${ctx.permissions.has('staff.manage')} or n.visibility = 'assigned_staff')
    ) notes on true
    where t.location_id = ${ctx.locationId}
      and t.business_date = ${businessDate}
      and t.status <> 'voided'
      and tis.membership_id = ${membershipId}
    order by ti.finished_at nulls first, ti.started_at nulls last, ti.seq`;

  const tasks = rows.map((r) => buildTask(r, defs, canSeeContact));
  const current = tasks.find((t) => t.state === 'in_service') ?? null;
  const next = tasks.find((t) => t.state === 'waiting') ?? null;

  // 打卡状态：重放当天流水（和命令用的是同一个纯函数）
  const punches = await tx<{ kind: string; at: string }[]>`
    select kind, at::text as at from time_punches
    where location_id = ${ctx.locationId} and membership_id = ${membershipId}
      and business_date = ${businessDate}
    order by at`;
  const clock = replayPunches(punches.map((p) => ({ kind: p.kind, at: parseTs(p.at) })));

  // 我的收入：earnings 是唯一数据源，和前台看板同一份数
  const [earn] = await tx<{
    commission: number; base: number; tip_cash: number; tip_card: number; direct_cash: number;
  }[]>`
    select
      coalesce(sum(amount_cents) filter (where kind = 'commission'), 0)::int as commission,
      coalesce(sum(base_cents)   filter (where kind = 'commission'), 0)::int as base,
      coalesce(sum(amount_cents) filter (where kind = 'tip_cash'), 0)::int as tip_cash,
      coalesce(sum(amount_cents) filter (where kind = 'tip_card'), 0)::int as tip_card,
      coalesce(sum(amount_cents) filter (
        where kind = 'tip_cash' and basis->>'method' = 'direct_cash'
      ), 0)::int as direct_cash
    from earnings
    where location_id = ${ctx.locationId} and membership_id = ${membershipId}
      and business_date = ${businessDate} and reversed_at is null`;

  const [payout] = await tx<{ paid: number; carry_in: number }[]>`
    select coalesce(sum(paid_cents) filter (where business_date = ${businessDate}), 0)::int as paid,
           coalesce(max(carry_out_cents) filter (where business_date < ${businessDate}), 0)::int as carry_in
    from tip_payouts
    where location_id = ${ctx.locationId} and membership_id = ${membershipId}
      and business_date <= ${businessDate}`;

  const tipCash = earn?.tip_cash ?? 0;
  const commission = earn?.commission ?? 0;

  // 轮牌位置：技师最关心的一句话是「我什么时候轮到」。
  // 用的是和前台轮牌板**同一个引擎**（宪法第 2 条），不另算一套 ——
  // 两边显示的位次对不上是最容易引发猜忌的那类 bug
  const { policy } = await currentBusinessDate(tx, ctx.locationId);
  const { participants, events } = await loadRotation(tx, ctx, businessDate);
  const standing = computeStanding(participants, events, policy);
  const mine = standing.entries.find((e) => e.membershipId === membershipId);

  return {
    businessDate,
    membershipId,
    name: pickText(me?.name, ctx.locale),
    current,
    next,
    tasks,
    doneCount: tasks.filter((t) => t.state === 'done').length,
    onDuty: clock.onDuty,
    workedMinutes: clock.workedMinutes,
    rotation: {
      position: mine?.position ?? null,
      isNextUp: standing.nextUp?.membershipId === membershipId,
      onBreak: mine?.state === 'on_break' || mine?.state === 'off',
    },
    earnings: {
      serviceRevenueCents: earn?.base ?? 0,
      commissionCents: commission,
      tipCashCents: tipCash,
      tipCardCents: earn?.tip_card ?? 0,
      payCents: commission + tipCash + (earn?.tip_card ?? 0),
      cashTipOwedCents: Math.max(0,
        tipCash - (earn?.direct_cash ?? 0) - (payout?.paid ?? 0) + (payout?.carry_in ?? 0)),
    },
  };
}
