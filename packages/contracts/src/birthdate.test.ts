import { describe, expect, it } from 'vitest';
import {
  daysInMonth, isoToParts, partsToISO, parseBirthdate, parseBirthdateParts,
} from './birthdate.js';

describe('daysInMonth', () => {
  it('handles leap years', () => {
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28); // divisible by 100, not 400
    expect(daysInMonth(1965, 2)).toBe(28);
  });
  it('handles 30/31 day months', () => {
    expect(daysInMonth(2001, 4)).toBe(30);
    expect(daysInMonth(2001, 7)).toBe(31);
  });
});

describe('isoToParts / partsToISO round-trip', () => {
  it('splits and rejoins', () => {
    expect(isoToParts('1965-03-12')).toEqual({ year: '1965', month: '3', day: '12' });
    expect(partsToISO({ year: '1965', month: '3', day: '12' })).toBe('1965-03-12');
  });
  it('isoToParts is empty for junk', () => {
    expect(isoToParts('')).toEqual({ year: '', month: '', day: '' });
    expect(isoToParts('not-a-date')).toEqual({ year: '', month: '', day: '' });
  });
  it('partsToISO returns null while still being typed', () => {
    expect(partsToISO({ year: '19', month: '3', day: '12' })).toBeNull();
    expect(partsToISO({ year: '1965', month: '', day: '12' })).toBeNull();
    expect(partsToISO({ year: '2001', month: '2', day: '31' })).toBeNull();
  });
});

describe('parseBirthdate', () => {
  it('accepts a plain historical date without any month paging', () => {
    expect(parseBirthdate('1965-03-12')).toEqual({ ok: true, value: '1965-03-12' });
    expect(parseBirthdate('1940-01-01')).toEqual({ ok: true, value: '1940-01-01' });
  });
  it('accepts 2000-02-29 and rejects 1900-02-29', () => {
    expect(parseBirthdate('2000-02-29')).toEqual({ ok: true, value: '2000-02-29' });
    expect(parseBirthdate('1900-02-29')).toEqual({ ok: false, reason: 'invalid_date' });
  });
  it('rejects Feb 31 rather than rolling into March', () => {
    expect(parseBirthdate('2001-02-31')).toEqual({ ok: false, reason: 'invalid_date' });
  });
  it('empty: incomplete unless optional', () => {
    expect(parseBirthdate('')).toEqual({ ok: false, reason: 'incomplete' });
    expect(parseBirthdate('', { optional: true })).toEqual({ ok: true, value: null });
  });
  it('rejects a future date only when store today is known', () => {
    expect(parseBirthdate('2999-01-01', { today: '2026-09-07' })).toEqual({ ok: false, reason: 'future' });
    expect(parseBirthdate('2999-01-01')).toEqual({ ok: true, value: '2999-01-01' }); // today unknown -> no future check
    expect(parseBirthdate('2026-09-07', { today: '2026-09-07' })).toEqual({ ok: true, value: '2026-09-07' });
  });
  it('rejects non ISO shape', () => {
    expect(parseBirthdate('03/12/1965')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('parseBirthdateParts', () => {
  it('half-filled is incomplete, not invalid', () => {
    expect(parseBirthdateParts({ year: '196', month: '3', day: '' })).toEqual({ ok: false, reason: 'incomplete' });
  });
  it('complete but impossible day is invalid_date', () => {
    expect(parseBirthdateParts({ year: '2001', month: '2', day: '31' })).toEqual({ ok: false, reason: 'invalid_date' });
  });
  it('all blank is ok when optional', () => {
    expect(parseBirthdateParts({ year: '', month: '', day: '' }, { optional: true })).toEqual({ ok: true, value: null });
  });
  it('valid parts pass through with future check', () => {
    expect(parseBirthdateParts({ year: '1965', month: '3', day: '12' }, { today: '2026-09-07' }))
      .toEqual({ ok: true, value: '1965-03-12' });
  });
});
