import { describe, expect, it } from 'vitest';
import { deskOpenCloseMin } from './deskHours';

/** 金足：周五/周六开到次日 01:00 */
const GOLDEN_FOOT_HOURS = {
  mon: { open: '10:00', close: '23:00' },
  tue: { open: '10:00', close: '23:00' },
  wed: { open: '10:00', close: '23:00' },
  thu: { open: '10:00', close: '23:00' },
  fri: { open: '10:00', close: '01:00' },
  sat: { open: '10:00', close: '01:00' },
  sun: { open: '10:00', close: '23:00' },
};

describe('deskOpenCloseMin', () => {
  it('周三关门 23:00，closeMin 是当天墙上分钟', () => {
    // 2026-08-26 是星期三
    expect(deskOpenCloseMin('2026-08-26', GOLDEN_FOOT_HOURS)).toEqual({
      openMin: 10 * 60,
      closeMin: 23 * 60,
    });
  });

  it('周六过夜打烊 01:00，closeMin 必须 > 1440，不能收成 60', () => {
    // 2026-09-05 是星期六
    expect(deskOpenCloseMin('2026-09-05', GOLDEN_FOOT_HOURS)).toEqual({
      openMin: 10 * 60,
      closeMin: 25 * 60,
    });
  });
});
