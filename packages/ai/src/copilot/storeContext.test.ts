/**
 * 门店档案与预约日历的格式化测试。
 *
 * 每一条都在问同一个问题：**模型看到这一行，会不会得出一个错误的结论？**
 *
 * 这一层最贵的错有两种：
 * 1. **ID 不完整或缺失** —— 模型抄一个截断的 UUID 去建单，命令总线报
 *    VALIDATION_FAILED，前台看到「这条我没听懂」；
 * 2. **「没有」和「没给」分不清** —— 某天一条预约都没有，如果那一天整行
 *    不出现，模型会以为窗口到此为止，然后说「那天我查不到」。
 */

import { describe, expect, it } from 'vitest';
import {
  formatStoreProfile,
  formatBookingCalendar,
  roughTokens,
  CONTEXT_TOKEN_BUDGETS,
  type StoreProfile,
  type BookingCalendar,
} from './storeContext';

const SVC_ID = 'b1c2d3e4-5f60-4a1b-8c2d-3e4f5a6b7c8d';
const STAFF_ID = 'a1b2c3d4-5e6f-4071-8293-a4b5c6d7e8f9';
const ROOM_ID = 'f1e2d3c4-b5a6-4978-8765-a0b1c2d3e4f5';
const APT_ID = '3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071';

const profile: StoreProfile = {
  location: {
    name: 'Lotus Nails & Spa',
    timezone: 'America/New_York',
    cutoff: '04:00',
    address: '123 Main St, Somewhere NY 10001',
    phone: '+15551234567',
    taxPercent: '8.875',
    hours: [
      null,
      { weekday: 'Mon', open: '09:00', close: '19:00' },
      { weekday: 'Tue', open: '09:00', close: '19:00' },
      { weekday: 'Wed', open: '09:00', close: '19:00' },
      { weekday: 'Thu', open: '09:00', close: '20:00' },
      { weekday: 'Fri', open: '09:00', close: '20:00' },
      { weekday: 'Sat', open: '10:00', close: '18:00' },
    ],
  },
  services: [
    {
      id: SVC_ID, name: '经络足道', englishName: 'Foot Reflexology',
      category: '足疗', durationMin: 60, priceDollars: '75.00',
    },
  ],
  staff: [
    {
      membershipId: STAFF_ID, name: 'Amy', jobTitle: '美甲师', level: '资深',
      isBookable: true, maxConcurrent: 1, status: 'active', skills: ['Gel-X', '彩绘'],
    },
    {
      membershipId: 'c3d4e5f6-7a8b-49c0-8d1e-2f3a4b5c6d7e', name: 'Rose', jobTitle: '前台',
      level: null, isBookable: false, maxConcurrent: 1, status: 'on_leave', skills: [],
    },
  ],
  rooms: [
    { resourceId: ROOM_ID, name: '3号房', type: '足疗房', capacity: 6, maxStaff: 2 },
  ],
  packages: [
    { id: 'pkg-1', name: '美甲 10 次卡', priceDollars: '500.00', sessions: 10 },
  ],
};

describe('formatStoreProfile', () => {
  const out = formatStoreProfile(profile);

  it('⭐ 服务、员工、房间的完整 UUID 都在 —— 模型要靠它们逐字抄进命令', () => {
    expect(out).toContain(SVC_ID);
    expect(out).toContain(STAFF_ID);
    expect(out).toContain(ROOM_ID);
  });

  it('服务行带中英文名、分类、时长和价格', () => {
    expect(out).toContain(`${SVC_ID} | 经络足道 | Foot Reflexology | 足疗 | 60m | $75.00`);
  });

  it('⭐ 不可排单与请假状态要显式标出 —— 否则模型会把单派给不在岗的人', () => {
    expect(out).toContain('Amy | 美甲师 | Y | 1 | Gel-X,彩绘');
    expect(out).toContain('Rose [on_leave] | 前台 | N |');
  });

  it('⭐ 歇业日单独列出，不能只是「那天没写」', () => {
    expect(out).toContain('Mon 09:00-19:00');
    expect(out).toContain('休息: Sun');
  });

  it('带上时区、营业日截点与税率', () => {
    expect(out).toContain('America/New_York');
    expect(out).toContain('营业日截点 04:00');
    expect(out).toContain('TAX: 8.875%');
  });

  it('⭐ 逐字节稳定 —— 同样的输入必须产出同样的字符串，否则前缀缓存永远不命中', () => {
    expect(formatStoreProfile(profile)).toBe(out);
  });

  it('空的段整段省掉，不写占位行', () => {
    const bare = formatStoreProfile({
      ...profile, services: [], staff: [], rooms: [], packages: [],
    });
    expect(bare).not.toContain('SERVICES');
    expect(bare).not.toContain('PACKAGES');
  });

  it('一家大店的档案仍在预算内', () => {
    const big: StoreProfile = {
      ...profile,
      services: Array.from({ length: 120 }, (_, i) => ({
        id: SVC_ID, name: `项目${i}`, englishName: `Service ${i}`,
        category: '美甲', durationMin: 45, priceDollars: '55.00',
      })),
      staff: Array.from({ length: 40 }, (_, i) => ({
        membershipId: STAFF_ID, name: `Tech${i}`, jobTitle: '技师', level: '中级',
        isBookable: true, maxConcurrent: 1, status: 'active',
        skills: ['Gel-X', '彩绘', '足疗', '美睫'],
      })),
      rooms: Array.from({ length: 25 }, (_, i) => ({
        resourceId: ROOM_ID, name: `房${i}`, type: '足疗房', capacity: 4, maxStaff: 2,
      })),
    };
    expect(roughTokens(formatStoreProfile(big)))
      .toBeLessThan(CONTEXT_TOKEN_BUDGETS.STORE_PROFILE);
  });
});

describe('formatBookingCalendar', () => {
  const calendar: BookingCalendar = {
    fromDate: '2026-08-30',
    toDate: '2026-10-06',
    todayDate: '2026-09-06',
    days: [
      {
        businessDate: '2026-09-06',
        weekday: 'Sat',
        shifts: ['Amy 09:00-18:00', 'Kim 10:00-19:00'],
        off: ['Mai'],
        items: [
          {
            appointmentId: APT_ID, startsAt: '14:00', customerName: '王太太',
            serviceName: 'Gel Full Set', durationMin: 60, staffName: 'Amy',
            status: 'booked', isRequest: true, roomName: '3号房',
          },
          {
            appointmentId: '7c8d9e0f-1a2b-4c4d-9e6f-7a8b9c0d1e2f', startsAt: '16:30',
            customerName: '李小姐', serviceName: 'Deep Tissue', durationMin: 90,
            staffName: null, status: 'confirmed',
          },
        ],
      },
      {
        businessDate: '2026-09-07', weekday: 'Sun', shifts: [], off: [], items: [],
      },
    ],
  };

  const out = formatBookingCalendar(calendar);

  it('⭐ 每一条都带完整 appointmentId —— 改期/取消要靠它，不能截断', () => {
    expect(out).toContain(`[${APT_ID}]`);
    expect(out).toContain('[7c8d9e0f-1a2b-4c4d-9e6f-7a8b9c0d1e2f]');
  });

  it('⭐ 没指派技师写「@待分配」，不能省略 —— 省了模型会以为已经排好人', () => {
    expect(out).toContain('@待分配');
  });

  it('点钟单带星号，非默认状态用尖括号标出', () => {
    expect(out).toContain('@Amy*');
    expect(out).toContain('<confirmed>');
    expect(out).not.toContain('<booked>');
  });

  it('⭐ 没有预约的那天要写「(空)」—— 整行消失会让模型以为窗口断了', () => {
    expect(out).toContain('== 2026-09-07 Sun');
    expect(out).toContain('(空)');
  });

  it('⭐ 尚未发布排班的日子要说明，而不是看起来像「全店都没人上班」', () => {
    expect(out).toContain('在班: 尚未排班');
    expect(out).toContain('在班: Amy 09:00-18:00, Kim 10:00-19:00');
    expect(out).toContain('休: Mai');
  });

  it('标出今天，并在抬头交代 ID 可以直接用', () => {
    expect(out).toContain('== 2026-09-06 Sat ← 今天');
    expect(out).toContain('appointmentId');
  });

  it('一家忙店 37 天的日历仍在预算内', () => {
    const busy: BookingCalendar = {
      ...calendar,
      days: Array.from({ length: 38 }, (_, d) => ({
        businessDate: `2026-09-${String((d % 28) + 1).padStart(2, '0')}`,
        weekday: 'Mon',
        shifts: Array.from({ length: 12 }, (_, i) => `Tech${i} 09:00-19:00`),
        off: [],
        items: Array.from({ length: 35 }, (_, i) => ({
          appointmentId: APT_ID,
          startsAt: `${String(9 + (i % 10)).padStart(2, '0')}:00`,
          customerName: `顾客${i}`,
          serviceName: 'Deluxe Pedicure with Callus Treatment',
          durationMin: 60,
          staffName: `Tech${i % 12}`,
          status: 'booked',
        })),
      })),
    };
    expect(roughTokens(formatBookingCalendar(busy)))
      .toBeLessThan(CONTEXT_TOKEN_BUDGETS.BOOKING_CALENDAR);
  });
});
