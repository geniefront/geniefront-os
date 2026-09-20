import { canonicalCustomer, customerAssetIds } from '../customerIdentity';
/**
 * 客户档案聚合（批 6）。
 *
 * ## 为什么是一个接口而不是让前端拼七个
 *
 * 客户详情页要的东西散在七张表上：档案、偏好、到访统计、消费记录、
 * 礼品卡余额、健康表、审计足迹。让前端并发发七个请求的结果是：
 * 弱网下有几个会失败，而页面上出现一半有数据一半转圈 ——
 * 前台看到的是「系统坏了」。
 *
 * ## ⚠️ 脱敏在服务端，按角色返回不同字段集
 *
 * **不是「返回全量再让前端隐藏」** —— 那等于把客户名单发到每一台
 * 装了技师端的手机上，而隐藏只是 CSS。没有 `customer.view_contact`
 * 的人拿到的 payload 里就没有完整号码，也没有消费金额。
 */

import { pickText, readCustomerProfile, type CommandContext } from '@gf/contracts';
import { parseTs } from '@gf/db';
import type postgres from 'postgres';
import { maskPhone } from './staff';

export interface CustomerDetail {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  /** 有 `customer.view_contact` 才是完整号，否则 `617-***-1234` */
  phone: string | null;
  email: string | null;
  locale: string | null;
  gender: string | null;
  birthday: string | null;
  vipLevel: number;
  tags: string[];
  notes: string | null;
  marketingSmsOptIn: boolean;
  marketingEmailOptIn: boolean;
  noShowCount: number;
  lateCancelCount: number;
  blockedAt: string | null;
  blockedReason: string | null;
  source: string | null;
  /** 合并过的客户查旧 id 会跟到这里 */
  mergedIntoId: string | null;

  preferences: {
    preferredStaffIds: string[];
    avoidStaffIds: string[];
    preferredGender: string | null;
    allergies: unknown;
    freeNotes: string | null;
    profile: ReturnType<typeof readCustomerProfile>;
  };

  visits: {
    total: number;
    firstAt: string | null;
    lastAt: string | null;
    /** ⚠️ 没有 `report.view` 时是 null，不是 0 —— 0 会被当成「他没花过钱」 */
    avgSpendCents: number | null;
    lifetimeSpendCents: number | null;
    /** 距上次到店多少天。从没来过是 null */
    daysSinceLastVisit: number | null;
  };

  /** 手里还有多少钱。没有礼品卡时是空数组，不是 null */
  giftCards: Array<{
    id: string; code: string; balanceCents: number;
    faceValueCents: number; status: string; expiresAt: string | null;
  }>;

  /** Append-only ledger sum; hidden from roles that cannot see customer contact/financial details. */
  storeCreditBalanceCents: number | null;

  recentAppointments: Array<{ id: string; startsAt: string; status: string }>;

  recentTickets: Array<{
    id: string; businessDate: string; status: string;
    totalCents: number | null; serviceNames: string[];
  }>;

  forms: Array<{
    id: string; templateKey: string; submittedAt: string;
  }>;
}

/**
 * @param canSeeContact `customer.view_contact` —— 完整手机号与邮箱
 * @param canSeeMoney   `report.view` —— 消费金额
 */
export async function loadCustomerDetail(
  tx: postgres.TransactionSql, ctx: CommandContext, customerId: string,
): Promise<CustomerDetail | null> {
  const canSeeContact = ctx.permissions.has('customer.view_contact');
  const canSeeMoney = ctx.permissions.has('report.view');

  const [c] = await tx<{
    id: string; display_name: string | null; first_name: string | null;
    last_name: string | null; phone_e164: string | null; email: string | null;
    locale: string | null; gender: string | null; birthday: string | null;
    vip_level: number; tags: string[] | null; notes: string | null;
    marketing_sms_opt_in: boolean; marketing_email_opt_in: boolean;
    no_show_count: number; late_cancel_count: number;
    blocked_at: Date | string | null; blocked_reason: string | null;
    source: string | null; merged_into_id: string | null;
  }[]>`
    select id, display_name, first_name, last_name, phone_e164, email, locale,
           gender, birthday::text as birthday, vip_level, tags, notes,
           marketing_sms_opt_in, marketing_email_opt_in,
           no_show_count, late_cancel_count, blocked_at, blocked_reason,
           source, merged_into_id
    from customers where id = ${customerId}`;
  if (!c) return null;

  const [p] = await tx<{
    preferred_staff_ids: string[] | null; avoid_staff_ids: string[] | null;
    preferred_gender: string | null; allergies: unknown;
    free_notes: string | null; profile: unknown;
  }[]>`
    select preferred_staff_ids, avoid_staff_ids, preferred_gender,
           allergies, free_notes, profile
    from customer_preferences where customer_id = ${customerId}`;

  /*
   * 到访统计。
   *
   * ⚠️ 只算**已结的单**（`status = 'closed'`）—— 作废的单在账上是冲销的，
   * 把它算进「来过几次」会让一个退过款的客人看起来像常客。
   */
  const [v] = await tx<{
    n: number; first_at: string | null; last_at: string | null; total: number;
  }[]>`
    select count(*)::int as n,
           min(business_date)::text as first_at,
           max(business_date)::text as last_at,
           coalesce(sum(total_cents), 0)::int as total
    from tickets
    where location_id = ${ctx.locationId} and customer_id = ${customerId}
      and status = 'closed'`;

  const visitCount = v?.n ?? 0;
  const lifetime = v?.total ?? 0;

  const gcRows = await tx<{
    id: string; code: string; balance_cents: number; face_value_cents: number;
    status: string; expires_at: Date | string | null;
  }[]>`
    select id, code, balance_cents, face_value_cents, status, expires_at
    from gift_cards
    where holder_customer_id = ${customerId} and status in ('active','depleted')
    order by created_at desc limit 20`;

  const assetCustomerId = await canonicalCustomer(tx, customerId);
  const [storeCredit] = await tx<{ balance: number }[]>`
    select coalesce(sum(amount_cents), 0)::int as balance
    from customer_credit_ledger
    where kind = 'store_credit' and customer_id in ${customerAssetIds(tx, assetCustomerId)}`;

  const tkRows = await tx<{
    id: string; business_date: string; status: string;
    total_cents: number | null; names: unknown[] | null;
  }[]>`
    select t.id, t.business_date::text as business_date, t.status, t.total_cents,
           array_agg(s.name) filter (where s.name is not null) as names
    from tickets t
    left join ticket_items ti on ti.ticket_id = t.id
    left join services s on s.id = ti.service_id
    where t.location_id = ${ctx.locationId} and t.customer_id = ${customerId}
    group by t.id
    order by t.business_date desc limit 20`;

  /*
   * ⚠️ 只列「填过哪些表、什么时候填的」，**不碰答案**。
   * 答案是加密的，而且读一次要留痕（sql/0038 的「读也留痕」）——
   * 客户详情页每打开一次就记一条读取日志是不对的：
   * 那会把真正需要审计的「有人翻了谁的健康表」淹掉。
   *
   * 列名是 `created_at`（提交时刻），这张表上没有 submitted_at。
   */
  const formRows = await tx<{ id: string; key: string; at: Date | string }[]>`
    select fs.id, ft.key, fs.created_at as at
    from form_submissions fs
    join form_templates ft on ft.id = fs.template_id
    where fs.customer_id = ${customerId} and fs.location_id = ${ctx.locationId}
    order by fs.created_at desc limit 20`;

  const appointments = ctx.permissions.has('appointment.read') ? await tx<{ id: string; starts_at: Date | string; status: string }[]>`
    select id,starts_at,status from appointments where location_id=${ctx.locationId} and customer_id=${customerId}
    order by starts_at desc limit 20` : [];

  const lastVisit = v?.last_at ? new Date(`${v.last_at}T12:00:00Z`).getTime() : null;

  return {
    id: c.id,
    displayName: c.display_name ?? '',
    firstName: c.first_name,
    lastName: c.last_name,
    // ⭐ 脱敏在这一行发生，不在前端
    phone: canSeeContact ? c.phone_e164 : maskPhone(c.phone_e164),
    email: canSeeContact ? c.email : null,
    locale: c.locale,
    gender: c.gender,
    birthday: c.birthday,
    vipLevel: c.vip_level,
    tags: c.tags ?? [],
    notes: c.notes,
    marketingSmsOptIn: c.marketing_sms_opt_in,
    marketingEmailOptIn: c.marketing_email_opt_in,
    noShowCount: c.no_show_count,
    lateCancelCount: c.late_cancel_count,
    blockedAt: c.blocked_at ? parseTs(c.blocked_at).toISOString() : null,
    blockedReason: c.blocked_reason,
    source: c.source,
    mergedIntoId: c.merged_into_id,

    preferences: {
      preferredStaffIds: p?.preferred_staff_ids ?? [],
      avoidStaffIds: p?.avoid_staff_ids ?? [],
      preferredGender: p?.preferred_gender ?? null,
      allergies: p?.allergies ?? null,
      freeNotes: p?.free_notes ?? null,
      profile: readCustomerProfile(p?.profile),
    },

    visits: {
      total: visitCount,
      firstAt: v?.first_at ?? null,
      lastAt: v?.last_at ?? null,
      // ⚠️ null 而不是 0：0 会被读成「他一分钱没花过」
      avgSpendCents: canSeeMoney && visitCount > 0 ? Math.round(lifetime / visitCount) : null,
      lifetimeSpendCents: canSeeMoney ? lifetime : null,
      daysSinceLastVisit: lastVisit
        ? Math.floor((Date.now() - lastVisit) / 86400_000) : null,
    },

    giftCards: gcRows.map((g) => ({
      id: g.id, code: g.code, balanceCents: g.balance_cents,
      faceValueCents: g.face_value_cents, status: g.status,
      expiresAt: g.expires_at ? parseTs(g.expires_at).toISOString() : null,
    })),

    storeCreditBalanceCents: canSeeContact ? (storeCredit?.balance ?? 0) : null,

    recentAppointments: appointments.map(a => ({ id:a.id, startsAt:parseTs(a.starts_at).toISOString(), status:a.status })),

    recentTickets: tkRows.map((t) => ({
      id: t.id, businessDate: t.business_date, status: t.status,
      // 金额同样按权限收 —— 技师不该看到这位客人一共花了多少
      totalCents: canSeeMoney ? t.total_cents : null,
      serviceNames: (t.names ?? []).map((n) => pickText(n, ctx.locale, '')),
    })),

    forms: formRows.map((f) => ({
      id: f.id, templateKey: f.key, submittedAt: parseTs(f.at).toISOString(),
    })),
  };
}

export interface CustomerListRow {
  id: string;
  displayName: string;
  phone: string | null;
  vipLevel: number;
  visitCount: number;
  lastVisitDate: string | null;
  daysSinceLastVisit: number | null;
  noShowCount: number;
}

export type CustomerFilterType = 'all' | 'vip' | 'active30' | 'sleep30' | 'sleep90' | 'blocked';

/**
 * 客户列表。
 *
 * ⭐ 搜索**优先按手机后四位** —— 前台在电话里问到的第一件事就是
 * 「您手机后四位是多少」，而全名她多半拼不出来（越南名、韩国名）。
 */
export async function loadCustomerList(
  tx: postgres.TransactionSql, ctx: CommandContext,
  opts: {
    q?: string;
    query?: string;
    filterType?: CustomerFilterType;
    vipOnly?: boolean;
    sleepingDays?: number;
    limit?: number;
    offset?: number;
  },
): Promise<{ rows: CustomerListRow[]; total: number; metrics: CustomerMetrics }> {
  const today = await customerBusinessDate(tx, ctx);
  const canSeeContact = ctx.permissions.has('customer.view_contact');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const searchStr = (opts.query ?? opts.q ?? '').trim();
  const digits = searchStr.replace(/\D/g, '');
  const filter = opts.filterType ?? 'all';

  type SearchRow = {
    id: string; display_name: string | null; phone_e164: string | null;
    vip_level: number; no_show_count: number; blocked_at: string | null;
    n: number; last_at: string | null; total: number;
  };
  const selection = tx`
    with v as (
      select customer_id, count(*)::int as n, max(business_date)::text as last_at
      from tickets
      where location_id = ${ctx.locationId} and status in ('closed','refunded')
      group by customer_id
    )
    select c.id, c.display_name, c.phone_e164, c.vip_level, c.no_show_count, c.blocked_at::text as blocked_at,
           coalesce(v.n, 0) as n, v.last_at,
           count(*) over ()::int as total
    from customers c
    left join v on v.customer_id = c.id
    where c.merged_into_id is null
      and (c.primary_location_id = ${ctx.locationId} or v.customer_id is not null)
      ${searchStr ? tx`and (
        ${digits.length >= 3 ? tx`c.phone_e164 like ${'%' + digits}` : tx`false`}
        or c.display_name ilike ${'%' + searchStr + '%'}
      )` : tx``}
      ${(opts.vipOnly || filter === 'vip') ? tx`and c.vip_level > 0` : tx``}
      ${filter === 'active30' ? tx`and v.last_at is not null and v.last_at >= (${today}::date - 30)::text` : tx``}
      ${filter === 'sleep30' ? tx`and (v.last_at is null or v.last_at < (${today}::date - 30)::text)` : tx``}
      ${filter === 'sleep90' ? tx`and (v.last_at is null or v.last_at < (${today}::date - 90)::text)` : tx``}
      ${filter === 'blocked' ? tx`and c.blocked_at is not null` : tx``}
      ${opts.sleepingDays
        ? tx`and (v.last_at is null or v.last_at < (${today}::date - ${opts.sleepingDays}::int)::text)`
        : tx``}
    `;
  const rows = await tx<SearchRow[]>`${selection}
    order by last_at desc nulls last, display_name, id limit ${limit} offset ${offset}`;
  const [emptyCount] = rows.length ? [] : await tx<{ total: number }[]>`
    select count(*)::int as total from (${selection}) matches`;


  const metrics = await loadCustomerMetrics(tx, ctx, today);
  return {
    metrics,
    total: rows[0]?.total ?? emptyCount?.total ?? 0,
    rows: rows.map((r) => {
      const last = r.last_at ? Date.parse(`${r.last_at}T00:00:00Z`) : null;
      return {
        id: r.id,
        displayName: r.display_name ?? '',
        phone: canSeeContact ? r.phone_e164 : maskPhone(r.phone_e164),
        vipLevel: r.vip_level,
        visitCount: r.n,
        lastVisitDate: r.last_at,
        daysSinceLastVisit: last ? Math.floor((Date.parse(`${today}T00:00:00Z`) - last) / 86400_000) : null,
        noShowCount: r.no_show_count,
      };
    }),
  };
}

export interface CustomerMetrics {
  total: number; vipCount: number; active30: number; sleep30: number; sleep90: number;
}

/** All-store metrics do not depend on search, segment or page. */
export async function loadCustomerMetrics(tx: postgres.TransactionSql, ctx: CommandContext, date?: string): Promise<CustomerMetrics> {
  const today = date ?? await customerBusinessDate(tx, ctx);
  const [row] = await tx<CustomerMetrics[]>`
    with visits as (
      select customer_id, max(business_date) as last_at from tickets
      where location_id = ${ctx.locationId} and status in ('closed','refunded') group by customer_id
    ), day as (
      select ${today}::date as today
    )
    select count(*)::int as total,
      count(*) filter (where c.vip_level > 0)::int as "vipCount",
      count(*) filter (where v.last_at >= day.today - 30)::int as "active30",
      count(*) filter (where v.last_at is null or v.last_at < day.today - 30)::int as "sleep30",
      count(*) filter (where v.last_at is null or v.last_at < day.today - 90)::int as "sleep90"
    from customers c left join visits v on v.customer_id = c.id cross join day
    where c.merged_into_id is null and (c.primary_location_id = ${ctx.locationId} or v.customer_id is not null)`;
  return row ?? { total: 0, vipCount: 0, active30: 0, sleep30: 0, sleep90: 0 };
}

async function customerBusinessDate(tx: postgres.TransactionSql, ctx: CommandContext): Promise<string> {
  const [row] = await tx<{ today: string }[]>`select
    (now() at time zone timezone - (business_day_cutoff - time '00:00'))::date::text as today
    from locations where id = ${ctx.locationId}`;
  if (!row) throw new Error('Customer location missing');
  return row.today;
}
