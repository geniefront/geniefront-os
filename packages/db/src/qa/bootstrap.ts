import { ROLE_PRESETS } from '@gf/contracts';
import type postgres from 'postgres';
import { insertLocalAuthIdentity, upsertQaAuthUser } from './auth';
import { publicKeyFor, qaEmail, qaUuid } from './ids';
import {
  QA_SEED_MARKER, type CanonicalPlan, type LocationStatus, type QaScenarioId, type RoleKey,
} from './types';

const DEFAULT_HOURS = {
  mon: { open: '09:30', close: '19:30' },
  tue: { open: '09:30', close: '19:30' },
  wed: { open: '09:30', close: '19:30' },
  thu: { open: '09:30', close: '19:30' },
  fri: { open: '09:30', close: '20:00' },
  sat: { open: '09:00', close: '20:00' },
  sun: { open: '10:00', close: '18:00' },
};

export type QaPerson = {
  key: string;
  email: string;
  fullName: string;
  roles: RoleKey[];
  bookable: boolean;
  maxConc?: number;
  inRotation?: boolean;
  gender?: 'female' | 'male' | null;
};

export type QaLocationSpec = {
  key: string;
  nameEn: string;
  nameZh: string;
  slug: string;
  timezone: string;
  businessType: 'nail' | 'foot_spa' | 'massage';
  cutoff: string;
  status: LocationStatus;
  staff: QaPerson[];
};

export type QaTenantSpec = {
  scenario: QaScenarioId;
  orgName: string;
  ownerKey: string;
  plan: CanonicalPlan;
  locations: QaLocationSpec[];
};

export type SeededPerson = {
  key: string;
  userId: string;
  email: string;
  membershipId: string;
  roles: RoleKey[];
  bookable: boolean;
};

export type SeededLocation = {
  key: string;
  orgId: string;
  locationId: string;
  timezone: string;
  cutoff: string;
  status: LocationStatus;
  people: Record<string, SeededPerson>;
  roleIds: Record<string, string>;
};

export type SeededTenant = {
  scenario: QaScenarioId;
  orgId: string;
  ownerUserId: string;
  locations: Record<string, SeededLocation>;
};

export function ownerPerson(scenario: QaScenarioId, fullName: string): QaPerson {
  return {
    key: 'owner',
    email: qaEmail(scenario),
    fullName,
    roles: ['owner'],
    bookable: false,
    inRotation: false,
    gender: null,
  };
}

export async function bootstrapTenant(
  tx: postgres.TransactionSql,
  spec: QaTenantSpec,
): Promise<SeededTenant> {
  const J = (v: unknown) => tx.json(v as never);
  const orgId = qaUuid(`org:${spec.scenario}`);
  const owner = spec.locations[0]?.staff.find((p) => p.key === spec.ownerKey);
  if (!owner) throw new Error(`QA scenario ${spec.scenario} is missing owner person`);
  const ownerUserId = await upsertQaAuthUser(owner.email, owner.fullName);
  await insertLocalAuthIdentity(tx, {
    userId: ownerUserId, email: owner.email, fullName: owner.fullName,
  });

  await tx`insert into users (id, email, full_name, locale)
    values (${ownerUserId}, ${owner.email}, ${owner.fullName}, 'en')
    on conflict (id) do update set email = excluded.email, full_name = excluded.full_name`;

  await tx`insert into organizations (id, name, owner_user_id, default_locale)
    values (${orgId}, ${spec.orgName}, ${ownerUserId}, 'en')`;

  const locations: Record<string, SeededLocation> = {};

  for (const loc of spec.locations) {
    const locationId = qaUuid(`loc:${spec.scenario}:${loc.key}`);
    const settings = {
      qa_seed: QA_SEED_MARKER,
      qa_scenario: spec.scenario,
      capacity: { slot_minutes: 15, max_concurrent_per_slot: null, overbook: 'warn' },
      online_booking: {
        enabled: loc.status === 'active',
        max_days_ahead: 60, min_minutes_ahead: 120,
        require_phone_verification: false, cancel_cutoff_hours: 4,
      },
    };
    await tx`insert into locations
      (id, org_id, name, slug, timezone, business_type, public_key, business_day_cutoff,
       business_hours, settings, status)
      values
      (${locationId}, ${orgId},
       ${J({ en: loc.nameEn, 'zh-Hans': loc.nameZh })}, ${loc.slug},
       ${loc.timezone}, ${loc.businessType}, ${publicKeyFor(locationId)}, ${loc.cutoff},
       ${J(DEFAULT_HOURS)}, ${J(settings)}, ${loc.status})`;

    const roleIds: Record<string, string> = {};
    for (const [key, perms] of Object.entries(ROLE_PRESETS)) {
      const roleId = qaUuid(`role:${spec.scenario}:${loc.key}:${key}`);
      await tx`insert into roles (id, org_id, location_id, key, name, is_preset)
        values (${roleId}, ${orgId}, ${locationId}, ${key}, ${J({ en: key })}, true)`;
      roleIds[key] = roleId;
      for (const permission of perms) {
        await tx`insert into role_permissions (role_id, permission)
          values (${roleId}, ${permission})`;
      }
    }

    const people: Record<string, SeededPerson> = {};
    for (const person of loc.staff) {
      const userId = person.key === spec.ownerKey
        ? ownerUserId
        : await upsertQaAuthUser(person.email, person.fullName);
      if (person.key !== spec.ownerKey) {
        await insertLocalAuthIdentity(tx, {
          userId, email: person.email, fullName: person.fullName,
        });
        await tx`insert into users (id, email, full_name, locale)
          values (${userId}, ${person.email}, ${person.fullName}, 'en')
          on conflict (id) do update set email = excluded.email, full_name = excluded.full_name`;
      }
      const membershipId = qaUuid(`mem:${spec.scenario}:${loc.key}:${person.key}`);
      await tx`insert into memberships (id, org_id, location_id, user_id, status, started_on)
        values (${membershipId}, ${orgId}, ${locationId}, ${userId}, 'active', current_date)`;
      for (const role of person.roles) {
        await tx`insert into membership_roles (membership_id, role_id)
          values (${membershipId}, ${roleIds[role]!})`;
      }
      await tx`insert into staff_profiles
        (membership_id, org_id, location_id, display_name, gender, is_bookable,
         max_concurrent_appointments)
        values (${membershipId}, ${orgId}, ${locationId},
                ${J({ en: person.fullName, 'zh-Hans': person.fullName })},
                ${person.gender ?? null}, ${person.bookable}, ${person.maxConc ?? 1})`;
      people[person.key] = {
        key: person.key,
        userId,
        email: person.email,
        membershipId,
        roles: person.roles,
        bookable: person.bookable,
      };
    }

    await tx`insert into user_last_location (user_id, location_id, at)
      values (${ownerUserId}, ${locationId}, now())
      on conflict (user_id) do update
      set location_id = excluded.location_id, at = excluded.at`;

    locations[loc.key] = {
      key: loc.key,
      orgId,
      locationId,
      timezone: loc.timezone,
      cutoff: loc.cutoff,
      status: loc.status,
      people,
      roleIds,
    };
  }

  return { scenario: spec.scenario, orgId, ownerUserId, locations };
}
