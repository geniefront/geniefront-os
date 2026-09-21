import { expect, it } from 'vitest';
import { appointmentAllowsSchedulingChanges } from './appointmentCapabilities';
it('limits scheduling actions to known active states', () => {
  for (const status of ['cancelled', 'no_show', 'completed', 'done', 'unknown', null, undefined]) expect(appointmentAllowsSchedulingChanges(status)).toBe(false);
  for (const status of ['booked', 'checked_in', 'waiting', 'in_service']) expect(appointmentAllowsSchedulingChanges(status)).toBe(true);
});
