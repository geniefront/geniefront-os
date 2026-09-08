/**
 * 组合套餐目录聚合查询（U10 / 计划 §7）—— 供前台「组合套餐」管理界面读取。
 *
 * 只读：模板 + 组成（服务名 / 目录价已解析）+ 原价合计 / 内建优惠，
 * 外加建 / 改模板时用得上的可选服务与加项清单。定价 / 展开仍以下单时
 * `queries/bundle.ts::quoteBundle` 的服务端报价为准，这里只供列表与编辑器。
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';

export interface BundleComponentDto {
  componentId: string;
  serviceId: string;
  serviceName: string;
  qty: number;
  seq: number;
  includedAddonIds: string[];
  /** 单份目录价（服务 + 包含加项），整数分。 */
  listPriceCents: number;
  durationMin: number;
  /** 组成服务当前是否仍启用 —— 停用则编辑器提示需修复。 */
  serviceActive: boolean;
}

export interface BundleTemplateDto {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  originalTotalCents: number;
  bundleDiscountCents: number;
  onlineBookable: boolean;
  active: boolean;
  version: number;
  sort: number;
  components: BundleComponentDto[];
  /** 全部组成服务均启用时才可用于新建订单。 */
  fulfillable: boolean;
  /** 已开出的套餐实例数（活跃 + 历史），供「有订单占用」提示。 */
  instanceCount: number;
}

export interface BundleCatalogResponse {
  templates: BundleTemplateDto[];
  availableServices: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
  availableAddons: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
}

export async function loadBundleCatalog(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<BundleCatalogResponse> {
  const svcRows = await tx<{
    id: string; name: unknown; base_price_cents: number; duration_min: number;
    is_addon: boolean; active: boolean;
  }[]>`
    select id, name, base_price_cents, duration_min, is_addon, active
    from services where location_id = ${ctx.locationId}
    order by sort, name->>'en'`;
  const svc = new Map(svcRows.map((s) => [s.id, s]));
  const nameOf = (id: string): string => {
    const s = svc.get(id);
    return s ? pickText(s.name, ctx.locale, '—') : '—';
  };

  const bundles = await tx<{
    id: string; name: unknown; description: unknown; price_cents: number;
    online_bookable: boolean; active: boolean; version: number; sort: number;
  }[]>`
    select id, name, description, price_cents, online_bookable, active, version, sort
    from service_bundles where location_id = ${ctx.locationId}
    order by sort, id`;

  const components = bundles.length === 0 ? [] : await tx<{
    id: string; bundle_id: string; service_id: string; qty: number; seq: number;
    included_addon_ids: string[];
  }[]>`
    select id, bundle_id, service_id, qty, seq, included_addon_ids
    from service_bundle_components
    where bundle_id = any(${bundles.map((b) => b.id)})
    order by seq, id`;

  const instanceCounts = bundles.length === 0 ? [] : await tx<{ bundle_id: string; n: number }[]>`
    select bundle_id, count(*)::int as n from order_bundle_instances
    where bundle_id = any(${bundles.map((b) => b.id)})
    group by bundle_id`;
  const instByBundle = new Map(instanceCounts.map((r) => [r.bundle_id, r.n]));

  const templates: BundleTemplateDto[] = bundles.map((b) => {
    const comps = components
      .filter((c) => c.bundle_id === b.id)
      .map<BundleComponentDto>((c) => {
        const s = svc.get(c.service_id);
        const includedCents = c.included_addon_ids.reduce(
          (n, id) => n + (svc.get(id)?.base_price_cents ?? 0), 0);
        const includedMin = c.included_addon_ids.reduce(
          (n, id) => n + (svc.get(id)?.duration_min ?? 0), 0);
        return {
          componentId: c.id,
          serviceId: c.service_id,
          serviceName: nameOf(c.service_id),
          qty: c.qty,
          seq: c.seq,
          includedAddonIds: c.included_addon_ids,
          listPriceCents: (s?.base_price_cents ?? 0) + includedCents,
          durationMin: (s?.duration_min ?? 0) + includedMin,
          serviceActive: s?.active ?? false,
        };
      });
    const originalTotalCents = comps.reduce((n, c) => n + c.listPriceCents * c.qty, 0);
    return {
      id: b.id,
      name: pickText(b.name, ctx.locale, '—'),
      description: b.description ? pickText(b.description, ctx.locale, '') : null,
      priceCents: b.price_cents,
      originalTotalCents,
      bundleDiscountCents: Math.max(0, originalTotalCents - b.price_cents),
      onlineBookable: b.online_bookable,
      active: b.active,
      version: b.version,
      sort: b.sort,
      components: comps,
      fulfillable: comps.length > 0 && comps.every((c) => c.serviceActive),
      instanceCount: instByBundle.get(b.id) ?? 0,
    };
  });

  return {
    templates,
    availableServices: svcRows
      .filter((s) => !s.is_addon && s.active)
      .map((s) => ({
        id: s.id, name: pickText(s.name, ctx.locale, '—'),
        priceCents: s.base_price_cents, durationMin: s.duration_min,
      })),
    availableAddons: svcRows
      .filter((s) => s.is_addon && s.active)
      .map((s) => ({
        id: s.id, name: pickText(s.name, ctx.locale, '—'),
        priceCents: s.base_price_cents, durationMin: s.duration_min,
      })),
  };
}
