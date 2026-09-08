/**
 * 组合套餐报价 / 展开（U10 / 计划 §6）—— **只读查询**。
 *
 * 创建（预约 / walk-in / 直接开单）、结账复核、看板拆单预览共用这一个函数，
 * 三条路各自 round 一次就会得出三个总额（同 split.ts 的教训）。它只载入
 * 目录快照 + 调 `@gf/payroll` 的 allocateBundle，不写库、不留审计，所以
 * 不走命令总线（总线强制每条命令留痕，报价会被前端预览高频调用）。
 *
 * 校验失败抛 `VALIDATION_FAILED` + `details.reason`，reason 取值见
 * `@gf/contracts` 的 `commands/bundle.ts` 头注释。
 */

import type postgres from 'postgres';
import {
  AppError, ERROR_CODES, type CommandContext, type BundleQuoteRequest, type BundleQuoteResult,
} from '@gf/contracts';
import { allocateBundle, BundlePricingError, type BundleComponentSpec } from '@gf/payroll';

const fail = (reason: string, extra: Record<string, unknown> = {}): never => {
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason, ...extra } });
};

interface ServiceRow {
  id: string;
  base_price_cents: number;
  duration_min: number;
  is_addon: boolean;
  active: boolean;
}

export async function loadBundleServices(
  tx: postgres.TransactionSql, locationId: string, ids: readonly string[],
): Promise<Map<string, ServiceRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx<ServiceRow[]>`
    select id, base_price_cents, duration_min, is_addon, active
    from services where location_id = ${locationId} and id = any(${unique})`;
  if (rows.length !== unique.length) fail('bundle_component_service_invalid', { entity: 'service' });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function quoteBundle(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'locationId'>,
  req: BundleQuoteRequest,
): Promise<BundleQuoteResult> {
  const [bundle] = await tx<{ id: string; version: number; price_cents: number; active: boolean; name: Record<string, string> }[]>`
    select id, version, price_cents, active, name from service_bundles
    where id = ${req.bundleId} and location_id = ${ctx.locationId}`;
  if (!bundle || !bundle.active) fail('bundle_not_found', { bundleId: req.bundleId });
  if (req.expectedVersion !== undefined && req.expectedVersion !== bundle!.version) {
    fail('bundle_version_conflict', { expected: req.expectedVersion, actual: bundle!.version });
  }

  const components = await tx<{
    id: string; service_id: string; qty: number; seq: number; included_addon_ids: string[];
  }[]>`
    select id, service_id, qty, seq, included_addon_ids
    from service_bundle_components where bundle_id = ${bundle!.id}
    order by seq, id`;
  if (components.length === 0) fail('bundle_component_empty', { bundleId: req.bundleId });

  const svc = await loadBundleServices(tx, ctx.locationId, [
    ...components.map((c) => c.service_id),
    ...components.flatMap((c) => c.included_addon_ids),
    ...req.extraAddons.map((a) => a.serviceId),
  ]);

  const specComponents: BundleComponentSpec[] = components.map((c) => {
    const s = svc.get(c.service_id)!;
    if (!s.active) fail('bundle_service_inactive', { serviceId: c.service_id });
    const includedCents = c.included_addon_ids.reduce((n, id) => {
      const a = svc.get(id)!;
      if (!a.active) fail('bundle_service_inactive', { serviceId: id });
      return n + a.base_price_cents;
    }, 0);
    return {
      componentId: c.id,
      serviceId: c.service_id,
      listPriceCents: s.base_price_cents + includedCents,
      qty: c.qty,
      seq: c.seq,
    };
  });

  const specExtraAddons = req.extraAddons.map((a) => {
    const s = svc.get(a.serviceId)!;
    if (!s.is_addon) fail('bundle_addon_not_addon', { serviceId: a.serviceId });
    if (!s.active) fail('bundle_service_inactive', { serviceId: a.serviceId });
    return {
      ref: a.ref,
      attachToUnit: a.attachToUnit,
      serviceId: a.serviceId,
      qty: a.qty,
      listPriceCents: s.base_price_cents,
    };
  });

  let result;
  try {
    result = allocateBundle({
      components: specComponents,
      bundlePriceCents: bundle!.price_cents,
      extraAddons: specExtraAddons,
      extraDiscountCents: req.extraDiscountCents,
      extraDiscountKind: req.extraDiscountKind,
    });
  } catch (err) {
    if (err instanceof BundlePricingError) return fail(err.reason);
    throw err;
  }

  // component_id → 其包含加项、时长（供子项排程）
  const componentById = new Map(components.map((c) => [c.id, c]));
  const durationOfComponent = (componentId: string): number => {
    const c = componentById.get(componentId)!;
    const s = svc.get(c.service_id)!;
    return c.included_addon_ids.reduce((n, id) => n + svc.get(id)!.duration_min, s.duration_min);
  };

  const unitKeyToOrdinal = new Map(result.units.map((u, i) => [u.unitKey, i]));

  return {
    bundleId: bundle!.id,
    version: bundle!.version,
    nameSnapshot: bundle!.name,
    units: result.units.map((u) => ({
      componentId: u.componentId,
      serviceId: u.serviceId,
      seq: u.seq,
      unitIndex: u.unitIndex,
      unitKey: u.unitKey,
      listPriceCents: u.listPriceCents,
      bundleNetCents: u.bundleNetCents,
      extraDiscountCents: u.extraDiscountCents,
      netCents: u.netCents,
      durationMin: durationOfComponent(u.componentId),
      includedAddonIds: componentById.get(u.componentId)!.included_addon_ids,
    })),
    extraAddons: result.extraAddons.map((a, i) => {
      const ordinal = unitKeyToOrdinal.get(specExtraAddons[i]!.attachToUnit);
      if (ordinal === undefined) fail('bundle_addon_unit_not_found', { attachToUnit: specExtraAddons[i]!.attachToUnit });
      return {
        ref: a.ref,
        attachToUnit: a.attachToUnit,
        unitOrdinal: ordinal!,
        serviceId: specExtraAddons[i]!.serviceId,
        qty: a.qty,
        listPriceCents: a.listPriceCents,
        extraDiscountCents: a.extraDiscountCents,
        netCents: a.netCents,
        durationMin: svc.get(specExtraAddons[i]!.serviceId)!.duration_min * a.qty,
      };
    }),
    originalTotalCents: result.originalTotalCents,
    bundlePriceCents: result.bundlePriceCents,
    bundleDiscountCents: result.bundleDiscountCents,
    extraAddonListTotalCents: result.extraAddonListTotalCents,
    extraDiscountCents: result.extraDiscountCents,
    serviceNetTotalCents: result.serviceNetTotalCents,
  };
}
