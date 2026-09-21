import type { CommandContext } from "@gf/contracts";
import { withTenant } from "@gf/db";
import { addDays } from "@gf/scheduling";
import { voiceCatalog } from "./catalog";
import { compactTimes, type VoiceItems } from "./selection";
import { saveReference, referenceScope } from "./references";
import { loadPartyAvailability } from "../public/partyAvailability";
import { loadPartyAvailabilityData } from "../public/partyAvailabilityData";
type Group = {
  date: string;
  items: VoiceItems;
  times: string[];
  startsAtByTime: Record<string, string>;
  quotedTotalCents: number;
  timezone: string;
};
export async function loadVoiceOffers(
  ctx: CommandContext,
  secret: string,
  q: { date?: string | undefined } = {},
  selections?: VoiceItems,
) {
  return withTenant(ctx, async (tx) => {
    const cat = await voiceCatalog(tx, ctx.locationId);

    const groups: Group[] = [];
    const dates = selections
      ? [q.date ?? cat.context.shop.today]
      : Array.from({ length: 7 }, (_, i) => addDays(cat.context.shop.today, i));
    const preloaded = selections
      ? undefined
      : await loadPartyAvailabilityData(tx, cat.shop, dates);
    const choices = selections
      ? [selections]
      : cat.services
          .filter((s) => !s.isAddon)
          .map((s) => [
            {
              guestIndex: 0,
              ...(s.guestCount > 1
                ? {
                    guestIndices: Array.from(
                      { length: s.guestCount },
                      (_, i) => i,
                    ),
                  }
                : {}),
              serviceId: s.serviceId,
              addonIds: [],
              staffId: null,
            },
          ]);
    const unavailable: Array<{
      date: string;
      serviceKey?: string;
      reason: string;
    }> = [];
    // A transaction shares one connection; concurrent reads pipeline without a new connection per service.
    const candidates = await Promise.all(
      dates.flatMap((date) =>
        choices.map(async (items) => {
          if (
            cat.holidays?.some(
              (h) =>
                h === date ||
                (h &&
                  typeof h === "object" &&
                  (h as any).date === date &&
                  (h as any).closed === true),
            )
          )
            return {
              date,
              items,
              reason: "store_closed",
              times: [],
              startsAtByTime: {},
              quotedTotalCents: 0,
              timezone: cat.shop.timezone,
            };
          if (
            date >
            addDays(cat.context.shop.today, cat.shop.onlineBooking.maxDaysAhead)
          )
            return {
              date,
              items,
              reason: "date_out_of_window",
              times: [],
              startsAtByTime: {},
              quotedTotalCents: 0,
              timezone: cat.shop.timezone,
            };
          const available = await loadPartyAvailability(
            tx,
            cat.shop,
            { date, items },
            preloaded,
          );
          const format = new Intl.DateTimeFormat("en-GB", {
            timeZone: cat.shop.timezone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });
          const startsAtByTime: Record<string, string> = {};
          for (const p of available.plans) {
            const time = format.format(new Date(p.startsAt));
            if (!startsAtByTime[time]) startsAtByTime[time] = p.startsAt;
          }
          const times = Object.keys(startsAtByTime);
          return {
            date,
            items,
            times,
            startsAtByTime,
            quotedTotalCents: available.items.reduce(
              (n, i) => n + i.priceCents,
              0,
            ),
            timezone: cat.shop.timezone,
            reason: times.length ? null : "no_availability",
          };
        }),
      ),
    );
    for (const g of candidates) {
      if (g.reason)
        unavailable.push({
          date: g.date,
          ...(selections
            ? {}
            : {
                serviceKey: cat.services.find(
                  (s) => s.serviceId === g.items[0]!.serviceId,
                )!.serviceKey,
              }),
          reason: g.reason,
        });
      else groups.push(g);
    }
    const id = await saveReference(
      tx,
      ctx,
      "offers",
      referenceScope(secret),
      groups,
    );
    const step = cat.shop.onlineBooking.slotIntervalMinutes ?? 30;
    const offers = groups.map((g, index) => ({
      slotToken: `${id}.${index}`,
      date: g.date,
      ...(selections
        ? {}
        : {
            serviceKey: cat.services.find(
              (s) => s.serviceId === g.items[0]!.serviceId,
            )!.serviceKey,
          }),
      times: compactTimes(g.times, step),
      ...(selections ? { priceCents: g.quotedTotalCents } : {}),
    }));
    return {
      ok: true,
      ...(selections
        ? { timezone: cat.shop.timezone, selection: selections }
        : { ...cat.context }),
      coverage: {
        from: dates[0],
        through: dates[dates.length - 1],
        kind: selections
          ? "exact_selection"
          : "base_services_no_addons_no_staff_preference",
        complete: true,
        generatedAt: new Date().toISOString(),
        expiresInSeconds: 900,
        timeFormat:
          "HH:mm local; start-end/step means inclusive returned times every step minutes",
      },
      offers,
      unavailable,
    };
  });
}
