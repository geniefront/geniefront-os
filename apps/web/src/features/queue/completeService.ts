/**
 * Queue complete-service orchestration.
 *
 * Notes go through `ticket.saveServiceNote`. Room cleaning goes through
 * `resource.beginCleaning` after `ticket.finishItem` has released the
 * occupancy (`cleaning_required`). Success is only returned when every
 * requested step succeeded.
 */
import { queueTicketItems } from './ticketItems';
import type { TicketSummary } from '@/features/tickets/types';

export interface CompleteServiceAddOn {
  idempotencyKey: string;
  serviceId: string;
  staffId: string;
  durationMin: number;
  /** 已经写进单据的那一条。见 `AddOnItem.sentTicketItemId`；有值就不再重发。 */
  sentTicketItemId?: string;
}

export interface CompleteServiceCommands {
  addItem: (input: {
    ticketId: string;
    serviceId: string;
    membershipId: string;
    kind: 'addon';
    minutes: number;
    idempotencyKey: string;
  }) => Promise<{ ticketItemId: string; subtotalCents: number }>;
  saveNote: (input: {
    ticketItemId: string;
    content: string;
    visibility: 'management' | 'assigned_staff';
    containsSensitiveData: boolean;
  }) => Promise<unknown>;
  startItem: (input: { ticketItemId: string; membershipId: string }) => Promise<unknown>;
  finishItem: (input: {
    ticketItemId: string;
    membershipId: string;
  }) => Promise<{ actualMinutes: number; ticketDone: boolean }>;
  beginCleaning: (input: { resourceId: string }) => Promise<unknown>;
  /**
   * 一条加项刚刚落库时回调。
   *
   * 调用方据此把这一条标成「已进单」，界面随即锁掉它的移除与改派 ——
   * 后面任何一步失败都不会再让前台把它删掉重选出一个新的幂等键。
   */
  onAddOnSent?: (idempotencyKey: string, ticketItemId: string) => void;
}

export interface CompleteServiceInput {
  rawTicket: TicketSummary | undefined;
  technicianNotes: string;
  markRoomCleaning: boolean;
  roomId: string | null | undefined;
  addedAddOns: CompleteServiceAddOn[];
}

export type CompleteServiceStep = 'addOn' | 'note' | 'start' | 'finish' | 'cleaning';

export type CompleteServiceResult =
  | {
      ok: true;
      actualMinutes: number;
      ticketDone: boolean;
      subtotalCents: number;
    }
  | {
      ok: false;
      reason: 'missing_ticket' | 'no_active_service' | 'missing_room' | 'command_failed';
      step?: CompleteServiceStep;
      cause?: unknown;
      finished?: boolean;
      actualMinutes?: number;
      ticketDone?: boolean;
      subtotalCents?: number;
      /**
       * 本次调用是否已经有命令成功落库。
       *
       * 调用方靠它决定失败后能不能把弹窗原样留着重试：一旦为 true，弹窗里的
       * `rawTicket` 快照就已经与服务端不符（典型情况是加项已经记进单据、
       * 完工却失败了），继续按快照操作会让前台把同一个加项再加一遍。
       */
      committed?: boolean;
    };

export function resolveQueueRoomId(
  item: {
    roomId?: string | null;
    rawItem?: { resourceId?: string | null } | null;
    rawTicket?: { ticketId: string } | null;
  },
  rooms: Array<{ id: string; currentSession?: { ticketId: string | null } | null }>,
): string | null {
  return item.roomId
    ?? item.rawItem?.resourceId
    ?? rooms.find((room) => room.currentSession?.ticketId === item.rawTicket?.ticketId)?.id
    ?? null;
}

export async function completeQueueService(
  input: CompleteServiceInput,
  commands: CompleteServiceCommands,
): Promise<CompleteServiceResult> {
  if (!input.rawTicket) {
    return { ok: false, reason: 'missing_ticket' };
  }
  const roomIds = [...new Set([input.roomId, ...input.rawTicket.items.map((item) => item.resourceId)]
    .filter((id): id is string => Boolean(id)))];
  if (input.markRoomCleaning && roomIds.length === 0) {
    return { ok: false, reason: 'missing_room' };
  }

  const ticket = input.rawTicket;
  let subtotalCents = ticket.subtotalCents;
  const addedTicketItems: Array<{ ticketItemId: string; membershipId: string }> = [];
  /** 已经有命令落库。失败时回传给调用方，决定还能不能按旧快照重试。 */
  let committed = false;

  try {
    for (const addOn of input.addedAddOns) {
      if (addOn.sentTicketItemId) {
        addedTicketItems.push({ ticketItemId: addOn.sentTicketItemId, membershipId: addOn.staffId });
        continue;
      }
      const added = await commands.addItem({
        ticketId: ticket.ticketId,
        serviceId: addOn.serviceId,
        membershipId: addOn.staffId,
        kind: 'addon',
        minutes: addOn.durationMin,
        idempotencyKey: addOn.idempotencyKey,
      });
      committed = true;
      commands.onAddOnSent?.(addOn.idempotencyKey, added.ticketItemId);
      subtotalCents = added.subtotalCents;
      addedTicketItems.push({ ticketItemId: added.ticketItemId, membershipId: addOn.staffId });
    }
  } catch (cause) {
    return { ok: false, reason: 'command_failed', step: 'addOn', cause, committed };
  }

  const unfinished = [
    ...queueTicketItems(ticket.items)
      .filter((ticketItem) => !ticketItem.finishedAt)
      .map((ticketItem) => ({
        ticketItemId: ticketItem.ticketItemId,
        membershipId: ticketItem.membershipId,
      })),
    ...addedTicketItems,
  ];
  if (unfinished.length === 0) {
    return { ok: false, reason: 'no_active_service', committed };
  }

  const noteContent = input.technicianNotes.trim();
  if (noteContent) {
    const noteTarget = unfinished[0]!;
    try {
      await commands.saveNote({
        ticketItemId: noteTarget.ticketItemId,
        content: noteContent,
        visibility: 'management',
        containsSensitiveData: true,
      });
      committed = true;
    } catch (cause) {
      return { ok: false, reason: 'command_failed', step: 'note', cause, committed };
    }
  }

  let actualMinutes = 0;
  let ticketDone = false;
  try {
    for (const ticketItem of unfinished) {
      if (addedTicketItems.some((added) => added.ticketItemId === ticketItem.ticketItemId)) {
        await commands.startItem({
          ticketItemId: ticketItem.ticketItemId,
          membershipId: ticketItem.membershipId,
        });
      }
      const finished = await commands.finishItem({
        ticketItemId: ticketItem.ticketItemId,
        membershipId: ticketItem.membershipId,
      });
      committed = true;
      actualMinutes += finished.actualMinutes;
      ticketDone = finished.ticketDone;
    }
  } catch (cause) {
    return { ok: false, reason: 'command_failed', step: 'finish', cause, committed };
  }

  if (input.markRoomCleaning) {
    try {
      for (const resourceId of roomIds) await commands.beginCleaning({ resourceId });
    } catch (cause) {
      return {
        ok: false,
        reason: 'command_failed',
        step: 'cleaning',
        cause,
        committed: true,
        finished: true,
        actualMinutes,
        ticketDone,
        subtotalCents,
      };
    }
  }

  return { ok: true, actualMinutes, ticketDone, subtotalCents };
}
