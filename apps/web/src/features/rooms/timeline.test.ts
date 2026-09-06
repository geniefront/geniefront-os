import { describe, expect, it } from 'vitest';
import { roomTimelineMinute, roomTimelinePosition } from './timeline';
describe('room timeline', () => {
  it('places after-midnight bookings on the previous business day axis', () => {
    expect(roomTimelineMinute('2026-09-07T05:30:00Z', 'America/New_York', '2026-09-06')).toBe(1530);
  });
  it('clips to business hours without inventing a minimum service duration', () => {
    expect(roomTimelinePosition(500, 600, 540, 660)).toEqual({ left: 0, width: 50 });
    expect(roomTimelinePosition(700, 720, 540, 660)).toBeNull();
  });
});
