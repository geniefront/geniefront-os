/**
 * 营销中心聚合查询（Marketing.tsx，P1 次卡套餐 / 优惠券 / 积分）
 */

import type postgres from 'postgres';
import { pickText, type CommandContext, asCents, asInt } from '@gf/contracts';

// ─────────────────────────────────────────────────────────── 套餐 (Packages)

export interface PackageTemplateDto {
  id: string;
  name: string;
  priceCents: number;
  serviceId: string;
  serviceName: string;
  totalUnits: number;
  validDays: number | null;
  sessions: number | 'Unlimited';
  sold: number;
  revenueCents: number;
  catalogValueCents: number | null;
  savingsCents: number | null;
  growth: number;
  active: boolean;
  serviceIds: string[];
  serviceNames: string[];
}

export interface CustomerPackageViewDto {
  id: string;
  customerId: string;
  customerName: string;
  templateId: string;
  templateName: string;
  serviceName: string;
  serviceNames: string[];
  totalUnits: number;
  remainingUnits: number;
  expiresAt: string | null;
  status: string;
  createdAt: string;
}

export async function loadPackages(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{
  templates: PackageTemplateDto[];
  userPackages: CustomerPackageViewDto[];
  availableServices: Array<{ id: string; name: string; priceCents: number }>;
  totalSold: number;
  totalRevenueCents: number;
}> {
  const tpls = await tx<{
    id: string; name: unknown; price_cents: number; sessions: number;
    valid_days: number | null; active: boolean; service_ids: string[];
  }[]>`
    select id, name, price_cents, sessions, valid_days, active, service_ids::text[] as service_ids
    from package_templates
    where location_id = ${ctx.locationId}
    order by sort asc, created_at desc`;

  const srvRows = await tx<{ id: string; name: unknown; base_price_cents: number; active: boolean }[]>`
    select id, name, base_price_cents, active from services
    where location_id = ${ctx.locationId} order by sort, name->>'en'`;
  const srvMap = new Map(srvRows.map((s) => [s.id, pickText(s.name, ctx.locale, '指定服务')]));
  const srvPriceMap = new Map(srvRows.map((s) => [s.id, s.base_price_cents]));

  const soldStats = await tx<{
    template_id: string; sold_count: string; revenue_cents: string;
  }[]>`
    select template_id, count(*)::text as sold_count,
           coalesce(sum(case when pt.price_cents is not null then pt.price_cents else 0 end), 0)::text as revenue_cents
    from customer_packages cp
    join package_templates pt on pt.id = cp.template_id
    where cp.location_id = ${ctx.locationId}
    group by template_id`;

  const statsMap = new Map<string, { sold: number; revenue: number }>();
  for (const s of soldStats) {
    statsMap.set(s.template_id, {
      sold: Number(s.sold_count),
      revenue: asCents(s.revenue_cents),
    });
  }

  let totalSold = 0;
  let totalRevenueCents = 0;

  const templates: PackageTemplateDto[] = tpls.map((t) => {
    const st = statsMap.get(t.id) ?? { sold: 0, revenue: 0 };
    totalSold += st.sold;
    totalRevenueCents += st.revenue;
    const firstSrvId = t.service_ids?.[0] ?? '';
    const firstSrvName = firstSrvId ? (srvMap.get(firstSrvId) || '综合服务') : '全品类通用';
    const perSessionValue = (t.service_ids ?? []).reduce(
      (sum, id) => sum + (srvPriceMap.get(id) ?? 0), 0,
    );
    const catalogValueCents = t.sessions > 0 && perSessionValue > 0
      ? perSessionValue * t.sessions
      : null;

    return {
      id: t.id,
      name: pickText(t.name, ctx.locale, '次卡套餐'),
      priceCents: t.price_cents,
      serviceId: firstSrvId,
      serviceName: firstSrvName,
      totalUnits: t.sessions,
      validDays: t.valid_days,
      sessions: t.sessions === 0 ? 'Unlimited' : t.sessions,
      sold: st.sold,
      revenueCents: st.revenue,
      catalogValueCents,
      savingsCents: catalogValueCents === null ? null : Math.max(0, catalogValueCents - t.price_cents),
      growth: 10,
      active: t.active,
      serviceIds: t.service_ids ?? [],
      serviceNames: (t.service_ids ?? []).map((id) => srvMap.get(id) || '已下架项目'),
    };
  });

  const userPkgRows = await tx<{
    id: string; customer_id: string; customer_name: string | null;
    template_id: string; template_name: unknown; service_ids: string[] | null;
    total_sessions: number; remaining_sessions: number;
    expires_at: string | null; status: string; created_at: string;
  }[]>`
    select cp.id, cp.customer_id, c.display_name as customer_name,
           cp.template_id, pt.name as template_name, pt.service_ids::text[] as service_ids,
           cp.total_sessions, cp.remaining_sessions,
           cp.expires_at::text as expires_at, cp.status, cp.created_at::text as created_at
    from customer_packages cp
    left join customers c on c.id = cp.customer_id
    left join package_templates pt on pt.id = cp.template_id
    where cp.location_id = ${ctx.locationId}
    order by cp.created_at desc limit 100`;

  const userPackages: CustomerPackageViewDto[] = userPkgRows.map((up) => {
    const firstSrvId = up.service_ids?.[0] ?? '';
    const srvName = firstSrvId ? (srvMap.get(firstSrvId) || '指定服务') : '全品类通用';
    return {
      id: up.id,
      customerId: up.customer_id,
      customerName: up.customer_name || '会员客人',
      templateId: up.template_id,
      templateName: pickText(up.template_name, ctx.locale, '次卡套餐'),
      serviceName: srvName,
      serviceNames: (up.service_ids ?? []).map((id) => srvMap.get(id) || '已下架项目'),
      totalUnits: up.total_sessions,
      remainingUnits: up.remaining_sessions,
      expiresAt: up.expires_at,
      status: up.status,
      createdAt: up.created_at,
    };
  });

  const availableServices = srvRows
    .filter((service) => service.active)
    .map((service) => ({
      id: service.id,
      name: srvMap.get(service.id) || '服务项目',
      priceCents: service.base_price_cents,
    }));

  return { templates, userPackages, availableServices, totalSold, totalRevenueCents };
}

// ─────────────────────────────────────────────────────────── 优惠券 (Coupons)

export interface CouponTemplateDto {
  id: string;
  code: string;
  name: string;
  kind: 'amount' | 'percent';
  discountCents: number;
  percentBp: number;
  minSpendCents: number;
  validFrom: string | null;
  validUntil: string | null;
  maxUses: number | null;
  usedCount: number;
  active: boolean;
}

export async function loadCoupons(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ coupons: CouponTemplateDto[] }> {
  const rows = await tx<{
    id: string; code: string; name: unknown; kind: string;
    discount_cents: number; percent_bp: number; min_spend_cents: number;
    valid_from: string | null; valid_until: string | null;
    max_uses: number | null; used_count: number; active: boolean;
  }[]>`
    select id, code, name, kind, discount_cents, percent_bp, min_spend_cents,
           valid_from::text as valid_from, valid_until::text as valid_until,
           max_uses, used_count, active
    from coupon_templates
    where location_id = ${ctx.locationId}
    order by created_at desc`;

  const coupons: CouponTemplateDto[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: pickText(r.name, ctx.locale, r.code),
    kind: r.kind as 'amount' | 'percent',
    discountCents: r.discount_cents,
    percentBp: r.percent_bp,
    minSpendCents: r.min_spend_cents,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    active: r.active,
  }));

  return { coupons };
}

// ─────────────────────────────────────────────────────────── 积分体系 (Loyalty)

export interface LoyaltyDto {
  enabled: boolean;
  earnRateCentsPerPoint: number;
  redeemCentsPerPoint: number;
  minRedeemPoints: number;
  customerCountWithPoints: number;
  totalPointsOutstanding: number;
}

export async function loadLoyalty(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<LoyaltyDto> {
  const [loc] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${ctx.locationId}`;

  const rawLoyalty = ((loc?.settings ?? {})['loyalty'] ?? {}) as Record<string, unknown>;

  const [stats] = await tx<{
    cust_count: string; total_points: string;
  }[]>`
    select count(distinct customer_id)::text as cust_count,
           coalesce(sum(amount_cents), 0)::text as total_points
    from customer_credit_ledger
    where kind = 'points' and location_id = ${ctx.locationId}`;

  return {
    enabled: rawLoyalty['enabled'] !== false,
    earnRateCentsPerPoint: asCents(rawLoyalty['earnRateCentsPerPoint'] ?? 100),
    redeemCentsPerPoint: asCents(rawLoyalty['redeemCentsPerPoint'] ?? 5),
    minRedeemPoints: Number(rawLoyalty['minRedeemPoints'] ?? 100),
    customerCountWithPoints: Number(stats?.cust_count ?? 0),
    totalPointsOutstanding: Math.max(0, asInt(stats?.total_points, 0)),
  };
}
