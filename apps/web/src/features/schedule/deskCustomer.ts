/** Resolve desk identity; customer creation is atomic with appointment.create. */
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
  if (input.phone.trim() && !phoneE164) throw new Error('Invalid phone number');
  if (phoneE164) {
    return { mode: 'profile', name, phoneE164 };
  }
  return { mode: 'walkin', walkInName: name };
}
