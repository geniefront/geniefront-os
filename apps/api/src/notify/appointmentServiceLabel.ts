/**
 * 顾客侧通知（确认邮件 / 确认短信 / 提醒）里「服务名」那一行的组装（U10 / 计划 §7）。
 *
 * 既有实现取**首个** `appointment_item` 的 `service_name` —— 多项目预约（包括组合套餐）
 * 只会显示第一项。这里改成：
 *   - 预约含活跃组合套餐实例 → 用套餐名快照（多份用 ` + ` 连接）；还有散项则补 `+ N more`。
 *   - 无套餐但多项目 → `<首项> + N more`。
 *   - 单项目 → 首项名，与旧行为一致。
 *
 * 顾客侧文案恒为英语（`email/render.ts` 文件头的语言策略），因此 `+ N more` 用英文字面量。
 * 纯拼接部分抽成 `composeServiceLabel` 便于单测。
 */
import type postgres from 'postgres';
import { pickText } from '@gf/contracts';

/** 纯函数：给定套餐名、总项目数、其中属于套餐的项目数、首项名，拼出展示串。 */
export function composeServiceLabel(args: {
  bundleNames: readonly string[];
  totalItems: number;
  bundledItems: number;
  firstServiceName: string;
}): string {
  const { bundleNames, totalItems, bundledItems, firstServiceName } = args;
  if (bundleNames.length > 0) {
    const base = bundleNames.join(' + ');
    const loose = Math.max(0, totalItems - bundledItems);
    return loose > 0 ? `${base} + ${loose} more` : base;
  }
  if (totalItems > 1) return `${firstServiceName} + ${totalItems - 1} more`;
  return firstServiceName;
}

/**
 * 查库 + 拼接。`firstServiceName` 由调用方按既有方式取（`pickText(row.service_name, 'en', …)`），
 * 取不到任何套餐 / 多项目信息时原样返回它，行为与改动前一致。
 */
export async function appointmentServiceLabel(
  tx: postgres.TransactionSql,
  locationId: string,
  appointmentId: string,
  firstServiceName: string,
): Promise<string> {
  const bundleRows = await tx<{ name_snapshot: unknown }[]>`
    select name_snapshot from order_bundle_instances
    where appointment_id = ${appointmentId} and location_id = ${locationId} and status = 'active'
    order by created_at`;
  const [counts] = await tx<{ total: number; bundled: number }[]>`
    select count(*)::int as total,
           count(*) filter (where bundle_instance_id is not null)::int as bundled
    from appointment_items
    where appointment_id = ${appointmentId} and status <> 'cancelled'`;

  return composeServiceLabel({
    bundleNames: bundleRows.map((r) => pickText(r.name_snapshot, 'en', 'Bundle')),
    totalItems: counts?.total ?? 1,
    bundledItems: counts?.bundled ?? 0,
    firstServiceName,
  });
}
