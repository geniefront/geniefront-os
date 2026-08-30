import type postgres from 'postgres';
import { businessDateOf, iso, type QaClock } from './clock';
import { qaUuid } from './ids';
import type { SeededLocation } from './bootstrap';
import type { QaScenarioId } from './types';

export type ShopCatalog = {
  serviceIds: Record<string, string>;
  serviceMeta: Record<string, { durationMin: number; priceCents: number; name: string }>;
  customerIds: Record<string, string>;
  resourceIds: Record<string, string>;
};

const SERVICES = [
  { key: 'gel_mani', name: 'Gel Manicure', zh: '甲油胶美甲', min: 45, cents: 4500 },
  { key: 'basic_mani', name: 'Classic Manicure', zh: '基础修手', min: 30, cents: 2500 },
  { key: 'dlx_pedi', name: 'Deluxe Pedicure', zh: '尊享足疗', min: 60, cents: 5500 },
] as const;

export async function seedCatalog(
  tx: postgres.TransactionSql,
  loc: SeededLocation,
  scenario: QaScenarioId,
  customers: Array<{ key: string; name: string; phone: string }>,
): Promise<ShopCatalog> {
  const J = (v: unknown) => tx.json(v as never);
  const catId = qaUuid(`cat:${scenario}:${loc.key}`);
  await tx`insert into service_categories (id, org_id, location_id, name, sort)
    values (${catId}, ${loc.orgId}, ${loc.locationId}, ${J({ en: 'Nails', 'zh-Hans': '美甲' })}, 1)`;

  const serviceIds: Record<string, string> = {};
  const serviceMeta: ShopCatalog['serviceMeta'] = {};
  for (const [i, s] of SERVICES.entries()) {
    const id = qaUuid(`svc:${scenario}:${loc.key}:${s.key}`);
    await tx`insert into services
      (id, org_id, location_id, category_id, name, duration_min, base_price_cents,
       online_bookable, is_addon, sort)
      values (${id}, ${loc.orgId}, ${loc.locationId}, ${catId},
              ${J({ en: s.name, 'zh-Hans': s.zh })}, ${s.min}, ${s.cents}, true, false, ${i})`;
    serviceIds[s.key] = id;
    serviceMeta[s.key] = { durationMin: s.min, priceCents: s.cents, name: s.name };
  }

  const typeId = qaUuid(`rtype:${scenario}:${loc.key}`);
  await tx`insert into resource_types (id, org_id, location_id, key, name)
    values (${typeId}, ${loc.orgId}, ${loc.locationId}, 'chair',
            ${J({ en: 'Chair', 'zh-Hans': '工位' })})`;
  const resourceIds: Record<string, string> = {};
  for (const n of ['Chair 1', 'Chair 2']) {
    const id = qaUuid(`res:${scenario}:${loc.key}:${n}`);
    await tx`insert into resources (id, org_id, location_id, resource_type_id, name)
      values (${id}, ${loc.orgId}, ${loc.locationId}, ${typeId}, ${n})`;
    resourceIds[n] = id;
  }

  const customerIds: Record<string, string> = {};
  for (const c of customers) {
    const id = qaUuid(`cust:${scenario}:${loc.key}:${c.key}`);
    await tx`insert into customers
      (id, org_id, primary_location_id, display_name, phone_e164, source)
      values (${id}, ${loc.orgId}, ${loc.locationId}, ${c.name}, ${c.phone}, 'desk')`;
    customerIds[c.key] = id;
  }

  return { serviceIds, serviceMeta, customerIds, resourceIds };
}

export async function seedTodayShifts(
  tx: postgres.TransactionSql,
  loc: SeededLocation,
  clock: QaClock,
): Promise<void> {
  const locClock = { ...clock, timezone: loc.timezone, cutoff: loc.cutoff };
  const date = businessDateOf(locClock);
  const now = locClock.now;
  for (const person of Object.values(loc.people)) {
    if (!person.bookable) continue;
    await tx`insert into shifts
      (org_id, location_id, membership_id, business_date, start_min, end_min, status, published_at)
      values (${loc.orgId}, ${loc.locationId}, ${person.membershipId}, ${date},
              570, 1170, 'published', ${iso(now)}::timestamptz)`;
    await tx`insert into rotation_participants
      (org_id, location_id, business_date, membership_id, in_rotation)
      values (${loc.orgId}, ${loc.locationId}, ${date}, ${person.membershipId}, true)`;
  }
}


