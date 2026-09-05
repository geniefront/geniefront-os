import { describe, expect, it } from 'vitest';
import { appointmentStepperRank } from './stepper';

describe('appointmentStepperRank', () => {
  it('已预约只点亮第 1 步，不能把到店/服务中/完工全打勾', () => {
    expect(appointmentStepperRank('booked')).toBe(1);
  });

  it('已到店是第 2 步', () => {
    expect(appointmentStepperRank('checked_in')).toBe(2);
  });

  it('服务中是第 3 步', () => {
    expect(appointmentStepperRank('in_service')).toBe(3);
  });

  it('completed 与 done 都是第 4 步', () => {
    expect(appointmentStepperRank('completed')).toBe(4);
    expect(appointmentStepperRank('done')).toBe(4);
  });

  it('父单 completed 但子项仍是 booked 时按已预约，不能四步全勾', () => {
    expect(appointmentStepperRank('completed', [{ status: 'booked' }])).toBe(1);
  });

  it('子项 in_service 时是第 3 步，即使父单还写着 booked', () => {
    expect(appointmentStepperRank('booked', [{ status: 'in_service' }])).toBe(3);
  });

  it('未知或不认识的状态按已预约，不得回落到「已完工」', () => {
    expect(appointmentStepperRank('confirmed')).toBe(1);
    expect(appointmentStepperRank(undefined)).toBe(1);
    expect(appointmentStepperRank('')).toBe(1);
  });
});
