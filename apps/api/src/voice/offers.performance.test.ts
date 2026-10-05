import { expect, it, vi } from 'vitest';
import type { CommandContext } from '@gf/contracts';
import { addDays, businessDateOf, createWallMinuteResolver, wallMinuteToInstant } from '@gf/scheduling';
import type { PartyAvailabilityData } from '../public/partyAvailabilityData';

vi.mock('@gf/db', () => ({ withTenant: vi.fn(async (_ctx, fn) => fn({})) }));
vi.mock('./catalog', () => ({ voiceCatalog: vi.fn() }));
vi.mock('./deposit', () => ({ voiceDepositQuoteFromSettings: () => null }));
vi.mock('../public/partyAvailabilityData', () => ({ loadPartyAvailabilityData: vi.fn() }));
vi.mock('./references', async importOriginal => ({
  ...await importOriginal<typeof import('./references')>(), saveReference: vi.fn(async () => 'test-reference'),
}));
import { voiceCatalog } from './catalog';
import { loadPartyAvailabilityData } from '../public/partyAvailabilityData';
import { loadPartyAvailability } from '../public/partyAvailability';
import { loadVoiceOffers } from './offers';

it('computes seven days without starving timers and keeps bulk and targeted availability identical', async () => {
  const timezone = 'America/New_York';
  const today = businessDateOf(new Date(), timezone, '00:00');
  const dates = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const businessHours = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    .map(day => [day, { open: '09:00', close: '20:00' }]));
  const services = Array.from({ length: 10 }, (_, i) => ({
    id: `service-${i}`, name: { en: `Massage ${i}` }, duration_min: 30 + (i % 3) * 30,
    base_price_cents: 5000 + i * 500, is_addon: false, staff_count: 1,
    buffer_before_min: 0, buffer_after_min: 0,
  }));
  const directory = Array.from({ length: 4 }, (_, i) => ({
    id: `staff-${i}`, name: { en: `Staff ${i}` }, avatar: null, bio: null,
  }));
  const data: PartyAvailabilityData = {
    locationId: 'shop', services, directory, requirements: [], skills: [], resources: [], existing: [],
    resolveMinute: createWallMinuteResolver(),
    staffByDate: Object.fromEntries(dates.map(date => [date, directory.map(staff => ({
      id: staff.id, startMin: 540, endMin: 1200,
      startsAt: wallMinuteToInstant(date, timezone, 540), endsAt: wallMinuteToInstant(date, timezone, 1200),
    }))])),
  };
  const shop = {
    locationId: 'shop', timezone, businessDayCutoff: '00:00', currency: 'USD', businessHours,
    settings: { capacity: { booking_mode: 'location', max_concurrent_per_slot: 4 } },
    onlineBooking: { maxDaysAhead: 30, minMinutesAhead: 0, slotIntervalMinutes: 15 },
  };
  vi.mocked(voiceCatalog).mockResolvedValue({
    shop, context: { shop: { today, timezone } }, holidays: [],
    services: services.map(s => ({ serviceId: s.id, serviceKey: s.id, isAddon: false, guestCount: 1 })),
  } as any);
  vi.mocked(loadPartyAvailabilityData).mockResolvedValue(data);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const start = performance.now();
  let result: Awaited<ReturnType<typeof loadVoiceOffers>>;
  try {
    result = await loadVoiceOffers({ locationId: 'shop' } as CommandContext, 'secret');
  } finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(0);
  expect(result.coverage).toMatchObject({ from: today, through: dates[6], complete: true });
  expect(loadPartyAvailabilityData).toHaveBeenCalledTimes(1);

  const selection = [{ guestIndex: 0, serviceId: services[0]!.id, addonIds: [], staffId: null }];
  const cached = await loadPartyAvailability({} as any, shop as any, { date: dates[1]!, items: selection }, data);
  const uncached = await loadPartyAvailability({} as any, shop as any, { date: dates[1]!, items: selection },
    { ...data, resolveMinute: wallMinuteToInstant });
  expect(cached).toEqual(uncached);
  expect(cached.plans.length).toBeGreaterThan(0);
  console.info(`Seven-day fixture: ${Math.round(performance.now() - start)}ms; timer ticks during refresh: ${ticks}`);
});
