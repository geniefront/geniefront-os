import { expect, it } from 'vitest';
import { requestedTimeResult } from './requestedTime';
const input = { date: '2026-10-05', time: '11:00', timezone: 'America/New_York', minMinutesAhead: 30,
  times: ['10:30', '11:30', '12:00'] };
it('distinguishes an unavailable requested time from a successful lookup', () => {
  expect(requestedTimeResult(input, Date.parse('2026-10-05T14:00:00Z')))
    .toMatchObject({ available: false, reason: 'not_offered', alternatives: ['10:30', '11:30'] });
});
it('filters times inside the minimum lead time and reports the exact requested slot', () => {
  expect(requestedTimeResult(input, Date.parse('2026-10-05T14:45:00Z')))
    .toMatchObject({ available: false, reason: 'too_soon', alternatives: ['11:30', '12:00'] });
  expect(requestedTimeResult({ ...input, time: '11:30' }, Date.parse('2026-10-05T14:45:00Z')))
    .toMatchObject({ available: true, reason: null, alternatives: [] });
});
