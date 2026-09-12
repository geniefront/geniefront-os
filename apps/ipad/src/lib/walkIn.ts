import { api } from '../api/client';
import type { GuestIntake } from '../types';

export function newGuest(serviceId: string | null, phone = ''): GuestIntake {
  return { id: crypto.randomUUID(), name: '', phone, email: '', serviceId, addonIds: [] };
}

export async function registerGuests(guests: GuestIntake[], attempt: string) {
  const visits = [];
  for (const guest of guests) {
    const queueResult = await api.walkIn({
      name: guest.name.trim(), phone: guest.phone.trim(),
      ...(guest.email?.trim() ? { email: guest.email.trim() } : {}),
      serviceId: guest.serviceId ?? undefined, addonIds: guest.addonIds, partySize: 1,
      idempotencyKey: `${attempt}:${guest.id}`,
    });
    const { forms } = await api.getRequiredForms({ appointmentId: queueResult.appointmentId });
    visits.push({ guest: { ...guest, name: guest.name.trim(), phone: guest.phone.trim() }, queueResult, forms });
  }
  return visits;
}
