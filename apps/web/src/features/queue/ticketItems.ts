import type { TicketItem } from '@/features/tickets/types';

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
