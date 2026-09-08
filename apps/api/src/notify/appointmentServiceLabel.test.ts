import { describe, expect, it } from 'vitest';
import { composeServiceLabel } from './appointmentServiceLabel';

describe('composeServiceLabel（U10 通知服务名行）', () => {
  it('单项目 → 首项名，与旧行为一致', () => {
    expect(composeServiceLabel({
      bundleNames: [], totalItems: 1, bundledItems: 0, firstServiceName: 'Gel Manicure',
    })).toBe('Gel Manicure');
  });

  it('无套餐多项目 → 首项 + N more', () => {
    expect(composeServiceLabel({
      bundleNames: [], totalItems: 3, bundledItems: 0, firstServiceName: 'Gel Manicure',
    })).toBe('Gel Manicure + 2 more');
  });

  it('含组合套餐 → 用套餐名，不用首个子项名', () => {
    expect(composeServiceLabel({
      bundleNames: ['Relax Combo'], totalItems: 3, bundledItems: 3, firstServiceName: 'Massage',
    })).toBe('Relax Combo');
  });

  it('套餐 + 散项 → 套餐名 + N more', () => {
    expect(composeServiceLabel({
      bundleNames: ['Relax Combo'], totalItems: 4, bundledItems: 3, firstServiceName: 'Massage',
    })).toBe('Relax Combo + 1 more');
  });

  it('两份套餐 → 用 + 连接', () => {
    expect(composeServiceLabel({
      bundleNames: ['Relax Combo', 'Relax Combo'], totalItems: 6, bundledItems: 6, firstServiceName: 'Massage',
    })).toBe('Relax Combo + Relax Combo');
  });
});
