import { describe, it, expect } from 'vitest';
import { billableVoiceSeconds } from './voiceMetering';
describe('voice billing decisions', () => {
  it('charges business consultations even without a booking', () => {
    expect(billableVoiceSeconds(120, [{ start: 0, end: 120, category: 'business' }])).toBe(120);
  });
  it('excludes spam, sales, silence, off-topic and faults', () => {
    for (const category of ['spam','sales','silence','off_topic','system_failure']) {
      expect(billableVoiceSeconds(120, [{ start: 0, end: 120, category }])).toBe(0);
    }
  });
  it('keeps the business portion of mixed calls and rounds once', () => {
    const seconds = billableVoiceSeconds(180, [{ start: 0, end: 30, category: 'business' },
      { start: 30, end: 120, category: 'off_topic' }, { start: 120, end: 150, category: 'business' },
      { start: 150, end: 180, category: 'off_topic' }]);
    expect(seconds).toBe(60); expect(Math.ceil(seconds / 60)).toBe(1);
  });
  it('refuses model intervals that overlap or exceed actual duration', () => {
    expect(() => billableVoiceSeconds(60, [])).toThrow();
    expect(() => billableVoiceSeconds(60, [{ start: 5, end: 60, category: 'business' }])).toThrow();
    expect(() => billableVoiceSeconds(60, [{ start: 0, end: 61, category: 'business' }])).toThrow();
    expect(() => billableVoiceSeconds(60, [{ start: 0, end: 40, category: 'business' },
      { start: 20, end: 50, category: 'business' }])).toThrow();
  });
});
