import type { TicketItem, TicketBundle } from '@/features/tickets/types';

/** The desk query returns one row per staff assignment; actions target a service only once. */
export function queueTicketItems(items: TicketItem[]): TicketItem[] {
  const grouped = new Map<string, TicketItem>();
  for (const item of items) {
    const previous = grouped.get(item.ticketItemId);
    grouped.set(item.ticketItemId, previous
      ? { ...previous, staffName: [...new Set([previous.staffName, item.staffName].filter(Boolean))].join(' / ') }
      : { ...item });
  }
  return [...grouped.values()];
}

export interface TicketItemGroup {
  /** 非空表示这一组是一份组合套餐的子项（U10）。 */
  bundle: TicketBundle | null;
  items: TicketItem[];
}

/**
 * 把工单行按组合套餐实例分组（U10 / 计划 §7「看板卡片」）。
 *
 * 同一 `bundleInstanceId` 的行归为一组并带上该实例的进度信息；其余散项
 * 各自成组（`bundle: null`），保持原有渲染。分组保持传入顺序，套餐子项
 * 在其第一个子项出现的位置整体呈现。
 */
export function groupTicketItemsByBundle(
  items: TicketItem[],
  bundles: readonly TicketBundle[] = [],
): TicketItemGroup[] {
  const byInstance = new Map(bundles.map((b) => [b.instanceId, b]));
  const groups: TicketItemGroup[] = [];
  const bundleGroupIndex = new Map<string, number>();

  for (const item of items) {
    const instanceId = item.bundleInstanceId ?? null;
    if (instanceId && byInstance.has(instanceId)) {
      const existing = bundleGroupIndex.get(instanceId);
      if (existing !== undefined) {
        groups[existing]!.items.push(item);
      } else {
        bundleGroupIndex.set(instanceId, groups.length);
        groups.push({ bundle: byInstance.get(instanceId)!, items: [item] });
      }
    } else {
      groups.push({ bundle: null, items: [item] });
    }
  }
  return groups;
}
