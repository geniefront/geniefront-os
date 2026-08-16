/**
 * Yelp 映射的测试。
 *
 * 三条最要紧的，都是「错了不会报异常、只会静默错一天」的那类：
 *   · Yelp 的 day 0 是星期一 —— 弄反的话整张营业时间表错开一天
 *   · 跨午夜 —— 「开到凌晨两点」不能变成「凌晨两点关门」
 *   · 时区 —— 推错了整家店的日结、提成、报表全部错一天
 */

import { describe, it, expect } from 'vitest';
import { mapHours, guessTimezone, mapBusiness, ratingToBp, type YelpBusiness } from './map';

const hours = (open: Array<{ day: number; start: string; end: string; is_overnight?: boolean }>)
  : YelpBusiness => ({ id: 'x', name: 'X', hours: [{ hours_type: 'REGULAR', open }] });

describe('营业时间：Yelp 的 day 0 是星期一', () => {
  it('⭐ day 0 → 周一，day 6 → 周日（弄反的话整张表错开一天）', () => {
    // 这个错不会报任何异常，只会让「今天营不营业」在真店里悄悄错一天，
    // 而老板会以为是自己填错了
    const out = mapHours(hours([
      { day: 0, start: '0900', end: '1930' },
      { day: 6, start: '1000', end: '1800' },
    ]));
    expect(out.mon).toEqual({ open: '09:00', close: '19:30' });
    expect(out.sun).toEqual({ open: '10:00', close: '18:00' });
    expect(out.tue).toBeUndefined();
  });

  it('真实数据：周一到周五 9:00–19:30、周六 9:00–18:00、周日 10:00–18:00', () => {
    const out = mapHours(hours([
      ...[0, 1, 2, 3, 4].map((day) => ({ day, start: '0900', end: '1930' })),
      { day: 5, start: '0900', end: '1800' },
      { day: 6, start: '1000', end: '1800' },
    ]));
    expect(out.fri).toEqual({ open: '09:00', close: '19:30' });
    expect(out.sat).toEqual({ open: '09:00', close: '18:00' });
    expect(out.sun).toEqual({ open: '10:00', close: '18:00' });
  });

  it('⭐ 没写的那天【不填】—— 猜一个默认值会让系统在老板休息那天照收预约', () => {
    const out = mapHours(hours([{ day: 0, start: '0900', end: '1800' }]));
    expect(Object.keys(out)).toEqual(['mon']);
  });

  it('"0930" 补成 "09:30"，脏数据直接丢掉', () => {
    expect(mapHours(hours([{ day: 0, start: '0930', end: '2130' }])).mon)
      .toEqual({ open: '09:30', close: '21:30' });
    expect(mapHours(hours([{ day: 1, start: '99', end: '2500' }])).tue).toBeUndefined();
  });

  it('⭐ 跨午夜：足疗店开到凌晨两点，不能变成「凌晨两点关门」', () => {
    const out = mapHours(hours([
      { day: 4, start: '1000', end: '0200', is_overnight: true },
    ]));
    expect(out.fri).toEqual({ open: '10:00', close: '02:00' });
  });

  it('一天两段（中午休息）取最早开、最晚关', () => {
    const out = mapHours(hours([
      { day: 0, start: '0900', end: '1200' },
      { day: 0, start: '1400', end: '1900' },
    ]));
    expect(out.mon).toEqual({ open: '09:00', close: '19:00' });
  });

  it('⭐ 一天两段且后一段跨午夜时，跨午夜那段说了算', () => {
    // 直接比字符串的话 "02:00" 比谁都小，会被当成「最早关门」——
    // 「开到凌晨两点」就变成了只开一小会儿，方向正好反了
    const out = mapHours(hours([
      { day: 5, start: '1000', end: '1400' },
      { day: 5, start: '1800', end: '0200', is_overnight: true },
    ]));
    expect(out.sat).toEqual({ open: '10:00', close: '02:00' });
  });

  it('没有 hours 字段 → 空对象，不是崩溃', () => {
    expect(mapHours({ id: 'x', name: 'X' })).toEqual({});
  });

  it('优先取 REGULAR 那一组', () => {
    const out = mapHours({
      id: 'x', name: 'X',
      hours: [
        { hours_type: 'HOLIDAY', open: [{ day: 0, start: '1100', end: '1500' }] },
        { hours_type: 'REGULAR', open: [{ day: 0, start: '0900', end: '1900' }] },
      ],
    });
    expect(out.mon).toEqual({ open: '09:00', close: '19:00' });
  });
});

describe('时区：推错了整家店的日结会错一天', () => {
  it('单时区的州直接用，标 high', () => {
    expect(guessTimezone('CA')).toEqual({ timezone: 'America/Los_Angeles', confidence: 'high' });
    expect(guessTimezone('NY')).toEqual({ timezone: 'America/New_York', confidence: 'high' });
    expect(guessTimezone('AZ').timezone).toBe('America/Phoenix');   // 不跟夏令时
  });

  it('⭐ 跨时区的州按经度分，但一律标「要老板确认」', () => {
    // 德州西边的 El Paso 是山区时间，而全州多数是中部时间
    expect(guessTimezone('TX', -106.5)).toMatchObject({ timezone: 'America/Denver' });
    expect(guessTimezone('TX', -97.7)).toMatchObject({ timezone: 'America/Chicago' });
    // 无论哪边都要确认 —— 这是错了代价最大的一个字段
    expect(guessTimezone('TX', -97.7).confidence).toBe('needs_confirm');
    expect(guessTimezone('FL', -87.2).timezone).toBe('America/Chicago');   // 狭长地带
    expect(guessTimezone('FL', -80.2).timezone).toBe('America/New_York');  // 迈阿密
  });

  it('跨时区的州没有经度时给多数人用的那个，仍然要确认', () => {
    expect(guessTimezone('TX')).toEqual({
      timezone: 'America/Chicago', confidence: 'needs_confirm',
    });
  });

  it('大小写和空格不影响', () => {
    expect(guessTimezone(' ca ').timezone).toBe('America/Los_Angeles');
  });

  it('认不出的州不静默填一个 —— 标出来让老板看', () => {
    expect(guessTimezone('ZZ').confidence).toBe('needs_confirm');
    expect(guessTimezone(undefined).confidence).toBe('needs_confirm');
  });

  it('夏威夷 / 阿拉斯加不会被漏', () => {
    expect(guessTimezone('HI').timezone).toBe('Pacific/Honolulu');
    expect(guessTimezone('AK').timezone).toBe('America/Anchorage');
  });
});

describe('mapBusiness', () => {
  // 一份真实的 Yelp 返回（Queen Spa, Austin TX，2026-08-16 实测）
  const real: YelpBusiness = {
    id: '2davG-KIVjDJCuqav69-Rw',
    name: 'Queen Spa',
    phone: '+15122942093',
    display_phone: '(512) 294-2093',
    rating: 4.3,
    review_count: 816,
    is_closed: false,
    url: 'https://www.yelp.com/biz/queen-spa-austin',
    location: {
      address1: '2110 S Lamar Blvd', address2: 'Ste D', address3: '',
      city: 'Austin', state: 'TX', zip_code: '78704', country: 'US',
      display_address: ['2110 S Lamar Blvd', 'Ste D', 'Austin, TX 78704'],
    },
    coordinates: { latitude: 30.2483481, longitude: -97.7714907 },
    categories: [{ alias: 'othersalons', title: 'Nail Salons' }],
    hours: [{ hours_type: 'REGULAR', open: [
      { day: 0, start: '0900', end: '1930' },
      { day: 6, start: '1000', end: '1800' },
    ] }],
  };

  it('把老板要填的字段一次填齐', () => {
    const m = mapBusiness(real);
    expect(m.name).toBe('Queen Spa');
    expect(m.phoneE164).toBe('+15122942093');
    expect(m.address.city).toBe('Austin');
    expect(m.address.line2).toBe('Ste D');
    expect(m.timezone).toBe('America/Chicago');
    expect(m.timezoneConfidence).toBe('needs_confirm');   // 德州跨时区
    expect(m.businessHours.mon).toEqual({ open: '09:00', close: '19:30' });
    expect(m.rating).toBe(4.3);
    expect(m.reviewCount).toBe(816);
  });

  it('空字符串归成 null —— 否则「有没有电话」的判断到处失灵', () => {
    const m = mapBusiness({ ...real, phone: '', location: { ...real.location, address2: '' } });
    expect(m.phoneE164).toBeNull();
    expect(m.address.line2).toBeNull();
  });

  it('已歇业的店要标出来 —— 多半是老板选错了那一家', () => {
    expect(mapBusiness({ ...real, is_closed: true }).isClosed).toBe(true);
  });

  it('字段缺失不崩溃', () => {
    const m = mapBusiness({ id: 'x', name: 'X' });
    expect(m.name).toBe('X');
    expect(m.phoneE164).toBeNull();
    expect(m.businessHours).toEqual({});
    expect(m.timezoneConfidence).toBe('needs_confirm');
  });

  it('评分存 basis point，不存浮点（宪法第 4 条）', () => {
    expect(ratingToBp(4.3)).toBe(43000);
    expect(ratingToBp(5)).toBe(50000);
    expect(ratingToBp(null)).toBeNull();
  });
});
