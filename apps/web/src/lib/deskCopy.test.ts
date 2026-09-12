import { describe, expect, it } from 'vitest';
import {
  checkInJoinInput,
  copilotQueryCountAfterFailure,
  formatPermissionKey,
  formatValidityPeriod,
  giftCardStatusKey,
  progressCountTitle, rotationEventLabel, refundReasonLabel } from './deskCopy';

describe('formatValidityPeriod', () => {
  it('永久有效时不再拼「天」', () => {
    expect(formatValidityPeriod(null, '永久', (d) => `${d} 天`)).toBe('永久');
    expect(formatValidityPeriod(0, '永久', (d) => `${d} 天`)).toBe('永久');
  });

  it('有天数时带单位', () => {
    expect(formatValidityPeriod(30, '永久', (d) => `${d} 天`)).toBe('30 天');
  });
});

describe('formatPermissionKey', () => {
  it('有词典时显示人话，不是把下划线换成空格', () => {
    expect(formatPermissionKey('ai.execute_without_confirm', (key) => (
      key === 'perm.ai.execute_without_confirm' ? 'AI 免确认执行' : key
    ))).toBe('AI 免确认执行');
  });

  it('未知权限键仍拆成可读片段，不崩', () => {
    expect(formatPermissionKey('future.unknown_flag')).toBe('future · unknown flag');
  });
});

describe('giftCardStatusKey', () => {
  it('ACTIVE 不是展示文案，只是状态枚举', () => {
    expect(giftCardStatusKey('ACTIVE')).toBe('active');
    expect(giftCardStatusKey('expired')).toBe('expired');
  });
});

describe('progressCountTitle', () => {
  it('词条已带冒号时不再拼出 已完:: 0', () => {
    expect(progressCountTitle('已完:', 0)).toBe('已完: 0');
    expect(progressCountTitle('已完：', 3)).toBe('已完: 3');
  });
});

describe('checkInJoinInput', () => {
  it('仪表盘签到必须带上预约 id，不能只 toast', () => {
    expect(checkInJoinInput({
      appointmentId: 'appt-1',
      customerName: 'QA Void Guest',
      serviceId: 'svc-1',
      membershipId: 'staff-1',
    })).toEqual({
      appointmentId: 'appt-1',
      walkInName: 'QA Void Guest',
      requestedServiceId: 'svc-1',
      requestedStaffId: 'staff-1',
    });
  });
});

describe('copilotQueryCountAfterFailure', () => {
  it('请求失败要把已经加上的回合退回去', () => {
    expect(copilotQueryCountAfterFailure(1)).toBe(0);
    expect(copilotQueryCountAfterFailure(0)).toBe(0);
  });
});

/**
 * 机器码 → 人话的回归护栏。
 *
 * 断言的重点不是「映射对不对」，而是**已知码绝不原样返回** ——
 * 这些值此前就是原样渲染的，前台在轮牌历史里看到的是一行 `manual_override`。
 */
describe('机器码文案', () => {
  const echo = (key: string) => key; // 用 key 本身当译文，便于断言走到了哪一条

  it('轮牌事件的每个已知码都有对应词条', () => {
    const codes = [
      'served', 'request_not_counted', 'manual_override',
      'skipped_no_skill', 'skipped_off', 'break', 'back', 'check_in', 'check_out',
    ];
    for (const code of codes) {
      const label = rotationEventLabel(code, echo);
      expect(label, `${code} 没有映射`).toMatch(/^rotation\.evt/);
    }
  });

  it('退款原因的每个已知码都有对应词条', () => {
    for (const code of ['customer_dissatisfied', 'wrong_charge', 'accidental_duplicate', 'other']) {
      expect(refundReasonLabel(code, echo), `${code} 没有映射`).toMatch(/^finance\.refundReason/);
    }
  });

  it('未知码拆开下划线而不是原样显示 —— 出现这种文案说明该补映射表了', () => {
    expect(rotationEventLabel('some_new_code', echo)).toBe('some new code');
    expect(refundReasonLabel('brand_new_reason', echo)).toBe('brand new reason');
  });
});
