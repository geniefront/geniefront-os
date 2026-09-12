import { expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { newGuest, registerGuests } from './walkIn';
vi.mock('../api/client', () => ({ api: { walkIn: vi.fn(), getRequiredForms: vi.fn() } }));
it('#26 does not reuse a removed guest identity', () => {
  const guests = [newGuest('a'), newGuest('b'), newGuest('c')];
  const seen = new Set(guests.map(g => g.id));
  for (let i = 0; i < 100; i++) {
    guests.splice(i % 2 + 1, 1);
    const next = newGuest('d'); expect(seen.has(next.id)).toBe(false);
    seen.add(next.id); guests.push(next);
  }
});
it('#21 keeps each guest visit and forms separate across a partial failure', async () => {
  const guests = [{ ...newGuest('service-A'), name: 'A', phone: '+15551234567' }, { ...newGuest('service-B'), name: 'B', phone: '+15551234567', addonIds: ['addon-B'] }];
  const committed = new Map<string, any>();
  let fail = true;
  vi.mocked(api.walkIn).mockImplementation(async input => {
    if (!committed.has(input.idempotencyKey)) committed.set(input.idempotencyKey, { appointmentId: `visit-${input.name}`, queueId: `queue-${input.name}` });
    if (input.name === 'B' && fail) { fail = false; throw new Error('response lost'); }
    return committed.get(input.idempotencyKey);
  });
  vi.mocked(api.getRequiredForms).mockImplementation(async ({ appointmentId }) => ({ forms: [{ templateId: `form-${appointmentId}` }] }) as any);
  await expect(registerGuests(guests, 'attempt')).rejects.toThrow('response lost');
  const visits = await registerGuests(guests, 'attempt');
  expect(committed.size).toBe(2);
  expect(visits.map(v => [v.guest.name, v.queueResult.appointmentId, v.forms[0]?.templateId])).toEqual([
    ['A', 'visit-A', 'form-visit-A'], ['B', 'visit-B', 'form-visit-B'],
  ]);
  expect(api.walkIn).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'B', serviceId: 'service-B', addonIds: ['addon-B'], partySize: 1 }));
});
