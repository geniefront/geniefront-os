/**
 * 预约详情与运营看板共用的「当前业务状态 → 下一步动作」推导（U06 / §6.4）。
 *
 * 不新增字符串状态机：阶段判定复用看板的 `queueNextAction` / `paymentStageFor`，
 * 抽屉与看板对「现在能做什么、为什么不能做」给同一个答案。
 */
import { paymentStageFor, type PaymentStage } from '@/features/checkout/types';
import {
  queueNextAction,
  type QueueNextAction,
  type QueueNextActionStage,
} from '@/features/queue/nextAction';

export interface AppointmentBoardTicket {
  ticketId: string;
  number: number | null;
  status: string;
  checkoutTiming: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
  serviceSettledAt: string | null;
  tipSettledAt: string | null;
  serviceCompleted: boolean;
  items: Array<{ ticketItemId: string; name: string; startedAt: string | null; finishedAt: string | null }>;
}

export interface AppointmentBoardState {
  /** 与看板 `KanbanStage` / `QueueNextActionStage` 取值一致。 */
  stage: QueueNextActionStage;
  terminal: 'cancelled' | 'no_show' | null;
  /** 履约进度：已完工项 / 总项。用于「部分完成 N/M」。 */
  fulfillment: { done: number; total: number };
  /** 付款阶段；`null` = 当前无待收款项（未开单 / 已结清 / 尚未到收款窗口）。 */
  paymentStage: PaymentStage | null;
  /** 服务款与小费都已结清（或无需收款）。 */
  paid: boolean;
  /** 下一步主操作；`kind: 'blocked'` 时带不可执行原因。 */
  nextAction: QueueNextAction;
}

const CHECKED_IN_STATUSES = new Set(['checked_in', 'waiting', 'arrived', 'seated']);
const DONE_ITEM_STATUSES = new Set(['done', 'completed']);
const CLOSED_APPT_STATUSES = new Set(['completed', 'done', 'closed', 'paid']);

export function deriveAppointmentBoardState(input: {
  appointmentStatus: string | null | undefined;
  items: Array<{ status?: string | null }>;
  ticket: AppointmentBoardTicket | null;
}): AppointmentBoardState {
  const status = (input.appointmentStatus ?? '').toLowerCase();
  const ticket = input.ticket;

  if (status === 'cancelled' || status === 'no_show') {
    return {
      stage: 'completed',
      terminal: status as 'cancelled' | 'no_show',
      fulfillment: { done: 0, total: input.items.length },
      paymentStage: null,
      paid: false,
      nextAction: { kind: 'blocked', reasonKey: 'queue.quNextBlockedArchived' },
    };
  }

  const paymentFacts = ticket
    ? {
        checkoutTiming: ticket.checkoutTiming,
        serviceSettledAt: ticket.serviceSettledAt,
        tipSettledAt: ticket.tipSettledAt,
        serviceCompleted: ticket.serviceCompleted,
      }
    : null;
  const paymentStage = paymentFacts ? paymentStageFor(paymentFacts) : null;
  const paid = Boolean(
    ticket && paymentStage === null && (ticket.serviceSettledAt || ticket.tipSettledAt),
  );

  let stage: QueueNextActionStage;
  let fulfillment: { done: number; total: number };

  if (ticket) {
    const done = ticket.items.filter((item) => item.finishedAt).length;
    fulfillment = { done, total: ticket.items.length };
    const allDone = ticket.items.length > 0 && done === ticket.items.length;
    if (allDone) {
      stage = paymentStage === null ? 'completed' : 'ready_checkout';
    } else {
      stage = 'in_service';
    }
  } else {
    const done = input.items.filter((item) => DONE_ITEM_STATUSES.has((item.status ?? '').toLowerCase())).length;
    fulfillment = { done, total: input.items.length };
    if (CLOSED_APPT_STATUSES.has(status)) stage = 'completed';
    else if (CHECKED_IN_STATUSES.has(status)) stage = 'waiting';
    else stage = 'booked';
  }

  const nextAction = queueNextAction({
    stage,
    ticket: ticket
      ? {
          ...paymentFacts!,
          items: ticket.items.map((item) => ({
            ticketItemId: item.ticketItemId,
            startedAt: item.startedAt,
            finishedAt: item.finishedAt,
          })),
        }
      : null,
  });

  return { stage, terminal: null, fulfillment, paymentStage, paid, nextAction };
}
