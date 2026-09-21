import {dayWindows} from '@gf/scheduling';
import { loadBookingStaff } from '../queries/bookingStaff';
import type postgres from 'postgres';
import { AppError, ERROR_CODES, pickText } from '@gf/contracts';
import { addDays, businessDateOf, findBookingOffers, readBookingPolicy } from '@gf/scheduling';

export interface VoiceSearch { date?: string | undefined; serviceId?: string | undefined; membershipId?: string | undefined; partySize?: number | undefined }
const number = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const minute = (time: string) => { const [h, m] = time.split(':').map(Number); return h! * 60 + m!; };

export async function loadVoiceContext(tx: postgres.TransactionSql, locationId: string, search: VoiceSearch, now = new Date()) {
  const [loc] = await tx<{ name: unknown; timezone: string; address: unknown; phone: string | null;
    business_hours: Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>; settings: Record<string, unknown>;
    holiday_calendar: unknown[]; cutoff: string; status: string }[]>`
    select name, timezone, address, phone, business_hours, settings, holiday_calendar,
      business_day_cutoff::text as cutoff, status from locations where id = ${locationId}`;
  if (!loc || ['suspended', 'closed'].includes(loc.status)) throw new AppError(ERROR_CODES.NOT_FOUND);
  const services = await tx<{ id: string; name: unknown; duration_min: number; base_price_cents: number }[]>`
    select id, name, duration_min, base_price_cents from services
    where location_id = ${locationId} and active and online_bookable and not is_addon and staff_count = 1 order by id`;
  const staffRows = await tx<{ membership_id: string; display_name: unknown; max_concurrent_appointments: number }[]>`
    select sp.membership_id, sp.display_name, sp.max_concurrent_appointments
    from staff_profiles sp join memberships m on m.id = sp.membership_id
    where sp.location_id = ${locationId} and sp.is_bookable and m.status = 'active'`;
  const policy = readBookingPolicy(loc.settings);
  const online = (loc.settings.online_booking ?? {}) as Record<string, unknown>;
  const today = businessDateOf(now, loc.timezone, loc.cutoff);
  const date = search.date ?? today;
  const service = search.serviceId ? services.find(s => s.id === search.serviceId) : undefined;
  if (search.serviceId && !service) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'service_not_bookable' } });
  if (search.membershipId && !staffRows.some(s => s.membership_id === search.membershipId)) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'staff_not_bookable' } });
  }
  const result = {
    shop: { name: pickText(loc.name, 'en'), timezone: loc.timezone, address: loc.address,
      phone: loc.phone, businessHours: loc.business_hours, currentTime: now.toISOString(), today },
    services: services.map(s => ({ serviceId: s.id, name: pickText(s.name, 'en'), durationMin: s.duration_min, priceCents: s.base_price_cents })),
    staff: staffRows.map(s => ({ membershipId: s.membership_id, name: pickText(s.display_name, 'en') })),
    date, partySize: search.partySize ?? 1, policy,
    slots: [] as Array<{ startsAt: string; membershipId: string | null; membershipIds?:Array<string|null> }>,
    guidance: 'Use only returned slots. A slot is not reserved. Confirm booking only after submit_booking returns ok=true.',
  };
  if (!service || date < today || date > addDays(today, Math.max(1, Math.min(365, number(online.max_days_ahead, 60))))) return result;
  const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const hours = loc.business_hours[keys[new Date(`${date}T12:00:00Z`).getUTCDay()]!];
  if (!hours) return result;
  // Treat explicit closed dates conservatively; ordinary weekly hours remain unchanged.
  if (loc.holiday_calendar?.some(h => h === date || (h && typeof h === 'object' &&
    (h as Record<string, unknown>).date === date && (h as Record<string, unknown>).closed === true))) return result;
  const openMin = minute(hours.open);
  const rawClose = minute(hours.close);
  const closeMin = rawClose <= openMin ? rawClose + 1440 : rawClose;
  const windows = await loadBookingStaff(tx,locationId,date);
  const staff = windows.map(w=>({...w,maxConcurrent:loc.settings.capacity && (loc.settings.capacity as any).strict_staff ? 1 : staffRows.find(s=>s.membership_id===w.id)?.max_concurrent_appointments??1}));
  const busy = await tx<{ membership_id: string | null; starts_at: string; ends_at: string; group_key: string }[]>`
    select coalesce(ai.membership_id,ai.reserved_membership_id) as membership_id, ai.starts_at::text, ai.ends_at::text,
      case when a.party_size > 1 or ai.details ? 'serviceExecutionGroup' then ai.id::text else a.id::text end as group_key
    from appointment_items ai join appointments a on a.id = ai.appointment_id
    where a.location_id = ${locationId} and a.status <> 'cancelled' and ai.status in ('booked', 'in_service')
      and ai.starts_at < ((${date}::date + 2)::timestamp at time zone ${loc.timezone})
      and ai.ends_at > (${date}::date::timestamp at time zone ${loc.timezone})`;
  const cap = (loc.settings.capacity ?? {}) as Record<string, unknown>;
  result.slots = dayWindows(date,loc.business_hours).flatMap(({openMin,closeMin})=>findBookingOffers({ date, timezone: loc.timezone, openMin, closeMin,
    durationMin: service.duration_min, step: Math.max(5, Math.min(60, number(cap.slot_minutes, 15))),
    earliest: new Date(now.getTime() + Math.max(0, number(online.min_minutes_ahead, 30)) * 60_000),
    assignStaff:(loc.settings.capacity as any)?.use_recurring_staff === true,
    partySize: result.partySize, policy, preferredMembershipId: search.membershipId ?? null, staff,
    existing: busy.map(b => ({ membershipId: b.membership_id, startsAt: new Date(b.starts_at),
      endsAt: new Date(b.ends_at), groupKey: b.group_key })),
  }));
  return result;
}
