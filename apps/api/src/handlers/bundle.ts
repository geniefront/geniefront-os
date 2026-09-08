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
  BundleSaveTemplate, BundleArchiveTemplate, BundleSplitInstance,
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

// ─────────────────────────────────────────────────────────── splitInstance

registerHandler(BundleSplitInstance, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof BundleSplitInstance.input._type>) => {
  const [ticket] = await tx<{
    id: string; status: string; business_date: string; service_settled_at: string | null;
  }[]>`
    select id, status, business_date::text as business_date, service_settled_at::text as service_settled_at
    from tickets where id = ${input.ticketId} and location_id = ${ctx.locationId} for update`;
  if (!ticket) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  // 计划 §4.4：仅「未开工、未付款」允许拆单。
  if (ticket.status !== 'in_service' || ticket.service_settled_at) {
    fail('bundle_split_ticket_not_open', { status: ticket.status });
  }
  const [paid] = await tx<{ n: number }[]>`
    select count(*)::int as n from payments where ticket_id = ${input.ticketId}`;
  if ((paid?.n ?? 0) > 0) fail('bundle_split_after_payment');

  const [inst] = await tx<{ status: string; bundle_price_cents: number }[]>`
    select status, bundle_price_cents from order_bundle_instances
    where id = ${input.bundleInstanceId} and ticket_id = ${input.ticketId}
      and location_id = ${ctx.locationId}
    for update`;
  if (!inst) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'order_bundle_instance' } });
  if (inst.status !== 'active') fail('bundle_instance_not_active', { status: inst.status });

  const items = await tx<{
    id: string; total_cents: number; bundle_list_price_cents: number | null; started_at: string | null;
  }[]>`
    select id, total_cents, bundle_list_price_cents, started_at::text as started_at
    from ticket_items
    where ticket_id = ${input.ticketId} and bundle_instance_id = ${input.bundleInstanceId}
    order by seq`;
  if (items.length === 0) fail('bundle_instance_no_items');
  if (items.some((i) => i.started_at != null)) fail('bundle_split_after_start');
  if (items.some((i) => i.bundle_list_price_cents == null)) fail('bundle_split_missing_list_price');
  // 额外加项 / 额外优惠的实例：净额之和 ≠ 锁定组合价，拆回单项原价会丢掉加项金额。
  // 首版不支持，走作废重建。
  const netSum = items.reduce((n, i) => n + i.total_cents, 0);
  if (netSum !== inst.bundle_price_cents) fail('bundle_split_with_extras_unsupported');

  await tx`update ticket_items set
      unit_price_cents = bundle_list_price_cents,
      total_cents = bundle_list_price_cents,
      bundle_instance_id = null, bundle_component_id = null,
      bundle_unit_index = null, bundle_list_price_cents = null
    where ticket_id = ${input.ticketId} and bundle_instance_id = ${input.bundleInstanceId}`;
  await tx`update order_bundle_instances set status = 'split', updated_at = now()
           where id = ${input.bundleInstanceId}`;

  const [row] = await tx<{ subtotal: number }[]>`
    select coalesce(sum(total_cents), 0)::int as subtotal
    from ticket_items where ticket_id = ${input.ticketId}`;
  const subtotal = row?.subtotal ?? 0;
  await tx`update tickets set subtotal_cents = ${subtotal}, total_cents = ${subtotal}
           where id = ${input.ticketId}`;

  audit({
    entityType: 'ticket', entityId: input.ticketId,
    after: { action: 'bundle_split', bundleInstanceId: input.bundleInstanceId, splitItemCount: items.length },
  });
  emit({ type: 'ticket.changed', entityId: input.ticketId, businessDate: ticket.business_date });

  return {
    ticketId: input.ticketId,
    bundleInstanceId: input.bundleInstanceId,
    splitItemCount: items.length,
    subtotalCents: subtotal,
  };
});
