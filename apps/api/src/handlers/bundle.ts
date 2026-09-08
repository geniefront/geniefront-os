/**
 * 组合套餐目录（U10 / 计划 §5、§7）。
 *
 *   bundle.saveTemplate     创建 / 编辑模板（组成、数量、包含加项、价格、状态、版本）
 *   bundle.archiveTemplate  下架模板（历史订单不受影响 —— 下单已快照）
 *
 * 报价 / 展开是只读查询，见 `../queries/bundle.ts::quoteBundle`（不走命令总线）。
 * 创建 / 结账 / 看板链路在计划 P3–P5 接入。
 *
 * 校验失败统一 `VALIDATION_FAILED` + `details.reason`（见契约头注释的 reason 清单）。
 */

import {
  BundleSaveTemplate, BundleArchiveTemplate,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { loadBundleServices } from '../queries/bundle';

const fail = (reason: string, extra: Record<string, unknown> = {}): never => {
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason, ...extra } });
};

// ─────────────────────────────────────────────────────────── saveTemplate

registerHandler(BundleSaveTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof BundleSaveTemplate.input._type>) => {
  // 计划 §4.1：至少两个实际组成单元（不同项目或同项目两次）。
  const totalUnits = input.components.reduce((n, c) => n + c.qty, 0);
  if (totalUnits < 2) fail('bundle_component_empty', { totalUnits });

  const svc = await loadBundleServices(tx, ctx.locationId, [
    ...input.components.map((c) => c.serviceId),
    ...input.components.flatMap((c) => c.includedAddonIds),
  ]);

  for (const c of input.components) {
    const s = svc.get(c.serviceId)!;
    // 组成是可履约的真实项目，不是加项。加项走 includedAddonIds。
    if (s.is_addon) fail('bundle_component_service_invalid', { serviceId: c.serviceId, detail: 'is_addon' });
    if (!s.active) fail('bundle_service_inactive', { serviceId: c.serviceId });
    for (const addonId of c.includedAddonIds) {
      const a = svc.get(addonId)!;
      if (!a.is_addon) fail('bundle_addon_not_addon', { serviceId: addonId });
      if (!a.active) fail('bundle_service_inactive', { serviceId: addonId });
    }
  }

  // 组成原价合计 = Σ (组成服务价 + 其包含加项价) × 数量。
  const originalTotalCents = input.components.reduce((sum, c) => {
    const base = svc.get(c.serviceId)!.base_price_cents;
    const addons = c.includedAddonIds.reduce((n, id) => n + svc.get(id)!.base_price_cents, 0);
    return sum + (base + addons) * c.qty;
  }, 0);

  // 计划 §4.1：首版组合价不超过组成原价合计。
  if (input.priceCents > originalTotalCents) {
    fail('bundle_price_above_components', { priceCents: input.priceCents, originalTotalCents });
  }

  const descJson = input.description == null ? null : jsonb(input.description);

  const writeComponents = async (bundleId: string) => {
    await tx`delete from service_bundle_components where bundle_id = ${bundleId}`;
    for (let i = 0; i < input.components.length; i += 1) {
      const c = input.components[i]!;
      await tx`
        insert into service_bundle_components
          (bundle_id, org_id, location_id, service_id, qty, seq, included_addon_ids)
        values (${bundleId}, ${ctx.orgId}, ${ctx.locationId}, ${c.serviceId},
                ${c.qty}, ${c.seq === 0 ? i : c.seq}, ${[...new Set(c.includedAddonIds)]}::uuid[])`;
    }
  };

  if (input.bundleId) {
    const [existing] = await tx<{ id: string; version: number; name: unknown; price_cents: number }[]>`
      select id, version, name, price_cents from service_bundles
      where id = ${input.bundleId} and location_id = ${ctx.locationId}`;
    if (!existing) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service_bundle' } });

    // 乐观锁：预览取到的版本与当前不一致 = 期间被人改过（计划 §5.3）。
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      fail('bundle_version_conflict', { expected: input.expectedVersion, actual: existing.version });
    }

    // 每次编辑都递增版本：下单已锁定各自的版本快照，历史订单不受影响。
    const nextVersion = existing.version + 1;
    await tx`
      update service_bundles set
        name = ${jsonb(input.name)}::jsonb,
        description = ${descJson === null ? tx`null` : tx`${descJson}::jsonb`},
        price_cents = ${input.priceCents},
        online_bookable = ${input.onlineBookable === undefined ? tx`online_bookable` : input.onlineBookable},
        active = ${input.active === undefined ? tx`active` : input.active},
        sort = ${input.sort === undefined ? tx`sort` : input.sort},
        version = ${nextVersion}
      where id = ${input.bundleId}`;
    await writeComponents(input.bundleId);

    audit({
      entityType: 'service_bundle',
      entityId: input.bundleId,
      before: { name: pickText(existing.name, ctx.locale), priceCents: existing.price_cents, version: existing.version },
      after: { name: pickText(input.name, ctx.locale), priceCents: input.priceCents, version: nextVersion },
    });
    return { bundleId: input.bundleId, created: false, version: nextVersion };
  }

  const [row] = await tx<{ id: string }[]>`
    insert into service_bundles
      (org_id, location_id, name, description, price_cents, online_bookable, active, version, sort)
    values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(input.name)}::jsonb,
            ${descJson === null ? null : tx`${descJson}::jsonb`},
            ${input.priceCents}, ${input.onlineBookable ?? false},
            ${input.active ?? true}, 1, ${input.sort ?? 0})
    returning id`;
  await writeComponents(row!.id);

  audit({
    entityType: 'service_bundle',
    entityId: row!.id,
    after: { name: pickText(input.name, ctx.locale), priceCents: input.priceCents, created: true },
  });
  return { bundleId: row!.id, created: true, version: 1 };
});

// ─────────────────────────────────────────────────────────── archiveTemplate

registerHandler(BundleArchiveTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof BundleArchiveTemplate.input._type>) => {
  const rows = await tx<{ id: string }[]>`
    update service_bundles set active = false
    where id = ${input.bundleId} and location_id = ${ctx.locationId}
    returning id`;
  if (rows.length === 0) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service_bundle' } });
  audit({ entityType: 'service_bundle', entityId: input.bundleId, after: { active: false } });
  return { bundleId: input.bundleId };
});
