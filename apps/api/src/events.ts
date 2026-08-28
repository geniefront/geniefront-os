/**
 * 领域事件广播（01-ARCHITECTURE §6，决策 13）
 *
 * 前台派单 → 技师手机秒级响铃；技师点完成 → 前台轮牌板同时更新。
 *
 * **扇出在 Supabase Realtime 侧完成**，两台应用实例之间零协调 ——
 * 这是选 Realtime 而不是自建 WebSocket 的唯一理由，也是充分理由（宪法第 10 条）。
 *
 * 两条纪律：
 *
 * 1. **事件只带 id + 类型 + 版本，不带业务数据。**
 *    前端收到后精准 invalidate 重新拉取，走的还是那条有 RLS 的读接口。
 *    往事件里塞客人姓名手机号，等于给自己开了一个绕过 RLS 的后门 ——
 *    而且是个没人会去审计的后门。
 *
 * 2. **在业务事务内发**，不是提交之后发。
 *    `realtime.send()` 往 realtime.messages 插一行，事务回滚它跟着回滚。
 *    于是永远不会出现「技师手机响了但那张单不存在」，
 *    也不会出现「提交成功但发事件那一刻进程挂了，事件永久丢失」。
 */

import type postgres from 'postgres';
import { jsonb } from '@gf/db';

export type DomainEventType =
  | 'ticket.assigned'    // 派单：技师端要响铃 + 震动 + 翻卡片
  | 'ticket.changed'     // 加钟/加项/开始/完成/结账/作废
  | 'rotation.changed'   // 轮牌顺序变了
  | 'appointment.changed'
  | 'dayclose.changed'
  | 'shift.changed'
  | 'staff.changed'
  | 'customer.changed'
  | 'sms.sent'
  /** 电话 AI 往复核队列放了一条 —— 前台那个「待复核 (N)」角标要当场跳（决策 6） */
  | 'call.drafted'
  /** 走单队列变了（取号 / 叫号 / 入座 / 离开）—— 前台那块屏要当场跳 */
  | 'queue.changed';

export interface DomainEvent {
  type: DomainEventType;
  /** 受影响的实体 id。前端据此决定 invalidate 哪些 query */
  entityId?: string;
  /** 派单事件专用：这一单派给了谁。技师端只对自己的那条响铃 */
  membershipId?: string;
  /** 营业日，前端用来判断这条事件是不是自己正在看的那一天 */
  businessDate?: string;
}

/**
 * 发一条事件到 `location:{id}` 频道。
 *
 * ⚠️ 必须传业务事务的 tx —— 用别的连接发就失去了「回滚即撤销」这个性质，
 * 那正是把广播放进事务里的全部意义。
 *
 * 广播失败**不该让业务失败**：技师手机没响是退化，不是事故；
 * 而把一张已经开好的单回滚掉才是事故（Desk-Only 模式下前台根本不需要这条事件）。
 * 所以这里吞掉异常，只在日志里留痕。
 */
export async function emit(
  tx: postgres.TransactionSql,
  locationId: string,
  event: DomainEvent,
  log?: { warn: (o: unknown, m: string) => void },
): Promise<void> {
  try {
    // 走 public.gf_broadcast 而不是直接 realtime.send：
    // realtime.messages 的 owner 不是我们，app_user 拿不到它的表权限，
    // 只能通过那个 SECURITY DEFINER 包装函数进去（见 sql/0012）
    await tx`select public.gf_broadcast(
      ${locationId}::uuid, ${event.type}, ${jsonb(event)}::jsonb)`;
  } catch (e) {
    log?.warn({ err: e, locationId, type: event.type }, 'realtime broadcast failed');
  }
}
