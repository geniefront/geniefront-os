/**
 * 候客走单队列领域只读工具 (29 §6.2)
 */
import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { resolveDate } from '../../handlers/dayclose.js';
import { loadQueue } from '../../queries/queue.js';

export async function getQueueStatus(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  return withTenant(ctx, async (tx) => {
    const date = await resolveDate(tx, ctx.locationId, input['date'] ? String(input['date']) : undefined);
    const queue = await loadQueue(tx, ctx, date);
    return {
      businessDate: queue.businessDate,
      summary: queue.summary,
      waitingCount: queue.waiting.length,
      calledCount: queue.called.length,
      seatedCount: queue.seated.length,
      waitingList: queue.waiting.map((w) => ({
        ticketNumber: `#${w.ticketNumber}`,
        name: w.displayName,
        service: w.serviceName,
        staff: w.staffName,
        waitedMin: w.waitedMin,
        overdue: w.overdue,
        healthFormPending: w.pendingForms > 0,
      })),
      calledList: queue.called.map((c) => ({
        ticketNumber: `#${c.ticketNumber}`,
        name: c.displayName,
        service: c.serviceName,
        staff: c.staffName,
      })),
    };
  });
}
