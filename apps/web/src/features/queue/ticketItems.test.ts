import { expect, it } from 'vitest';
import { queueTicketItems, groupTicketItemsByBundle } from './ticketItems';
import type { TicketItem, TicketBundle } from '@/features/tickets/types';

it('keeps one service action and amount while displaying every assigned staff member', () => {
  const item = { ticketItemId: 'item', name: 'Massage', totalCents: 8500, durationMin: 60,
    startedAt: null, finishedAt: null, staffName: 'Amy', membershipId: 'amy' };
  expect(queueTicketItems([item, { ...item, staffName: 'Bo', membershipId: 'bo' }])).toEqual([
    { ...item, staffName: 'Amy / Bo' },
  ]);
  expect(item.staffName).toBe('Amy');
});

const mkItem = (over: Partial<TicketItem>): TicketItem => ({
  ticketItemId: 'x', name: 'S', totalCents: 1000, durationMin: 30,
  startedAt: null, finishedAt: null, staffName: 'Amy', membershipId: 'amy', ...over,
});
const mkBundle = (over: Partial<TicketBundle>): TicketBundle => ({
  instanceId: 'b1', name: 'Combo', bundlePriceCents: 15000, discountCents: 2000,
  extraDiscountCents: 0, unitCount: 3, doneCount: 1, fulfilled: false, status: 'active', ...over,
});

it('groupTicketItemsByBundle: 套餐子项聚成一组，散项各自成组，保持顺序', () => {
  const items = [
    mkItem({ ticketItemId: 'loose1' }),
    mkItem({ ticketItemId: 'u1', bundleInstanceId: 'b1' }),
    mkItem({ ticketItemId: 'u2', bundleInstanceId: 'b1' }),
    mkItem({ ticketItemId: 'loose2' }),
    mkItem({ ticketItemId: 'u3', bundleInstanceId: 'b1' }),
  ];
  const groups = groupTicketItemsByBundle(items, [mkBundle({ instanceId: 'b1' })]);
  expect(groups.map((g) => g.bundle?.instanceId ?? null)).toEqual([null, 'b1', null]);
  expect(groups[1]!.items.map((i) => i.ticketItemId)).toEqual(['u1', 'u2', 'u3']);
  expect(groups[2]!.items.map((i) => i.ticketItemId)).toEqual(['loose2']);
});

it('groupTicketItemsByBundle: 未知实例 id 当散项处理', () => {
  const groups = groupTicketItemsByBundle(
    [mkItem({ ticketItemId: 'u1', bundleInstanceId: 'ghost' })], [],
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]!.bundle).toBeNull();
});
