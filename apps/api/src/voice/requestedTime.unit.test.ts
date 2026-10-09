import { expect, it } from 'vitest';
import { requestedTimeResult } from './requestedTime';

const input = { date: '2026-09-29', timezone: 'America/New_York', minMinutesAhead: 30 };
it('with zero notice accepts an offered imminent slot but still rejects past times', () => {
  const selection = { ...input, minMinutesAhead:0, time:'09:30', times:['09:30', '09:40'] };
  expect(requestedTimeResult(selection, Date.parse('2026-09-29T13:29:59Z')))
    .toMatchObject({ available:true, reason:null });
  expect(requestedTimeResult(selection, Date.parse('2026-09-29T13:30:01Z')))
    .toMatchObject({ available:false, reason:'too_soon', alternatives:['09:40'] });
});
it('does not call 20:00 available when the successful lookup offers only 20:30 and 21:00', () => {
  expect(requestedTimeResult({ ...input, time: '20:00', times: ['20:30', '21:00'] }, Date.parse('2026-09-29T23:35:13Z')))
    .toMatchObject({ available: false, reason: 'too_soon', alternatives: ['20:30', '21:00'] });
});
it('accepts an offered exact time at the five-minute boundary and rejects one second too late', () => {
  const selection = { ...input, minMinutesAhead: 5, time: '09:30', times: ['09:30', '09:40', '09:50'] };
  expect(requestedTimeResult(selection, Date.parse('2026-09-29T13:25:00Z'))).toMatchObject({ available: true, reason: null, alternatives: [] });
  expect(requestedTimeResult(selection, Date.parse('2026-09-29T13:25:01Z'))).toMatchObject({ available: false, reason: 'too_soon', alternatives: ['09:40', '09:50'] });
});
it('does not invent a time inside a gap, and offers only the closest returned times', () => {
  expect(requestedTimeResult({ ...input, time: '15:00', times: ['09:00', '14:40', '15:10', '16:00'] }, Date.parse('2026-09-29T12:00:00Z')))
    .toMatchObject({ available: false, reason: 'not_offered', alternatives: ['15:10', '14:40'] });
});
it('does not mistake an empty result for available', () => {
  expect(requestedTimeResult({ ...input, time: '15:00', times: [] }, Date.parse('2026-09-29T12:00:00Z')))
    .toMatchObject({ available: false, reason: 'not_offered', alternatives: [] });
});

const octoberInput = { date: '2026-10-05', time: '11:00', timezone: 'America/New_York', minMinutesAhead: 30,
  times: ['10:30', '11:30', '12:00'] };
it('distinguishes an unavailable requested time from a successful lookup', () => {
  expect(requestedTimeResult(octoberInput, Date.parse('2026-10-05T14:00:00Z')))
    .toMatchObject({ available: false, reason: 'not_offered', alternatives: ['10:30', '11:30'] });
});
it('filters times inside the minimum lead time and reports the exact requested slot', () => {
  expect(requestedTimeResult(octoberInput, Date.parse('2026-10-05T14:45:00Z')))
    .toMatchObject({ available: false, reason: 'too_soon', alternatives: ['11:30', '12:00'] });
  expect(requestedTimeResult({ ...octoberInput, time: '11:30' }, Date.parse('2026-10-05T14:45:00Z')))
    .toMatchObject({ available: true, reason: null, alternatives: [] });
});
