/**
 * 历史次卡 → 组合套餐的一次性转换运维入口（U10 / 计划 P7）。
 *
 * ```
 * # 只校验 + 预览，不写库
 * pnpm --filter @gf/api legacy-package-to-bundle plan <org-id> <location-id> <mapping.json>
 *
 * # 真正写库：建 service_bundles + 组成，可选下架旧 package_templates，
 * # 把 templateId → bundleId 映射写到 <mapping.json>.applied.json
 * pnpm --filter @gf/api legacy-package-to-bundle apply <org-id> <location-id> <mapping.json>
 * ```
 *
 * ## 为什么是脚本而不是命令
 *
 * 转换是逐条人工确认后的一次性操作，`qty` 由运维按实际组合填（旧 `package_templates`
 * 不记每个项目的份数）。先用 `GET /v1/desk/bundles/legacy-scan`（`scanLegacyPackageCandidates`）
 * 拉候选，人工挑出「确实是固定组合」的，编成 mapping.json 再跑本脚本。
 *
 * ## 不变量（计划 §5.3 / §7）
 *
 *   - 组合价 = 旧 `package_templates.price_cents`，且不超过组成目录原价合计。
 *   - 展开后至少两个执行单元。
 *   - 保留 `templateId → bundleId` 映射（写到 .applied.json）。
 *   - **已售 `customer_packages` 不迁移** —— 老客户手里的次卡按旧核销路径用到用完。
 *   - `archiveTemplate: true` 时旧模板 `active=false`，停止新发卡；历史工单不受影响。
 *
 * mapping.json 结构：
 * ```json
 * [
 *   {
 *     "templateId": "<package_templates.id>",
 *     "name": { "en": "Relax Combo", "zh-Hans": "放松套餐" },
 *     "components": [
 *       { "serviceId": "<uuid>", "qty": 1, "seq": 0 },
 *       { "serviceId": "<uuid>", "qty": 1, "seq": 1 }
 *     ],
 *     "archiveTemplate": true
 *   }
 * ]
 * ```
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { withTenant, jsonb, closeDb } from '@gf/db';

interface MappingEntry {
  templateId: string;
  name?: Record<string, string>;
  components: Array<{ serviceId: string; qty: number; seq: number }>;
  archiveTemplate?: boolean;
}

interface PlannedBundle {
  templateId: string;
  templateName: Record<string, string>;
  name: Record<string, string>;
  priceCents: number;
  originalTotalCents: number;
  components: Array<{ serviceId: string; qty: number; seq: number; listPriceCents: number }>;
  archiveTemplate: boolean;
}

function readMapping(path: string): MappingEntry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('mapping.json 顶层必须是数组');
  return parsed.map((e, i) => {
    const entry = e as MappingEntry;
    if (!entry.templateId) throw new Error(`第 ${i} 条缺 templateId`);
    if (!Array.isArray(entry.components) || entry.components.length === 0) {
      throw new Error(`第 ${i} 条 components 为空`);
    }
    return entry;
  });
}

async function buildPlan(
  orgId: string, locationId: string, entries: MappingEntry[],
): Promise<PlannedBundle[]> {
  return withTenant({ orgId, locationId, membershipId: null }, async (tx) => {
    const planned: PlannedBundle[] = [];
    for (const entry of entries) {
      const [tpl] = await tx<{ id: string; name: Record<string, string>; price_cents: number }[]>`
        select id, name, price_cents from package_templates
        where id = ${entry.templateId} and location_id = ${locationId}`;
      if (!tpl) throw new Error(`package_templates ${entry.templateId} 不在本店`);

      const serviceIds = [...new Set(entry.components.map((c) => c.serviceId))];
      const svcRows = await tx<{ id: string; base_price_cents: number; is_addon: boolean; active: boolean }[]>`
        select id, base_price_cents, is_addon, active from services
        where location_id = ${locationId} and id = any(${serviceIds})`;
      const svc = new Map(svcRows.map((s) => [s.id, s]));
      for (const c of entry.components) {
        const s = svc.get(c.serviceId);
        if (!s) throw new Error(`${entry.templateId}: 服务 ${c.serviceId} 不在本店`);
        if (s.is_addon) throw new Error(`${entry.templateId}: ${c.serviceId} 是加项，不能作组成`);
        if (!s.active) throw new Error(`${entry.templateId}: ${c.serviceId} 已停用`);
        if (!Number.isInteger(c.qty) || c.qty < 1) throw new Error(`${entry.templateId}: qty 非法`);
      }
      const units = entry.components.reduce((n, c) => n + c.qty, 0);
      if (units < 2) throw new Error(`${entry.templateId}: 展开后不足两个执行单元`);
      const originalTotalCents = entry.components.reduce(
        (n, c) => n + svc.get(c.serviceId)!.base_price_cents * c.qty, 0);
      if (tpl.price_cents > originalTotalCents) {
        throw new Error(
          `${entry.templateId}: 组合价 ${tpl.price_cents} 高于组成原价合计 ${originalTotalCents}`);
      }

      planned.push({
        templateId: tpl.id,
        templateName: tpl.name,
        name: entry.name ?? tpl.name,
        priceCents: tpl.price_cents,
        originalTotalCents,
        components: entry.components.map((c) => ({
          ...c, listPriceCents: svc.get(c.serviceId)!.base_price_cents,
        })),
        archiveTemplate: entry.archiveTemplate ?? false,
      });
    }
    return planned;
  });
}

function printPlan(planned: PlannedBundle[]): void {
  for (const p of planned) {
    const nm = p.name['en'] ?? Object.values(p.name)[0] ?? '(unnamed)';
    console.log(`\n▸ ${nm}  ← package_templates ${p.templateId}`);
    console.log(`  组合价 $${(p.priceCents / 100).toFixed(2)}  原价合计 $${(p.originalTotalCents / 100).toFixed(2)}`
      + `  内建优惠 $${((p.originalTotalCents - p.priceCents) / 100).toFixed(2)}`);
    for (const c of p.components) {
      console.log(`    seq ${c.seq}  ×${c.qty}  ${c.serviceId}  ($${(c.listPriceCents / 100).toFixed(2)}/份)`);
    }
    console.log(`  archiveTemplate: ${p.archiveTemplate}`);
  }
}

async function apply(
  orgId: string, locationId: string, planned: PlannedBundle[],
): Promise<Array<{ templateId: string; bundleId: string }>> {
  return withTenant({ orgId, locationId, membershipId: null }, async (tx) => {
    const mapping: Array<{ templateId: string; bundleId: string }> = [];
    for (const p of planned) {
      const [bundle] = await tx<{ id: string }[]>`
        insert into service_bundles
          (org_id, location_id, name, description, price_cents, online_bookable, active, version, sort)
        values (${orgId}, ${locationId}, ${jsonb(p.name)}::jsonb, null,
                ${p.priceCents}, false, true, 1, 0)
        returning id`;
      for (const c of p.components) {
        await tx`
          insert into service_bundle_components
            (bundle_id, org_id, location_id, service_id, qty, seq, included_addon_ids)
          values (${bundle!.id}, ${orgId}, ${locationId}, ${c.serviceId}, ${c.qty}, ${c.seq}, '{}')`;
      }
      if (p.archiveTemplate) {
        await tx`update package_templates set active = false, online_sale = false, updated_at = now()
                 where id = ${p.templateId} and location_id = ${locationId}`;
      }
      mapping.push({ templateId: p.templateId, bundleId: bundle!.id });
    }
    return mapping;
  });
}

async function main(): Promise<void> {
  const [cmd, orgId, locationId, mappingPath] = process.argv.slice(2);
  if ((cmd !== 'plan' && cmd !== 'apply') || !orgId || !locationId || !mappingPath) {
    console.error('用法: legacy-package-to-bundle <plan|apply> <org-id> <location-id> <mapping.json>');
    process.exit(2);
  }
  const entries = readMapping(mappingPath);
  const planned = await buildPlan(orgId, locationId, entries);
  printPlan(planned);

  if (cmd === 'plan') {
    console.log(`\n[plan] ${planned.length} 条通过校验，未写库。`);
    return;
  }

  const mapping = await apply(orgId, locationId, planned);
  const outPath = `${mappingPath}.applied.json`;
  writeFileSync(outPath, JSON.stringify({ appliedAt: new Date().toISOString(), mapping }, null, 2));
  console.log(`\n[apply] 已建 ${mapping.length} 个 service_bundles；映射写入 ${outPath}`);
  console.log('⚠️ 已售 customer_packages 未迁移（刻意）。旧模板按 archiveTemplate 停售。');
}

main().then(() => closeDb()).catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
