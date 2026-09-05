import { describe, expect, it } from 'vitest';
import { deskAppointmentCustomer } from './deskCustomer';

describe('deskAppointmentCustomer', () => {
  it('前台录了电话就必须建档，不能把电话塞进 walkInName', () => {
    expect(deskAppointmentCustomer({
      name: 'QA Test Guest',
      phone: '(626) 555-0199',
    })).toEqual({
      mode: 'profile',
      name: 'QA Test Guest',
      phoneE164: '+16265550199',
    });
  });

  it('真散客（没电话）才走 walkInName，且姓名里不含电话', () => {
    expect(deskAppointmentCustomer({
      name: 'Walk-in Guest',
      phone: '',
    })).toEqual({
      mode: 'walkin',
      walkInName: 'Walk-in Guest',
    });
  });
});
