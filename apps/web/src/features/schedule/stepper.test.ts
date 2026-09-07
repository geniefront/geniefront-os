import { describe, expect, it } from 'vitest';
import { appointmentStepperRank, deriveDrawerStage } from './stepper';

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

describe('deriveDrawerStage', () => {
  const base = { appointmentStatus: 'booked', activeTicketItems: null, initialStatus: 'booked' } as const;

  it('🔴 空工单不显示「已结束」—— every([]) 为 true 的坑', () => {
    expect(deriveDrawerStage({ ...base, activeTicketItems: [] }))
      .toEqual({ stage: 'checked_in', terminal: null });
  });

  it('工单有项且全部完成 → done；未全完成 → in_service', () => {
    expect(deriveDrawerStage({ ...base, activeTicketItems: [{ finishedAt: '2026-09-07T10:00:00Z' }] }).stage)
      .toBe('done');
    expect(deriveDrawerStage({ ...base, activeTicketItems: [{ finishedAt: '2026-09-07T10:00:00Z' }, { finishedAt: null }] }).stage)
      .toBe('in_service');
  });

  it('🔴 取消 / 爽约是终态，不伪装成「已预约」', () => {
    expect(deriveDrawerStage({ ...base, appointmentStatus: 'cancelled' }))
      .toEqual({ stage: 'cancelled', terminal: 'cancelled' });
    expect(deriveDrawerStage({ ...base, appointmentStatus: 'no_show' }))
      .toEqual({ stage: 'no_show', terminal: 'no_show' });
  });

  it('终态优先于活动工单 —— 取消的预约即便还挂着工单也不画进度', () => {
    expect(deriveDrawerStage({
      appointmentStatus: 'cancelled', activeTicketItems: [{ finishedAt: null }], initialStatus: 'in_service',
    }).terminal).toBe('cancelled');
  });

  it('没有工单时：认识的状态用它，不认识的才回落 initialStatus', () => {
    expect(deriveDrawerStage({ ...base, appointmentStatus: 'in_service' }).stage).toBe('in_service');
    expect(deriveDrawerStage({ ...base, appointmentStatus: 'weird', initialStatus: 'checked_in' }).stage)
      .toBe('checked_in');
  });
});
