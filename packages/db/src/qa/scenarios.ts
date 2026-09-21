import type postgres from 'postgres';
import {
  bootstrapTenant, ownerPerson, type QaPerson, type QaTenantSpec, type SeededTenant,
} from './bootstrap';
import { DEFAULT_QA_TIMEZONE, SECOND_QA_TIMEZONE, type QaClock } from './clock';
import { apply10DlcPending, openSupportRequest, recordClaimedSignup, seedPlatformOperator, submitStorefrontBrief } from './features';
import { qaEmail } from './ids';
import {
  createAppointment, issueGiftCard, joinQueue, openTicket, prepareDayCloseCount,
} from './lifecycle';
import { seedCatalog, seedTodayShifts, type ShopCatalog } from './shopData';
import { applyRecordedTopupFixture, applySavedPaymentMethodFixture, applyStripeSyncFixture } from './stripeFixture';
import type { CanonicalPlan, LocationStatus, QaScenarioId, RoleKey, SubscriptionStatus } from './types';

function staff(
  key: string,
  scenario: QaScenarioId,
  fullName: string,
  roles: RoleKey[],
  extra: Partial<QaPerson> = {},
): QaPerson {
  return {
    key,
    email: key === 'owner' ? qaEmail(scenario) : qaEmail(`${scenario}.${key}`),
    fullName,
    roles,
    bookable: extra.bookable ?? (roles.includes('tech') || roles.includes('senior_tech')),
    maxConc: extra.maxConc ?? 1,
    inRotation: extra.inRotation ?? (extra.bookable ?? true),
    gender: extra.gender ?? 'female',
    ...extra,
  };
}

function shop(
  scenario: QaScenarioId,
  args: {
    orgName: string;
    nameEn: string;
    nameZh: string;
    slug: string;
    status: LocationStatus;
    timezone?: string;
    extraStaff?: QaPerson[];
    ownerName?: string;
  },
): QaTenantSpec {
  const owner = ownerPerson(scenario, args.ownerName ?? 'QA Owner');
  owner.bookable = false;
  owner.inRotation = false;
  return {
    scenario,
    orgName: args.orgName,
    ownerKey: 'owner',
    plan: 'essential',
    locations: [{
      key: 'main',
      nameEn: args.nameEn,
      nameZh: args.nameZh,
      slug: args.slug,
      timezone: args.timezone ?? DEFAULT_QA_TIMEZONE,
      businessType: 'nail',
      cutoff: '04:00',
      status: args.status,
      staff: [owner, ...(args.extraStaff ?? [])],
    }],
  };
}

const CUSTOMERS_A = [
  { key: 'lisa', name: 'Lisa Park', phone: '+19175551001' },
  { key: 'emily', name: 'Emily Stone', phone: '+19175551002' },
];
const CUSTOMERS_B = [
  { key: 'chen', name: 'David Chen', phone: '+13235552001' },
  { key: 'wang', name: 'Ming Wang', phone: '+13235552002' },
];

async function withBilling(
  tx: postgres.TransactionSql,
  tenant: SeededTenant,
  locKey: string,
  clock: QaClock,
  plan: CanonicalPlan,
  status: SubscriptionStatus,
  topup?: boolean,
): Promise<void> {
  const loc = tenant.locations[locKey]!;
  await applyStripeSyncFixture(tx, {
    orgId: loc.orgId,
    locationId: loc.locationId,
    plan,
    subscriptionStatus: status,
    clock,
    scenarioKey: `${tenant.scenario}-${locKey}`,
  });
  // Paid (non-trial) Stripe Checkout leaves a default payment method on the
  // subscription. Project the same columns as billing.savePaymentMethod.
  if (status === 'active' || status === 'past_due') {
    await applySavedPaymentMethodFixture(tx, {
      locationId: loc.locationId,
      scenarioKey: `${tenant.scenario}-${locKey}`,
    });
  }
  if (topup) {
    await applyRecordedTopupFixture(tx, {
      orgId: loc.orgId,
      locationId: loc.locationId,
      unit: 'credit',
      scenarioKey: `${tenant.scenario}-${locKey}`,
    });
  }
}

async function populatedShop(
  tx: postgres.TransactionSql,
  tenant: SeededTenant,
  locKey: string,
  clock: QaClock,
  customers: typeof CUSTOMERS_A,
): Promise<ShopCatalog> {
  const loc = tenant.locations[locKey]!;
  const catalog = await seedCatalog(tx, loc, tenant.scenario, customers);
  await seedTodayShifts(tx, loc, clock);
  return catalog;
}

export const SCENARIO_SPECS: Record<QaScenarioId, () => QaTenantSpec | null> = {
  fresh_owner: () => shop('fresh_owner', {
    orgName: 'QA Fresh Owner',
    nameEn: 'Fresh Nails', nameZh: '新店', slug: 'qa-fresh-owner', status: 'setup',
  }),
  setup_incomplete: () => shop('setup_incomplete', {
    orgName: 'QA Setup Incomplete',
    nameEn: 'Setup Nails', nameZh: '配置中', slug: 'qa-setup-incomplete', status: 'setup',
  }),
  growth_setup: () => shop('growth_setup', {
    orgName: 'QA Growth Setup',
    nameEn: 'Growth Setup Nails', nameZh: '增长配置店', slug: 'qa-growth-setup', status: 'setup',
  }),
  empty_shop: () => shop('empty_shop', {
    orgName: 'QA Empty Shop',
    nameEn: 'Empty Nails', nameZh: '空店', slug: 'qa-empty-shop', status: 'active',
  }),
  essential_trial: () => shop('essential_trial', {
    orgName: 'QA Essential Trial',
    nameEn: 'Essential Trial Nails', nameZh: '试用店', slug: 'qa-essential-trial', status: 'active',
  }),
  voice_active: () => ({ ...shop('voice_active', { orgName: 'QA Voice Active', nameEn: 'Voice Nails', nameZh: '语音测试店', slug: 'qa-voice-active', status: 'active' }), plan: 'voice_booking' }),
  growth_active: () => shop('growth_active', {
    orgName: 'QA Growth Active',
    nameEn: 'Growth Nails', nameZh: '增长店', slug: 'qa-growth-active', status: 'active',
  }),
  past_due: () => shop('past_due', {
    orgName: 'QA Past Due',
    nameEn: 'Past Due Nails', nameZh: '欠费店', slug: 'qa-past-due', status: 'active',
  }),
  multi_location_owner: () => ({
    scenario: 'multi_location_owner',
    orgName: 'QA Multi Location',
    ownerKey: 'owner',
    plan: 'growth',
    locations: [
      {
        key: 'east',
        nameEn: 'East Side Nails', nameZh: '东店', slug: 'qa-multi-east',
        timezone: DEFAULT_QA_TIMEZONE, businessType: 'nail', cutoff: '04:00', status: 'active',
        staff: [
          ownerPerson('multi_location_owner', 'Multi Owner'),
          staff('tech', 'multi_location_owner', 'East Tech', ['tech'], { email: qaEmail('multi_location_owner.east.tech') }),
        ],
      },
      {
        key: 'west',
        nameEn: 'West Side Spa', nameZh: '西店', slug: 'qa-multi-west',
        timezone: SECOND_QA_TIMEZONE, businessType: 'foot_spa', cutoff: '03:00', status: 'active',
        staff: [
          { ...ownerPerson('multi_location_owner', 'Multi Owner'), email: qaEmail('multi_location_owner') },
          staff('tech', 'multi_location_owner', 'West Tech', ['tech'], { email: qaEmail('multi_location_owner.west.tech') }),
        ],
      },
    ],
  }),
  owner: () => shop('owner', {
    orgName: 'QA Owner Shop',
    nameEn: 'Owner Desk', nameZh: '老板店', slug: 'qa-owner', status: 'active',
    extraStaff: [staff('tech', 'owner', 'Owner Shop Tech', ['tech'])],
  }),
  manager_or_front_desk: () => shop('manager_or_front_desk', {
    orgName: 'QA Front Desk Shop',
    nameEn: 'Front Desk Nails', nameZh: '前台店', slug: 'qa-front-desk', status: 'active',
    extraStaff: [
      {
        key: 'front_desk',
        email: qaEmail('manager_or_front_desk'),
        fullName: 'QA Front Desk',
        roles: ['front_desk'],
        bookable: false,
        inRotation: false,
        gender: 'female',
      },
      staff('tech', 'manager_or_front_desk', 'Desk Shop Tech', ['tech']),
    ],
    ownerName: 'Hidden Owner',
  }),
  tech_only: () => shop('tech_only', {
    orgName: 'QA Tech Only Shop',
    nameEn: 'Tech Only Nails', nameZh: '技师店', slug: 'qa-tech-only', status: 'active',
    extraStaff: [{
      key: 'tech',
      email: qaEmail('tech_only'),
      fullName: 'QA Tech',
      roles: ['tech'],
      bookable: true,
      inRotation: true,
      gender: 'female',
    }],
    ownerName: 'Tech Shop Owner',
  }),
  busy_shop: () => shop('busy_shop', {
    orgName: 'QA Busy Shop',
    nameEn: 'Busy Nails', nameZh: '繁忙店', slug: 'qa-busy-shop', status: 'active',
    extraStaff: [
      staff('front_desk', 'busy_shop', 'Busy Desk', ['front_desk'], { bookable: false, inRotation: false }),
      staff('tech', 'busy_shop', 'Busy Tech', ['tech']),
      staff('tech2', 'busy_shop', 'Busy Tech Two', ['tech']),
    ],
  }),
  gift_card_shop: () => shop('gift_card_shop', {
    orgName: 'QA Gift Card Shop',
    nameEn: 'Gift Card Nails', nameZh: '礼品卡店', slug: 'qa-gift-card', status: 'active',
    extraStaff: [staff('front_desk', 'gift_card_shop', 'GC Desk', ['front_desk'], { bookable: false, inRotation: false })],
  }),
  day_close_ready: () => shop('day_close_ready', {
    orgName: 'QA Day Close Ready',
    nameEn: 'Day Close Nails', nameZh: '日结店', slug: 'qa-day-close', status: 'active',
    extraStaff: [
      staff('front_desk', 'day_close_ready', 'Close Desk', ['front_desk'], { bookable: false, inRotation: false }),
      staff('tech', 'day_close_ready', 'Close Tech', ['tech']),
    ],
  }),
  ten_dlc_pending: () => shop('ten_dlc_pending', {
    orgName: 'QA 10DLC Pending',
    nameEn: '10DLC Nails', nameZh: '短信审核店', slug: 'qa-10dlc', status: 'active',
  }),
  storefront_pending: () => shop('storefront_pending', {
    orgName: 'QA Storefront Pending',
    nameEn: 'Storefront Nails', nameZh: '建站店', slug: 'qa-storefront', status: 'active',
  }),
  support_request_open: () => shop('support_request_open', {
    orgName: 'QA Support Open',
    nameEn: 'Support Nails', nameZh: '工单店', slug: 'qa-support', status: 'active',
  }),
  platform_operator: () => null,
  revoked_platform_operator: () => null,
};

function overrideOwnerEmail(spec: QaTenantSpec, scenario: QaScenarioId): QaTenantSpec {
  if (scenario !== 'manager_or_front_desk' && scenario !== 'tech_only') return spec;
  const ownerEmail = qaEmail(`${scenario}.owner`);
  return {
    ...spec,
    locations: spec.locations.map((loc) => ({
      ...loc,
      staff: loc.staff.map((p) => p.key === 'owner' ? { ...p, email: ownerEmail } : p),
    })),
  };
}

export async function populateScenario(
  tx: postgres.TransactionSql,
  scenario: QaScenarioId,
  clock: QaClock,
): Promise<SeededTenant | { kind: 'platform'; userId: string; operatorId: string }> {
  if (scenario === 'platform_operator') {
    const op = await seedPlatformOperator(tx, {
      scenario, email: qaEmail(scenario), fullName: 'QA Platform Ops',
      role: 'super_admin', status: 'active', clock,
    });
    return { kind: 'platform', ...op };
  }
  if (scenario === 'revoked_platform_operator') {
    const op = await seedPlatformOperator(tx, {
      scenario, email: qaEmail(scenario), fullName: 'QA Revoked Ops',
      role: 'support', status: 'revoked', clock,
    });
    return { kind: 'platform', ...op };
  }

  const raw = SCENARIO_SPECS[scenario]();
  if (!raw) throw new Error(`missing spec ${scenario}`);
  const spec = overrideOwnerEmail(raw, scenario);
  const tenant = await bootstrapTenant(tx, spec);
  const main = tenant.locations[Object.keys(tenant.locations)[0]!]!;

  if (scenario === 'ten_dlc_pending' || scenario === 'support_request_open') {
    await seedPlatformOperator(tx, {
      scenario,
      email: qaEmail(`${scenario}.operator`),
      fullName: scenario === 'ten_dlc_pending' ? 'QA 10DLC Operator' : 'QA Support Operator',
      role: 'super_admin',
      status: 'active',
      clock,
    });
  }

  const billing: Partial<Record<QaScenarioId, { plan: CanonicalPlan; status: SubscriptionStatus; topup?: boolean }>> = {
    fresh_owner: { plan: 'essential', status: 'trialing' },
    setup_incomplete: { plan: 'essential', status: 'trialing' },
    growth_setup: { plan: 'growth', status: 'trialing' },
    empty_shop: { plan: 'essential', status: 'trialing' },
    essential_trial: { plan: 'essential', status: 'trialing' },
    growth_active: { plan: 'growth', status: 'active' },
    voice_active: { plan: 'voice_booking', status: 'active' },
    past_due: { plan: 'growth', status: 'past_due' },
    multi_location_owner: { plan: 'growth', status: 'active' },
    owner: { plan: 'growth', status: 'active' },
    manager_or_front_desk: { plan: 'growth', status: 'active' },
    tech_only: { plan: 'growth', status: 'active' },
    busy_shop: { plan: 'growth', status: 'active' },
    gift_card_shop: { plan: 'growth', status: 'active' },
    day_close_ready: { plan: 'growth', status: 'active' },
    ten_dlc_pending: { plan: 'essential', status: 'trialing' },
    storefront_pending: { plan: 'growth', status: 'active' },
    support_request_open: { plan: 'essential', status: 'trialing' },
  };

  for (const loc of Object.values(tenant.locations)) {
    const b = billing[scenario];
    if (b) {
      await withBilling(tx, tenant, loc.key, clock, b.plan, b.status, b.topup);
    }
  }

  if (scenario === 'fresh_owner' || scenario === 'setup_incomplete' || scenario === 'growth_setup') {
    await recordClaimedSignup(tx, tenant, main, scenario === 'growth_setup' ? 'growth' : 'essential');
  }

  if (scenario === 'empty_shop') {
    await seedCatalog(tx, main, scenario, []);
  }

  if (scenario === 'voice_active' || scenario === 'essential_trial' || scenario === 'growth_active' || scenario === 'past_due'
    || scenario === 'owner' || scenario === 'manager_or_front_desk' || scenario === 'tech_only') {
    await seedCatalog(tx, main, scenario, CUSTOMERS_A);
  }

  if (scenario === 'multi_location_owner') {
    const east = tenant.locations['east']!;
    const west = tenant.locations['west']!;
    const eastCat = await populatedShop(tx, tenant, 'east', clock, CUSTOMERS_A);
    const westCat = await populatedShop(tx, tenant, 'west', clock, CUSTOMERS_B);
    await createAppointment(tx, {
      scenario, loc: east, catalog: eastCat, clock, key: 'today',
      customerKey: 'lisa', staffKey: 'tech', serviceKey: 'gel_mani',
      time: '11:00', status: 'booked',
    });
    await createAppointment(tx, {
      scenario, loc: west, catalog: westCat, clock, key: 'today',
      customerKey: 'chen', staffKey: 'tech', serviceKey: 'dlx_pedi',
      time: '14:00', status: 'booked', source: 'web',
    });
  }

  if (scenario === 'busy_shop') {
    const catalog = await populatedShop(tx, tenant, 'main', clock, [
      ...CUSTOMERS_A,
      { key: 'walkin', name: 'Walk-In Guest', phone: '+19175551009' },
    ]);
    const booked = await createAppointment(tx, {
      scenario, loc: main, catalog, clock, key: 'booked',
      customerKey: 'lisa', staffKey: 'tech', serviceKey: 'gel_mani',
      time: '16:00', status: 'booked',
    });
    void booked;
    const inService = await createAppointment(tx, {
      scenario, loc: main, catalog, clock, key: 'inservice',
      customerKey: 'emily', staffKey: 'tech2', serviceKey: 'basic_mani',
      time: '10:00', status: 'in_service',
    });
    await openTicket(tx, {
      scenario, loc: main, catalog, clock, key: 'inservice',
      customerKey: 'emily', staffKey: 'tech2', serviceKey: 'basic_mani',
      appointmentId: inService.appointmentId, openedAt: inService.startsAt, status: 'in_service',
    });
    const queued = await createAppointment(tx, {
      scenario, loc: main, catalog, clock, key: 'queue',
      customerKey: 'walkin', staffKey: 'tech', serviceKey: 'basic_mani',
      time: '10:30', status: 'checked_in', source: 'walkin',
    });
    await joinQueue(tx, {
      scenario, loc: main, catalog, clock, key: 'wait',
      customerKey: 'walkin', ticketNumber: 101, status: 'waiting',
      appointmentId: queued.appointmentId,
    });
  }

  if (scenario === 'gift_card_shop') {
    const catalog = await populatedShop(tx, tenant, 'main', clock, CUSTOMERS_A);
    await issueGiftCard(tx, {
      scenario, loc: main, catalog, key: 'active',
      customerKey: 'lisa', faceValueCents: 10000, salePriceCents: 8000,
    });
  }

  if (scenario === 'day_close_ready') {
    const catalog = await populatedShop(tx, tenant, 'main', clock, CUSTOMERS_A);
    const a = await createAppointment(tx, {
      scenario, loc: main, catalog, clock, key: 'closed',
      customerKey: 'lisa', staffKey: 'tech', serviceKey: 'gel_mani',
      time: '11:00', status: 'completed',
    });
    const closed = await openTicket(tx, {
      scenario, loc: main, catalog, clock, key: 'closed',
      customerKey: 'lisa', staffKey: 'tech', serviceKey: 'gel_mani',
      appointmentId: a.appointmentId, openedAt: a.startsAt, status: 'closed',
      closed: { method: 'card', tipCents: 800 },
    });
    await prepareDayCloseCount(tx, {
      loc: main, clock, countedCashCents: 0, cardTerminalCents: closed.totalCents,
    });
  }

  if (scenario === 'ten_dlc_pending') {
    await seedCatalog(tx, main, scenario, CUSTOMERS_A);
    await apply10DlcPending(tx, main);
  }

  if (scenario === 'storefront_pending') {
    await seedCatalog(tx, main, scenario, CUSTOMERS_A);
    await submitStorefrontBrief(tx, main, scenario);
  }

  if (scenario === 'support_request_open') {
    await seedCatalog(tx, main, scenario, CUSTOMERS_A);
    await openSupportRequest(tx, main, scenario, ['open', 'in_progress', 'resolved'], clock);
  }

  return tenant;
}
