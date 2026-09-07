import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/setup';

const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
let ctx: Awaited<ReturnType<typeof buildContext>>;

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${tenant.locationId} and r.key in ('owner', 'manager') and m.user_id is not null
    limit 1`);
  ctx = await buildContext({ membershipId: owner!.id, userId: owner!.user_id });
});
afterAll(closeDb);

const svc = (id: string) => withTenant(tenant, (tx) => tx<{
  online_bookable: boolean; is_addon: boolean; taxable: boolean; active: boolean; staff_count: number;
}[]>`select online_bookable, is_addon, taxable, active, staff_count from services where id = ${id}`).then((r) => r[0]!);

const skillIdByKey = (key: string) => withTenant(tenant, (tx) => tx<{ id: string }[]>`
  select id from skills where location_id = ${tenant.locationId} and key = ${key}`).then((r) => r[0]!.id);

describe('catalog.saveService PATCH semantics (U04 / §7.2)', () => {
  it('new plain service defaults to online-bookable; new add-on does not', async () => {
    const plain = await dispatch<{ serviceId: string }>('catalog.saveService', {
      name: { en: 'Bulk plain', 'zh-Hans': 'Bulk plain' }, durationMin: 30, basePriceCents: 3000,
    }, ctx);
    const addon = await dispatch<{ serviceId: string }>('catalog.saveService', {
      name: { en: 'Bulk addon', 'zh-Hans': 'Bulk addon' }, durationMin: 10, basePriceCents: 1000, isAddon: true,
    }, ctx);
    expect(await svc(plain.result.serviceId)).toMatchObject({ online_bookable: true, is_addon: false });
    expect(await svc(addon.result.serviceId)).toMatchObject({ online_bookable: false, is_addon: true });
  });

  it('omitting a boolean on edit preserves it instead of resetting to the schema default', async () => {
    const created = await dispatch<{ serviceId: string }>('catalog.saveService', {
      name: { en: 'Keep flags', 'zh-Hans': 'Keep flags' }, durationMin: 40, basePriceCents: 4000,
      taxable: true, onlineBookable: true, staffCount: 2,
    }, ctx);
    // 只改时长，不传任何布尔 / 人数字段
    await dispatch('catalog.saveService', {
      serviceId: created.result.serviceId,
      name: { en: 'Keep flags', 'zh-Hans': 'Keep flags' }, durationMin: 55, basePriceCents: 4000,
    }, ctx);
    expect(await svc(created.result.serviceId)).toMatchObject({
      taxable: true, online_bookable: true, staff_count: 2, active: true,
    });
  });

  it('rejects making an add-on online-bookable', async () => {
    await expect(dispatch('catalog.saveService', {
      name: { en: 'Bad addon', 'zh-Hans': 'Bad addon' }, durationMin: 10, basePriceCents: 900,
      isAddon: true, onlineBookable: true,
    }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'addon_not_online_bookable' } });
  });
});

describe('catalog.bulkUpdateServices (U04 / §7.2)', () => {
  async function makeServices(n: number, over: Record<string, unknown> = {}) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await dispatch<{ serviceId: string }>('catalog.saveService', {
        name: { en: `Bulk ${i}-${Math.random()}`, 'zh-Hans': `Bulk ${i}` }, durationMin: 30, basePriceCents: 3000, ...over,
      }, ctx);
      ids.push(r.result.serviceId);
    }
    return ids;
  }

  it('sets online toggle + staff count across the selection in one transaction', async () => {
    const ids = await makeServices(3);
    const res = await dispatch<{ updated: number }>('catalog.bulkUpdateServices', {
      serviceIds: ids, set: { onlineBookable: false, staffCount: 2 },
    }, ctx);
    expect(res.result.updated).toBe(3);
    for (const id of ids) {
      expect(await svc(id)).toMatchObject({ online_bookable: false, staff_count: 2 });
    }
  });

  it('skillsAdd keeps existing requirements; skillsReplace overwrites them', async () => {
    const [id] = await makeServices(1);
    const gel = await skillIdByKey('gel');
    const acrylic = await skillIdByKey('acrylic');
    const pedicure = await skillIdByKey('pedicure');
    await dispatch('catalog.bulkUpdateServices', { serviceIds: [id!], set: { skillsAdd: [gel] } }, ctx);
    await dispatch('catalog.bulkUpdateServices', { serviceIds: [id!], set: { skillsAdd: [acrylic] } }, ctx);
    let rows = await withTenant(tenant, (tx) => tx<{ skill_id: string }[]>`
      select skill_id from service_skill_requirements where service_id = ${id!}`);
    expect(rows.map((r) => r.skill_id).sort()).toEqual([gel, acrylic].sort());
    await dispatch('catalog.bulkUpdateServices', { serviceIds: [id!], set: { skillsReplace: [pedicure] } }, ctx);
    rows = await withTenant(tenant, (tx) => tx<{ skill_id: string }[]>`
      select skill_id from service_skill_requirements where service_id = ${id!}`);
    expect(rows.map((r) => r.skill_id)).toEqual([pedicure]);
  });

  it('rejects the whole batch when any id is from another store — no partial write', async () => {
    const ids = await makeServices(2);
    const [foreign] = await withTenant(
      { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null },
      (tx) => tx<{ id: string }[]>`select id from services where location_id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' limit 1`,
    );
    await expect(dispatch('catalog.bulkUpdateServices', {
      serviceIds: [...ids, foreign!.id], set: { staffCount: 3 },
    }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const id of ids) {
      expect((await svc(id)).staff_count).toBe(1);
    }
  });

  it('rejects turning add-ons online-bookable', async () => {
    const ids = await makeServices(2, { isAddon: true });
    await expect(dispatch('catalog.bulkUpdateServices', {
      serviceIds: ids, set: { onlineBookable: true },
    }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'addon_not_online_bookable' } });
  });

  it('rejects an unknown skill id', async () => {
    const ids = await makeServices(1);
    await expect(dispatch('catalog.bulkUpdateServices', {
      serviceIds: ids, set: { skillsAdd: ['00000000-0000-4000-8000-000000000000'] },
    }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', details: { entity: 'skill' } });
  });
});
