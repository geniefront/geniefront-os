/**
 * 房间与资源领域只读工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadRooms } from '../../queries/rooms.js';

export async function listRooms(
  ctx: CommandContext,
  _input: Record<string, unknown>,
): Promise<unknown> {
  const result = await withTenant(ctx, (tx) => loadRooms(tx, ctx));
  return {
    metrics: result.metrics,
    rooms: result.rooms.map((r) => ({
      resourceId: r.id,
      name: r.name,
      capacity: r.capacity,
      status: r.status,
      currentUsage: r.occupiedCount,
    })),
  };
}
