import { describe, expect, it } from 'vitest';
import { customerInitials, walkInShowsNoPhone } from './displayName';

describe('customerInitials', () => {
  it('中文名带英文括号别名时取中文，不把括号切进去', () => {
    expect(customerInitials('王明 (Wang Ming)')).toBe('王明');
  });

  it('纯中文两字名取两字', () => {
    expect(customerInitials('陈伟')).toBe('陈伟');
  });

  it('英文名取前两个单词首字母', () => {
    expect(customerInitials('QA Test Guest')).toBe('QT');
    expect(customerInitials('Lisa Chen')).toBe('LC');
  });

  it('空名回退问号', () => {
    expect(customerInitials('')).toBe('?');
    expect(customerInitials('   ')).toBe('?');
  });
});

describe('walkInShowsNoPhone', () => {
  it('有独立电话字段时不显示「散客无电话」', () => {
    expect(walkInShowsNoPhone({ phone: '(626) 555-0199', customerName: 'QA Test Guest' })).toBe(false);
  });

  it('电话被拼进姓名里也不要谎称无电话', () => {
    expect(walkInShowsNoPhone({
      phone: null,
      customerName: 'QA Test Guest ((626) 555-0199)',
    })).toBe(false);
  });

  it('真的没留电话才显示', () => {
    expect(walkInShowsNoPhone({ phone: null, customerName: 'Walk-in Guest' })).toBe(true);
  });
});
