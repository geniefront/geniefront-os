import { expect, it } from 'vitest';
import { queueTicketItems } from './ticketItems';

it('keeps one service action and amount while displaying every assigned staff member', () => {
  const item = { ticketItemId: 'item', name: 'Massage', totalCents: 8500, durationMin: 60,
    startedAt: null, finishedAt: null, staffName: 'Amy', membershipId: 'amy' };
  expect(queueTicketItems([item, { ...item, staffName: 'Bo', membershipId: 'bo' }])).toEqual([
    { ...item, staffName: 'Amy / Bo' },
  ]);
  expect(item.staffName).toBe('Amy');
});
