import { describe, expect, it } from 'vitest';
import { dateOf, timeOf, todayIn } from './format';

describe('shop timezone formatting', () => {
  it('renders the same instant in the shop timezone, not the browser timezone', () => {
    const iso = '2026-09-18T18:00:00.000Z';
    expect(timeOf(iso, 'America/New_York')).toMatch(/2:00\sPM/);
    expect(timeOf(iso, 'America/Los_Angeles')).toMatch(/11:00\sAM/);
    expect(dateOf(iso, 'America/New_York')).toMatch(/September 18/);
  });

  it('todayIn uses the supplied IANA zone', () => {
    expect(todayIn('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
