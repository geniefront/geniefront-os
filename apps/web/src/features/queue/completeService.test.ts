import { describe, expect, it, vi } from 'vitest';
import type { TicketSummary } from '@/features/tickets/types';
import {
  completeQueueService,
  resolveQueueRoomId,
  type CompleteServiceCommands,
} from './completeService';

function ticket(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    ticketId: 'ticket-1',
    appointmentId: 'appt-1',
    status: 'in_service',
    customerName: 'Guest',
    subtotalCents: 8500,
    groupId: null,
    groupLabel: null,
    businessDate: '2026-08-30',
    daysAgo: 0,
    items: [{
      ticketItemId: 'item-1',
      name: 'Massage',
      totalCents: 8500,
      durationMin: 60,
      startedAt: '2026-08-30T10:00:00Z',
      finishedAt: null,
      staffName: 'Lily',
      membershipId: 'staff-1',
    }],
    ...overrides,
  };
}

function commands(overrides: Partial<CompleteServiceCommands> = {}): CompleteServiceCommands {
  return {
    addItem: vi.fn().mockResolvedValue({ ticketItemId: 'addon-1', subtotalCents: 10000 }),
    saveNote: vi.fn().mockResolvedValue({ noteId: 'note-1', ticketItemId: 'item-1', updated: false }),
    startItem: vi.fn().mockResolvedValue({ ticketItemId: 'addon-1' }),
    finishItem: vi.fn().mockResolvedValue({ actualMinutes: 58, ticketDone: true }),
    beginCleaning: vi.fn().mockResolvedValue({ resourceId: 'room-1', status: 'cleaning' }),
    ...overrides,
  };
}

describe('resolveQueueRoomId', () => {
  it('prefers the kanban room, then the schedule resource, then the live room session', () => {
    expect(resolveQueueRoomId({ roomId: 'room-a' }, [])).toBe('room-a');
    expect(resolveQueueRoomId({ rawItem: { resourceId: 'room-b' } }, [])).toBe('room-b');
    expect(resolveQueueRoomId(
      { rawTicket: { ticketId: 'ticket-1' } },
      [{ id: 'room-c', currentSession: { ticketId: 'ticket-1' } }],
    )).toBe('room-c');
  });
});

describe('completeQueueService', () => {
  it('finishes the active item when there is no note and no room cleaning', async () => {
    const cmds = commands();
    const result = await completeQueueService({
      rawTicket: ticket(),
      technicianNotes: '',
      markRoomCleaning: false,
      roomId: 'room-1',
      addedAddOns: [],
    }, cmds);

    expect(result).toEqual({
      ok: true,
      actualMinutes: 58,
      ticketDone: true,
      subtotalCents: 8500,
    });
    expect(cmds.saveNote).not.toHaveBeenCalled();
    expect(cmds.beginCleaning).not.toHaveBeenCalled();
    expect(cmds.finishItem).toHaveBeenCalledWith({
      ticketItemId: 'item-1',
      membershipId: 'staff-1',
    });
  });

  it('persists a technician note before finishing', async () => {
    const cmds = commands();
    const result = await completeQueueService({
      rawTicket: ticket(),
      technicianNotes: '  pressure level four  ',
      markRoomCleaning: false,
      roomId: null,
      addedAddOns: [],
    }, cmds);

    expect(result.ok).toBe(true);
    expect(cmds.saveNote).toHaveBeenCalledWith({
      ticketItemId: 'item-1',
      content: 'pressure level four',
      visibility: 'management',
      containsSensitiveData: true,
    });
    expect(cmds.finishItem).toHaveBeenCalled();
  });

  it('marks the room for cleaning after the item is finished', async () => {
    const order: string[] = [];
    const cmds = commands({
      finishItem: vi.fn().mockImplementation(async () => {
        order.push('finish');
        return { actualMinutes: 58, ticketDone: true };
      }),
      beginCleaning: vi.fn().mockImplementation(async () => {
        order.push('cleaning');
        return { resourceId: 'room-1', status: 'cleaning' };
      }),
    });
    const result = await completeQueueService({
      rawTicket: ticket(),
      technicianNotes: '',
      markRoomCleaning: true,
      roomId: 'room-1',
      addedAddOns: [],
    }, cmds);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['finish', 'cleaning']);
    expect(cmds.beginCleaning).toHaveBeenCalledWith({ resourceId: 'room-1' });
  });

  it('persists a note and room cleaning together', async () => {
    const cmds = commands();
    const result = await completeQueueService({
      rawTicket: ticket(),
      technicianNotes: 'avoid left shoulder',
      markRoomCleaning: true,
      roomId: 'room-9',
      addedAddOns: [],
    }, cmds);

    expect(result.ok).toBe(true);
    expect(cmds.saveNote).toHaveBeenCalled();
    expect(cmds.beginCleaning).toHaveBeenCalledWith({ resourceId: 'room-9' });
  });

  it('does not finish when note persistence fails', async () => {
    const cmds = commands({
      saveNote: vi.fn().mockRejectedValue(new Error('note denied')),
    });
    const result = await completeQueueService({
      rawTicket: ticket(),
      technicianNotes: 'SOAP note',
      markRoomCleaning: true,
      roomId: 'room-1',
      addedAddOns: [],
    }, cmds);

    expect(result).toMatchObject({ ok: false, reason: 'command_failed', step: 'note' });
    expect(cmds.finishItem).not.toHaveBeenCalled();
    expect(cmds.beginCleaning).not.toHaveBeenCalled();
  });

  it('does not report success when room cleaning fails after finish', async () => {
    const cmds = commands({
      beginCleaning: vi.fn().mockRejectedValue(new Error('not waiting for cleaning')),
    });
    const result = await completeQueueService({
      rawTicket: ticket(),
      technicianNotes: '',
      markRoomCleaning: true,
      roomId: 'room-1',
      addedAddOns: [],
    }, cmds);

    expect(result).toMatchObject({
      ok: false,
      reason: 'command_failed',
      step: 'cleaning',
      finished: true,
    });
    expect(cmds.finishItem).toHaveBeenCalled();
  });

  it('refuses missing tickets without calling commands', async () => {
    const cmds = commands();
    const result = await completeQueueService({
      rawTicket: undefined,
      technicianNotes: 'note',
      markRoomCleaning: true,
      roomId: 'room-1',
      addedAddOns: [],
    }, cmds);

    expect(result).toEqual({ ok: false, reason: 'missing_ticket' });
    expect(cmds.finishItem).not.toHaveBeenCalled();
    expect(cmds.saveNote).not.toHaveBeenCalled();
  });
});
