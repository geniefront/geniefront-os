/**
 * 这个工位现在能不能接下一项服务。
 *
 * 判定与服务端 `occupyServiceResource()` 一一对应，抄在前端只有一个目的：
 * 不要把一个必然被拒的选项摆给前台。此前入座弹窗的工位下拉框把全部房间
 * 原样列出来，占用中、待清洁、停用检修一律可选，界面上只在名字后面缀一句
 * 「占用中」。前台选中它、填完整张表、点确认，服务端才回一句 RESOURCE_CONFLICT
 * —— 而那时候工单已经开出来了。
 *
 * ⚠️ 这里只是「别让她选一个必输的选项」。真正的闸门始终在服务端：两台前台
 * 机器同时选中同一间房时，本地这份快照挡不住任何东西。
 */
import type { RoomItem } from '@/features/rooms/types';
import type { TranslationKey } from '@/i18n';

export type RoomSeatability =
  /** 可以接客。 */
  | 'seatable'
  /** 待清洁或正在清洁 —— 服务端拒绝在脏工位上开工。 */
  | 'cleaning'
  /** 停用检修。 */
  | 'maintenance'
  /** 并发占用已达容量上限。 */
  | 'full';

export interface RoomSeatabilityContext {
  /**
   * 本次要占用这个工位的工单。
   *
   * 服务端在同一张单已经占着这个工位时不再判容量（同一位客人的多个项目、
   * 双技师服务里的另一项，占的都是同一个位置）。换工位、加项这类「单已经
   * 存在」的场景必须传，否则会把客人自己正在用的那间房判成已满。
   */
  ticketId?: string | null;
}

export function roomSeatability(room: RoomItem, ctx: RoomSeatabilityContext = {}): RoomSeatability {
  if (room.status === 'maintenance' || room.rawStatus === 'maintenance') return 'maintenance';
  /*
   * 三个来源都要看：`status` 是服务端算好的展示态（`cleaning_required` 已经
   * 被折叠成 `cleaning`），两个计数则是挂在这个工位上、尚未清完的占用记录 ——
   * 工位本身可能已经改回 available，但只要还有一条脏占用，开工就会被拒。
   */
  if (room.status === 'cleaning'
    || room.rawStatus === 'cleaning' || room.rawStatus === 'cleaning_required'
    || (room.waitingCleaningCount ?? 0) > 0
    || (room.cleaningCount ?? 0) > 0) {
    return 'cleaning';
  }

  const sessions = room.currentSessions ?? (room.currentSession ? [room.currentSession] : []);
  if (ctx.ticketId && sessions.some((session) => session.ticketId === ctx.ticketId)) {
    return 'seatable';
  }

  const occupied = room.occupiedCount
    ?? new Set(sessions.map((session) => session.ticketId)).size;
  return occupied >= room.capacity ? 'full' : 'seatable';
}

/** 下拉选项后缀的词典键。可用时不加后缀 —— 没有信息的括号只是噪音。 */
export const ROOM_SEATABILITY_LABEL_KEYS: Record<Exclude<RoomSeatability, 'seatable'>, TranslationKey> = {
  cleaning: 'queue.quRoomOptionCleaning',
  maintenance: 'queue.quRoomOptionMaintenance',
  full: 'queue.quRoomOptionFull',
};

/**
 * 默认工位：第一个真正能接客的。
 *
 * 此前是 `rooms.find((r) => r.status === 'available')`，两个问题：一是它不看
 * 待清洁与容量，二是同一份 `rooms` 快照会给**每一张卡、每一个项目**选出同一
 * 间房（房态每 15 秒才刷新一次）。于是连着安排两位客人时，第二位默认选中的
 * 就是第一位刚占掉的那间。`taken` 用来排掉本次已经分出去的。
 */
export function pickDefaultRoomId(
  rooms: RoomItem[],
  taken: ReadonlySet<string> = new Set(),
  ctx: RoomSeatabilityContext = {},
): string {
  return rooms.find((room) => !taken.has(room.id) && roomSeatability(room, ctx) === 'seatable')?.id ?? '';
}
