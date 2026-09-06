import { describe, expect, it } from 'vitest';
import { queueLeftReasonOnFullRefund, voidCancelsAppointment } from './ticketLifecycle';

describe('作废是否撤预约', () => {
  it('客人改主意或离店要取消预约，录入错误要留着重开', () => {
    expect(voidCancelsAppointment('guest_changed_mind')).toBe(true);
    expect(voidCancelsAppointment('walk_out')).toBe(true);
    expect(voidCancelsAppointment('paid_externally')).toBe(true);
    expect(voidCancelsAppointment('input_error')).toBe(false);
    expect(voidCancelsAppointment('duplicate_booking')).toBe(false);
  });
});

describe('全额退款排队离开原因', () => {
  it('必须写出原因，否则 walkin_queue_left_reason 会 500', () => {
    expect(queueLeftReasonOnFullRefund()).toBeTruthy();
  });
});
