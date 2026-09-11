import { describe, expect, it } from 'vitest';
import type { RoomItem } from '@/features/rooms/types';
import { assignDefaultRooms, pickDefaultRoomId, roomSeatability } from './roomAvailability';

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

/*
 * 服务端 `assertResourceStaffLimit()` 数的是一间房里所有在用项目的 distinct
 * 技师数。门店里最常见的 `max_staff = 1` 单人包厢放不下「三个项目、三位技师」
 * 的一家三口 —— 而此前所有项目一律默认同一间房，这种单子在确认那一步必然
 * 半途失败：前两项开工、第三项被拒，工单却已经开出来了。
 */
describe('assignDefaultRooms', () => {
  it('三位技师、三间单人房 —— 各占一间', () => {
    const rooms = [
      room({ id: 'r1', maxStaff: 1 }), room({ id: 'r2', maxStaff: 1 }), room({ id: 'r3', maxStaff: 1 }),
    ];
    expect(assignDefaultRooms([{ staffIds: ['a'] }, { staffIds: ['b'] }, { staffIds: ['c'] }], rooms))
      .toEqual(['r1', 'r2', 'r3']);
  });

  it('同一位技师的多个项目仍然并在同一间，不把一位客人拆到几个位子上', () => {
    const rooms = [room({ id: 'r1', maxStaff: 1 }), room({ id: 'r2', maxStaff: 1 })];
    expect(assignDefaultRooms([{ staffIds: ['a'] }, { staffIds: ['a'] }], rooms)).toEqual(['r1', 'r1']);
  });

  it('大房能容纳多位技师时就并进同一间', () => {
    const rooms = [room({ id: 'hall', capacity: 3, maxStaff: 3 }), room({ id: 'r2', maxStaff: 1 })];
    expect(assignDefaultRooms([{ staffIds: ['a'] }, { staffIds: ['b'] }, { staffIds: ['c'] }], rooms))
      .toEqual(['hall', 'hall', 'hall']);
  });

  it('没有上限配置时不受技师数约束', () => {
    const rooms = [room({ id: 'r1', maxStaff: null })];
    expect(assignDefaultRooms([{ staffIds: ['a'] }, { staffIds: ['b'] }], rooms)).toEqual(['r1', 'r1']);
  });

  /* 塞一间必然被服务端拒掉的房，比留空更糟：留空是门店里成立的状态。 */
  it('房不够时留空，而不是塞一间必然被拒的房', () => {
    const rooms = [room({ id: 'r1', maxStaff: 1 })];
    expect(assignDefaultRooms([{ staffIds: ['a'] }, { staffIds: ['b'] }], rooms)).toEqual(['r1', '']);
  });

  it('接不了客的房不参与分配', () => {
    const rooms = [room({ id: 'dirty', maxStaff: 1, waitingCleaningCount: 1 }), room({ id: 'ok', maxStaff: 1 })];
    expect(assignDefaultRooms([{ staffIds: ['a'] }], rooms)).toEqual(['ok']);
  });

  it('双技师协作的单项也按两位算', () => {
    const rooms = [room({ id: 'r1', maxStaff: 1 }), room({ id: 'big', maxStaff: 2 })];
    expect(assignDefaultRooms([{ staffIds: ['a', 'b'] }], rooms)).toEqual(['big']);
  });
});
