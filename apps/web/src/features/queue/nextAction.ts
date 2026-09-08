/**
 * 运营看板卡片「主按钮」的唯一真值来源。
 *
 * 看板此前把主按钮直接绑在列上：在「服务中」列就一定显示「完工核算账单」，
 * 在「待收银」列就一定显示「结算收银出票」。门店一旦把结账时机设为
 * `service_then_tip`，这两个按钮都会向服务端发出当前阶段并不接受的命令，
 * 前台只能看到一句无法据以行动的校验失败。
 *
 * 现改为由本函数按工单事实推导下一步。阶段判定复用 `paymentStageFor()`，
 * 不在看板里另写一套 —— 收银页与看板对「现在能不能收、收哪一笔」必须给出
 * 完全一致的答案，否则同一张单在两个页面上会出现两种说法。
 */
import { paymentStageFor } from '@/features/checkout/types';
import type { PaymentStageFacts } from '@/features/checkout/types';
import type { TranslationKey } from '@/i18n';

/**
 * 看板 / 详情主按钮文案。一次性收款在两种结账时机下语义不同：
 * `upfront_combined` 开工前预收，`after_service_combined` 做完再结，文案必须区分。
 */
export function nextActionLabelKey(
  action: QueueNextAction,
  ctx?: { checkoutTiming?: string | null },
): TranslationKey {
  switch (action.kind) {
    case 'check_in': return 'queue.quCheckInGuest';
    case 'seat': return 'queue.quWiAssignSeat';
    case 'start_item': return 'queue.quStartItem';
    case 'finish_item': return 'queue.quFinishAndBill';
    case 'pay_service': return 'queue.quPayServiceBtn';
    case 'pay_tip': return 'queue.quPayTipBtn';
    case 'pay_combined':
      return ctx?.checkoutTiming === 'upfront_combined'
        ? 'queue.quPayUpfrontBtn'
        : 'queue.quSettleAndPrint';
    case 'blocked': return action.reasonKey;
  }
}

/** 卡片所处的看板阶段。与 `Queue.tsx` 的 `KanbanStage` 取值一致。 */
export type QueueNextActionStage =
  | 'booked'
  | 'waiting'
  | 'in_service'
  | 'ready_checkout'
  | 'completed';

/** 判定所需的项目事实。取自 `ticket_items`，前端不再自行推断开始与完工。 */
export interface QueueNextActionItem {
  ticketItemId: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface QueueNextActionInput {
  stage: QueueNextActionStage;
  /** 尚未开单时为 `null`（预约或候客区卡片）。 */
  ticket: (PaymentStageFacts & { items: QueueNextActionItem[] }) | null;
}

export type QueueNextAction =
  | { kind: 'check_in' }
  | { kind: 'seat' }
  | { kind: 'pay_service' }
  | { kind: 'start_item'; ticketItemId: string }
  | { kind: 'finish_item'; ticketItemId: string }
  | { kind: 'pay_tip' }
  | { kind: 'pay_combined' }
  | { kind: 'blocked'; reasonKey: TranslationKey };

/**
 * 推导这张卡片的下一步。
 *
 * 判定顺序刻意与前台的实际动线一致：
 * 1. 未到店先签到，已到店先入座 —— 这两步没有工单，不涉及收款阶段；
 * 2. 需要预收的门店先收款。`service_then_tip` 的服务款必须在开工前收，
 *    `upfront_combined` 的全额同理，此时把主按钮让给收款；
 * 3. 还有未完工的项目就推进项目：先开始未开始的，再完成进行中的。
 *    多项目单正是卡在这一步 —— 只按整单推进会让第二项永远没有入口；
 * 4. 全部完工后按阶段收尾款。
 *
 * 判定不出可执行动作时返回 `blocked` 并附带原因文案，而不是渲染一个
 * 点下去必然失败的按钮。
 */
export function queueNextAction(input: QueueNextActionInput): QueueNextAction {
  if (input.stage === 'booked') return { kind: 'check_in' };
  if (input.stage === 'waiting') return { kind: 'seat' };
  if (input.stage === 'completed') return { kind: 'blocked', reasonKey: 'queue.quNextBlockedArchived' };

  const ticket = input.ticket;
  if (!ticket) return { kind: 'blocked', reasonKey: 'queue.quNextBlockedNoTicket' };

  const stage = paymentStageFor(ticket);

  // 先服务后小费：服务款是开工的前置条件，此时不引导前台去开始项目。
  if (stage === 'service') return { kind: 'pay_service' };
  // 先收全款：同理，收完才开工；完工后由服务端自动结清，不再出现收银按钮。
  if (stage === 'combined' && ticket.checkoutTiming === 'upfront_combined') {
    return { kind: 'pay_combined' };
  }

  const pending = ticket.items.filter((item) => !item.finishedAt);
  const notStarted = pending.find((item) => !item.startedAt);
  if (notStarted) return { kind: 'start_item', ticketItemId: notStarted.ticketItemId };
  const running = pending[0];
  if (running) return { kind: 'finish_item', ticketItemId: running.ticketItemId };

  if (stage === 'tip') return { kind: 'pay_tip' };
  if (stage === 'combined') return { kind: 'pay_combined' };

  /*
   * 全部完工却没有可用的收款阶段，只有两种情况：钱已经收齐（等待归档），
   * 或门店设置与工单既有收款记录不相容。两者都必须说清楚 ——
   * 前者不需要前台做任何事，后者需要前台去收银页处理。
   */
  const settled = Boolean(ticket.serviceSettledAt) && Boolean(ticket.tipSettledAt);
  return {
    kind: 'blocked',
    reasonKey: settled ? 'queue.quNextBlockedSettled' : 'queue.quNextBlockedNoStage',
  };
}
