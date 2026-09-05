/**
 * 前台建预约时的客户身份。
 *
 * `appointment.create` 的 guest.customer 需要 confirmationCode + manageToken，
 * 那是公开预约页的路径。前台录了姓名和电话必须先 `customer.saveProfile`
 * 再带 customerId 建单，否则客人进不了 CRM，电话还会被拼进 walkInName。
 */
import { normalizePhoneE164 } from '@gf/contracts';

export type DeskAppointmentCustomer =
  | { mode: 'profile'; name: string; phoneE164: string }
  | { mode: 'walkin'; walkInName: string };

export function deskAppointmentCustomer(input: {
  name: string;
  phone: string;
}): DeskAppointmentCustomer {
  const name = input.name.trim();
  const phoneE164 = normalizePhoneE164(input.phone.trim());
  if (phoneE164) {
    return { mode: 'profile', name, phoneE164 };
  }
  return { mode: 'walkin', walkInName: name };
}
