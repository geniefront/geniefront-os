import { voiceCatalog } from "../voice/catalog";
import { loadPartyAvailability } from "../public/partyAvailability";
import {
  AppError,
  ERROR_CODES,
  AppointmentCreate,
  SubmitVoiceBooking,
} from "@gf/contracts";
import { registerHandler } from "../bus";
import {
  executeSingleAppointmentInTx,
  lockBookingCapacity,
} from "./appointment";
import { loadVoiceContext } from "../voice/context";
import {
  generateConfirmationCode,
  generateManageToken,
} from "../public/bookingToken";

registerHandler(SubmitVoiceBooking, async ({ input, tx, ctx, audit }) => {
  await lockBookingCapacity(tx, ctx.locationId);
  if (input.items) {
    const catalog = await voiceCatalog(tx, ctx.locationId);
    if (
      catalog.holidays?.some(
        (h) =>
          h === input.date ||
          (h &&
            typeof h === "object" &&
            (h as any).date === input.date &&
            (h as any).closed === true),
      )
    ) {
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        details: { reason: "store_closed" },
      });
    }
    const available = await loadPartyAvailability(tx, catalog.shop, {
      date: input.date,
      startsAt: input.startsAt,
      items: input.items,
    });
    const plan = available.plans[0];
    if (!plan)
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        details: { reason: "slot_no_longer_available" },
      });
    const total = plan.items.reduce((n, i) => n + i.priceCents, 0);
    if (
      input.quotedTotalCents !== undefined &&
      input.quotedTotalCents !== total
    )
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        details: { reason: "price_changed_query_again" },
      });
    const code = generateConfirmationCode("GF");
    const payload = AppointmentCreate.input.parse({
      customerId: null,
      providerCallId: input.providerCallId,
      source: "phone_ai",
      partySize: input.partySize,
      notes: input.notes,
      items: plan.items.map((item, index) => ({
        serviceId: input.items![index]!.serviceId,
        addonIds: input.items![index]!.addonIds,
        startsAt: item.startsAt,
        membershipId: item.staffId,
        additionalMembershipIds: item.additionalStaffIds ?? [],
        isRequest: Boolean(input.items![index]!.staffId),
        resourceId: item.resourceId ?? null,
        details: {
          publicGuestIndex: input.items![index]!.guestIndex,
          publicGuestIndices: input.items![index]!.guestIndices,
          quotedPriceCents: item.priceCents,
        },
      })),
      guest: {
        confirmationCode: code,
        manageToken: generateManageToken(),
        customer: {
          name: input.customerName,
          phoneE164: input.phoneE164,
          email: input.email,
          smsOptIn: false,
        },
      },
    });
    const out = await executeSingleAppointmentInTx(tx, ctx, payload);
    audit({
      entityType: "appointment",
      entityId: out.appointmentId,
      after: {
        source: "phone_ai",
        provider: "xai",
        items: input.items,
        startsAt: input.startsAt,
      },
    });
    return {
      appointmentId: out.appointmentId,
      confirmationCode: code,
      businessDate: out.businessDate,
    };
  }
  const context = await loadVoiceContext(tx, ctx.locationId, {
    date: input.date,
    serviceId: input.serviceId,
    partySize: input.partySize,
    ...(input.membershipId ? { membershipId: input.membershipId } : {}),
  });
  const offer = context.slots.find(
    (s) => Date.parse(s.startsAt) === Date.parse(input.startsAt),
  );
  if (!offer) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
      details: { reason: "slot_no_longer_available" },
    });
  }
  const code = generateConfirmationCode("GF");
  const payload = AppointmentCreate.input.parse({
    customerId: null,
    providerCallId: input.providerCallId,
    source: "phone_ai",
    partySize: input.partySize,
    notes: input.notes,
    items: Array.from({ length: input.partySize }, (_, index) => ({
      serviceId: input.serviceId,
      startsAt: input.startsAt,
      membershipId:
        input.membershipId ??
        offer.membershipIds?.[index] ??
        offer.membershipId,
      isRequest: Boolean(input.membershipId),
    })),
    guest: {
      confirmationCode: code,
      manageToken: generateManageToken(),
      customer: {
        name: input.customerName,
        phoneE164: input.phoneE164,
        email: input.email,
        smsOptIn: false,
      },
    },
  });
  const out = await executeSingleAppointmentInTx(tx, ctx, payload);
  audit({
    entityType: "appointment",
    entityId: out.appointmentId,
    after: {
      source: "phone_ai",
      provider: "xai",
      serviceId: input.serviceId,
      startsAt: input.startsAt,
    },
  });
  return {
    appointmentId: out.appointmentId,
    confirmationCode: code,
    businessDate: out.businessDate,
  };
});
