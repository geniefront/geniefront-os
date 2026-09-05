import { describe, expect, it } from 'vitest';
import { healthFormHonesty } from './healthFormStatus';

describe('healthFormHonesty', () => {
  it('有未签问卷时是 pending，不能画成已签署', () => {
    expect(healthFormHonesty({ pendingForms: 1 })).toBe('pending');
    expect(healthFormHonesty({ rawQueue: { pendingForms: 2 } })).toBe('pending');
  });

  it('没有待签问卷也没有已签记录时是 none，不是「已签署合规」', () => {
    expect(healthFormHonesty({ pendingForms: 0 })).toBe('none');
    expect(healthFormHonesty({})).toBe('none');
  });

  it('明确已确认或已提交才是 signed', () => {
    expect(healthFormHonesty({ pendingForms: 0, healthConfirmed: true })).toBe('signed');
    expect(healthFormHonesty({ pendingForms: 0, completedForms: 1 })).toBe('signed');
  });
});
