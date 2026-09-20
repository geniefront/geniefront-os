import { AppError, ERROR_CODES, AppointmentCreate, SubmitVoiceBooking } from '@gf/contracts';
import { registerHandler } from '../bus';
import { executeSingleAppointmentInTx, lockBookingCapacity } from './appointment';
import { loadVoiceContext } from '../voice/context';
import { generateConfirmationCode, generateManageToken } from '../public/bookingToken';

registerHandler(SubmitVoiceBooking, async ({ input, tx, ctx, audit }) => {
  await lockBookingCapacity(tx, ctx.locationId);
  const context = await loadVoiceContext(tx, ctx.locationId, {
    date: input.date, serviceId: input.serviceId, partySize: input.partySize,
    ...(input.membershipId ? { membershipId: input.membershipId } : {}),
  });
  const offer=context.slots.find(s => Date.parse(s.startsAt) === Date.parse(input.startsAt));
  if (!offer) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, { details: { reason: 'slot_no_longer_available' } });
  }
  const code = generateConfirmationCode('GF');
  const payload = AppointmentCreate.input.parse({
    customerId: null, providerCallId:input.providerCallId, source: 'phone_ai', partySize: input.partySize, notes: input.notes,
    items: Array.from({ length: input.partySize }, (_,index) => ({ serviceId: input.serviceId,
      startsAt: input.startsAt, membershipId: input.membershipId ?? offer.membershipIds?.[index] ?? offer.membershipId, isRequest: Boolean(input.membershipId) })),
    guest: { confirmationCode: code, manageToken: generateManageToken(), customer: {
      name: input.customerName, phoneE164: input.phoneE164, email: input.email, smsOptIn: false,
    } },
  });
  const out = await executeSingleAppointmentInTx(tx, ctx, payload);
  audit({ entityType: 'appointment', entityId: out.appointmentId,
    after: { source: 'phone_ai', provider: 'xai', serviceId: input.serviceId, startsAt: input.startsAt } });
  return { appointmentId: out.appointmentId, confirmationCode: code, businessDate: out.businessDate };
});
