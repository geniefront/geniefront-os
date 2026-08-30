/**
 * Queue complete-service orchestration.
 *
 * Notes go through `ticket.saveServiceNote`. Room cleaning goes through
 * `resource.beginCleaning` after `ticket.finishItem` has released the
 * occupancy (`cleaning_required`). Success is only returned when every
 * requested step succeeded.
 */
import type { TicketSummary } from '@/features/tickets/types';

export interface CompleteServiceAddOn {
  idempotencyKey: string;
  serviceId: string;
  staffId: string;
  durationMin: number;
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
  if (input.markRoomCleaning && !input.roomId) {
    return { ok: false, reason: 'missing_room' };
  }

  const ticket = input.rawTicket;
  let subtotalCents = ticket.subtotalCents;
  const addedTicketItems: Array<{ ticketItemId: string; membershipId: string }> = [];

  try {
    for (const addOn of input.addedAddOns) {
      const added = await commands.addItem({
        ticketId: ticket.ticketId,
        serviceId: addOn.serviceId,
        membershipId: addOn.staffId,
        kind: 'addon',
        minutes: addOn.durationMin,
        idempotencyKey: addOn.idempotencyKey,
      });
      subtotalCents = added.subtotalCents;
      addedTicketItems.push({ ticketItemId: added.ticketItemId, membershipId: addOn.staffId });
    }
  } catch (cause) {
    return { ok: false, reason: 'command_failed', step: 'addOn', cause };
  }

  const unfinished = [
    ...ticket.items
      .filter((ticketItem) => ticketItem.startedAt && !ticketItem.finishedAt)
      .map((ticketItem) => ({
        ticketItemId: ticketItem.ticketItemId,
        membershipId: ticketItem.membershipId,
      })),
    ...addedTicketItems,
  ];
  if (unfinished.length === 0) {
    return { ok: false, reason: 'no_active_service' };
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
    } catch (cause) {
      return { ok: false, reason: 'command_failed', step: 'note', cause };
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
      actualMinutes += finished.actualMinutes;
      ticketDone = finished.ticketDone;
    }
  } catch (cause) {
    return { ok: false, reason: 'command_failed', step: 'finish', cause };
  }

  if (input.markRoomCleaning && input.roomId) {
    try {
      await commands.beginCleaning({ resourceId: input.roomId });
    } catch (cause) {
      return {
        ok: false,
        reason: 'command_failed',
        step: 'cleaning',
        cause,
        finished: true,
        actualMinutes,
        ticketDone,
        subtotalCents,
      };
    }
  }

  return { ok: true, actualMinutes, ticketDone, subtotalCents };
}
