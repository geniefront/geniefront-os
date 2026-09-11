import { describe, expect, it } from 'vitest';
import type { RoomItem } from '@/features/rooms/types';
import { pickDefaultRoomId, roomSeatability } from './roomAvailability';

function room(overrides: Partial<RoomItem> = {}): RoomItem {
  return {
    id: 'room-1',
    name: 'Room 1',
    type: 'room',
    typeKey: 'room',
    capacity: 1,
    status: 'available',
    currentSessions: [],
    occupiedCount: 0,
    rawStatus: 'available',
    waitingCleaningCount: 0,
    cleaningCount: 0,
    ...overrides,
  };
}

describe('roomSeatability', () => {
  it('accepts a clean, free station', () => {
    expect(roomSeatability(room())).toBe('seatable');
  });

  it.each([
    ['status cleaning', { status: 'cleaning' as const }],
    ['rawStatus cleaning_required', { rawStatus: 'cleaning_required' }],
    // 工位本身已经改回 available，但还挂着一条没清完的占用 —— 服务端照样拒绝开工。
    ['a pending cleaning occupancy', { waitingCleaningCount: 1 }],
    ['an in-progress cleaning occupancy', { cleaningCount: 1 }],
  ])('refuses a station with %s', (_label, overrides) => {
    expect(roomSeatability(room(overrides))).toBe('cleaning');
  });

  it('refuses a station under maintenance', () => {
    expect(roomSeatability(room({ status: 'maintenance' }))).toBe('maintenance');
  });

  it('refuses a station whose concurrent occupancy is at capacity', () => {
    expect(roomSeatability(room({ status: 'in_service', capacity: 2, occupiedCount: 2 }))).toBe('full');
    expect(roomSeatability(room({ status: 'in_service', capacity: 2, occupiedCount: 1 }))).toBe('seatable');
  });

  it('does not count the ticket against itself', () => {
    const occupied = room({
      status: 'in_service',
      capacity: 1,
      occupiedCount: 1,
      currentSessions: [{
        appointmentId: null, ticketId: 'ticket-1', customerName: 'Guest', staffNames: [],
        serviceName: 'Massage', startedAt: null, estimatedEndAt: null,
        progressMinutes: 0, totalMinutes: 60,
      }],
    });
    expect(roomSeatability(occupied)).toBe('full');
    expect(roomSeatability(occupied, { ticketId: 'ticket-1' })).toBe('seatable');
    expect(roomSeatability(occupied, { ticketId: 'ticket-2' })).toBe('full');
  });

  it('falls back to counting distinct tickets when occupiedCount is absent', () => {
    const session = {
      appointmentId: null, ticketId: 'ticket-1', customerName: 'Guest', staffNames: [],
      serviceName: 'Massage', startedAt: null, estimatedEndAt: null,
      progressMinutes: 0, totalMinutes: 60,
    };
    const bare = room({ capacity: 1, occupiedCount: undefined, currentSessions: [session, session] });
    expect(roomSeatability(bare)).toBe('full');
  });
});

describe('pickDefaultRoomId', () => {
  it('skips stations that cannot take a guest', () => {
    const rooms = [
      room({ id: 'dirty', waitingCleaningCount: 1 }),
      room({ id: 'broken', status: 'maintenance' }),
      room({ id: 'free' }),
    ];
    expect(pickDefaultRoomId(rooms)).toBe('free');
  });

  /*
   * 房态每 15 秒才刷新一次。同一份快照给连着安排的两位客人推荐同一间房，
   * 第二位在确认那一步必然撞 RESOURCE_CONFLICT —— 而那时候单已经开出来了。
   */
  it('skips stations already handed out in this pass', () => {
    const rooms = [room({ id: 'a' }), room({ id: 'b' })];
    expect(pickDefaultRoomId(rooms)).toBe('a');
    expect(pickDefaultRoomId(rooms, new Set(['a']))).toBe('b');
    expect(pickDefaultRoomId(rooms, new Set(['a', 'b']))).toBe('');
  });

  it('returns an empty string when nothing is seatable', () => {
    expect(pickDefaultRoomId([room({ status: 'cleaning' })])).toBe('');
    expect(pickDefaultRoomId([])).toBe('');
  });
});
