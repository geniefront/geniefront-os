/**
 * 历史 `package_templates` 的组合套餐候选扫描（U10 / 计划 P7）—— **只读**。
 *
 * 背景：U10 之前「几个项目一起买走优惠总价」的固定组合，和「按次核销的预付
 * 次卡」共用 `package_templates` / `customer_packages`。上线组合套餐前需要人工
 * 逐条判断历史模板里哪些其实是固定组合。
 *
 * 本函数**只列出候选并给建议**，绝不改写任何数据：
 *   - `likely_bundle`   —— 去重后 ≥ 2 个项目且 `sessions <= 1`：更像固定组合。
 *   - `ambiguous`       —— 两条启发式都不满足：交给店主判断，不猜。
 *   - `likely_punchcard`—— 去重后 ≤ 1 个项目且 `sessions >= 2`：更像次卡，
 *                          默认**不返回**（`includePunchcards` 打开才列出）。
 *
 * 计划 §7 明确：不能只凭 `sessions = 0 / 1` 自动判断；已售 `customer_packages`
 * 的权益与历史工单不随扫描迁移。转换必须逐条确认、保留原 `template_id` 映射，
 * 由独立的一次性脚本执行（设计见实施报告 P7）。
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';

export type LegacyPackageClassification = 'likely_bundle' | 'ambiguous' | 'likely_punchcard';

export interface LegacyPackageCandidate {
  templateId: string;
  name: string;
  priceCents: number;
  sessions: number;
  serviceIds: string[];
  distinctServiceCount: number;
  /** 原价合计（组成项目目录价 × 次数所隐含的口径无法从旧模型还原，这里给
   *  「去重项目的当前目录价之和」，仅供人工比对，不作为转换依据）。 */
  referenceListTotalCents: number;
  active: boolean;
  issuedCount: number;
  activeIssuedCount: number;
  classification: LegacyPackageClassification;
  /** 给操作者看的一句话建议；不代表系统会自动执行。 */
  recommendation: string;
}

export interface LegacyPackageScan {
  locationId: string;
  scannedTemplates: number;
  candidates: LegacyPackageCandidate[];
  /** 提醒：本结果不触发任何迁移。 */
  readonlyNotice: string;
}

interface Row {
  id: string;
  name: unknown;
  price_cents: number;
  sessions: number;
  service_ids: string[];
  active: boolean;
  distinct_service_count: number;
  issued_count: number;
  active_issued_count: number;
  reference_list_total_cents: number;
}

function classify(distinct: number, sessions: number): LegacyPackageClassification {
  if (distinct >= 2 && sessions <= 1) return 'likely_bundle';
  if (distinct <= 1 && sessions >= 2) return 'likely_punchcard';
  return 'ambiguous';
}

const RECOMMENDATION: Record<LegacyPackageClassification, string> = {
  likely_bundle:
    '疑似固定组合：建议人工确认后由一次性脚本建 service_bundles，保留 template_id 映射；'
    + '已售 customer_packages 不自动迁移。',
  ambiguous:
    '无法自动判定：请店主确认这是「一次性组合价」还是「按次核销的预付卡」，再决定是否转换。',
  likely_punchcard:
    '疑似按次核销次卡：保持现状，不转换。',
};

export async function scanLegacyPackageCandidates(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'locationId' | 'locale'>,
  opts: { includePunchcards?: boolean } = {},
): Promise<LegacyPackageScan> {
  const rows = await tx<Row[]>`
    select
      pt.id,
      pt.name,
      pt.price_cents,
      pt.sessions,
      coalesce(pt.service_ids, '{}')::uuid[] as service_ids,
      pt.active,
      (select count(distinct sid) from unnest(coalesce(pt.service_ids, '{}')::uuid[]) sid)::int
        as distinct_service_count,
      (select count(*) from customer_packages cp where cp.template_id = pt.id)::int
        as issued_count,
      (select count(*) from customer_packages cp
        where cp.template_id = pt.id and cp.status = 'active')::int
        as active_issued_count,
      coalesce((
        select sum(s.base_price_cents)::int
        from services s
        where s.id in (select distinct sid from unnest(coalesce(pt.service_ids, '{}')::uuid[]) sid)
      ), 0)::int as reference_list_total_cents
    from package_templates pt
    where pt.location_id = ${ctx.locationId}
    order by pt.sort, pt.id`;

  const includePunchcards = opts.includePunchcards ?? false;
  const candidates: LegacyPackageCandidate[] = [];
  for (const r of rows) {
    const classification = classify(r.distinct_service_count, r.sessions);
    if (classification === 'likely_punchcard' && !includePunchcards) continue;
    candidates.push({
      templateId: r.id,
      name: pickText(r.name, ctx.locale, ''),
      priceCents: r.price_cents,
      sessions: r.sessions,
      serviceIds: r.service_ids,
      distinctServiceCount: r.distinct_service_count,
      referenceListTotalCents: r.reference_list_total_cents,
      active: r.active,
      issuedCount: r.issued_count,
      activeIssuedCount: r.active_issued_count,
      classification,
      recommendation: RECOMMENDATION[classification],
    });
  }

  return {
    locationId: ctx.locationId,
    scannedTemplates: rows.length,
    candidates,
    readonlyNotice:
      '只读扫描：不创建、不修改、不迁移任何数据。转换由独立的逐条确认脚本执行。',
  };
}
