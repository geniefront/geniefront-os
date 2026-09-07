import { describe, expect, it } from 'vitest';
import { queueNextAction } from './nextAction';
import type { QueueNextActionInput, QueueNextActionItem } from './nextAction';
import type { CheckoutTiming } from '@/features/tickets/types';

const item = (id: string, started: boolean, finished: boolean): QueueNextActionItem => ({
  ticketItemId: id,
  startedAt: started ? '2026-09-06T18:00:00Z' : null,
  finishedAt: finished ? '2026-09-06T19:00:00Z' : null,
});

/** 两个项目：第一项按参数取状态，第二项固定为「未开始」，用于验证多项目单不会漏项。 */
const ticketOf = (
  timing: CheckoutTiming,
  facts: { serviceSettled?: boolean; tipSettled?: boolean },
  items: QueueNextActionItem[],
): QueueNextActionInput['ticket'] => ({
  checkoutTiming: timing,
  serviceSettledAt: facts.serviceSettled ? '2026-09-06T18:05:00Z' : null,
  tipSettledAt: facts.tipSettled ? '2026-09-06T19:05:00Z' : null,
  serviceCompleted: items.length > 0 && items.every((entry) => entry.finishedAt !== null),
  items,
});

describe('queueNextAction', () => {
  it('未开单的卡片按看板阶段给出签到与入座', () => {
    expect(queueNextAction({ stage: 'booked', ticket: null })).toEqual({ kind: 'check_in' });
    expect(queueNextAction({ stage: 'waiting', ticket: null })).toEqual({ kind: 'seat' });
  });

  it('已开单但工单事实缺失时不渲染按钮，而是说明原因', () => {
    expect(queueNextAction({ stage: 'in_service', ticket: null }))
      .toEqual({ kind: 'blocked', reasonKey: 'queue.quNextBlockedNoTicket' });
  });

  it('已归档卡片没有下一步', () => {
    expect(queueNextAction({ stage: 'completed', ticket: null }))
      .toEqual({ kind: 'blocked', reasonKey: 'queue.quNextBlockedArchived' });
  });

  describe('service_then_tip', () => {
    it('开工前先收服务款', () => {
      const ticket = ticketOf('service_then_tip', {}, [item('a', false, false), item('b', false, false)]);
      expect(queueNextAction({ stage: 'in_service', ticket })).toEqual({ kind: 'pay_service' });
    });

    it('服务款已收后推进未开始的项目', () => {
      const ticket = ticketOf('service_then_tip', { serviceSettled: true }, [
        item('a', true, true),
        item('b', false, false),
      ]);
      expect(queueNextAction({ stage: 'in_service', ticket }))
        .toEqual({ kind: 'start_item', ticketItemId: 'b' });
    });

    it('项目全部开始后推进完工', () => {
      const ticket = ticketOf('service_then_tip', { serviceSettled: true }, [
        item('a', true, true),
        item('b', true, false),
      ]);
      expect(queueNextAction({ stage: 'in_service', ticket }))
        .toEqual({ kind: 'finish_item', ticketItemId: 'b' });
    });

    it('全部完工后收小费', () => {
      const ticket = ticketOf('service_then_tip', { serviceSettled: true }, [
        item('a', true, true),
        item('b', true, true),
      ]);
      expect(queueNextAction({ stage: 'ready_checkout', ticket })).toEqual({ kind: 'pay_tip' });
    });

    it('小费也收完后没有下一步', () => {
      const ticket = ticketOf('service_then_tip', { serviceSettled: true, tipSettled: true }, [
        item('a', true, true),
      ]);
      expect(queueNextAction({ stage: 'ready_checkout', ticket }))
        .toEqual({ kind: 'blocked', reasonKey: 'queue.quNextBlockedSettled' });
    });

    it('从未预收服务款却已完工时退化为一次性收款', () => {
      const ticket = ticketOf('service_then_tip', {}, [item('a', true, true)]);
      expect(queueNextAction({ stage: 'ready_checkout', ticket })).toEqual({ kind: 'pay_combined' });
    });
  });

  describe('upfront_combined', () => {
    it('开工前先收全款', () => {
      const ticket = ticketOf('upfront_combined', {}, [item('a', false, false)]);
      expect(queueNextAction({ stage: 'in_service', ticket })).toEqual({ kind: 'pay_combined' });
    });

    it('收款后回到项目推进', () => {
      const ticket = ticketOf('upfront_combined', { serviceSettled: true, tipSettled: true }, [
        item('a', false, false),
      ]);
      expect(queueNextAction({ stage: 'in_service', ticket }))
        .toEqual({ kind: 'start_item', ticketItemId: 'a' });
    });

    it('完工即结清，不再出现收银按钮', () => {
      const ticket = ticketOf('upfront_combined', { serviceSettled: true, tipSettled: true }, [
        item('a', true, true),
      ]);
      expect(queueNextAction({ stage: 'ready_checkout', ticket }))
        .toEqual({ kind: 'blocked', reasonKey: 'queue.quNextBlockedSettled' });
    });
  });

  describe('after_service_combined', () => {
    it('未完工时只推进项目，不出现收款入口', () => {
      const ticket = ticketOf('after_service_combined', {}, [
        item('a', true, true),
        item('b', false, false),
      ]);
      expect(queueNextAction({ stage: 'in_service', ticket }))
        .toEqual({ kind: 'start_item', ticketItemId: 'b' });
    });

    it('全部完工后一次性收款', () => {
      const ticket = ticketOf('after_service_combined', {}, [
        item('a', true, true),
        item('b', true, true),
      ]);
      expect(queueNextAction({ stage: 'ready_checkout', ticket })).toEqual({ kind: 'pay_combined' });
    });
  });
});
