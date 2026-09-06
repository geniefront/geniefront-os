/**
 * 作废 / 全额退款时，预约和排队怎么收场。
 *
 * 录入错误要留预约重开；客人改主意或离店要撤预约，否则房间还挂着那场。
 * 排队标成 left 必须写 left_reason，否则撞 walkin_queue_left_reason。
 */

export function voidCancelsAppointment(reason: string): boolean {
  return reason === 'guest_changed_mind'
    || reason === 'walk_out'
    || reason === 'paid_externally';
}

export function queueLeftReasonOnFullRefund(): string {
  return 'refunded';
}

export function queueLeftReasonOnVoid(reason: string): string {
  if (reason === 'guest_changed_mind') return 'told_us';
  if (reason === 'paid_externally') return 'seated_elsewhere';
  return 'other';
}
