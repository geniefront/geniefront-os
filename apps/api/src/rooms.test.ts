/**
 * 房间与工位看板及管理测试（P0 房态看板）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/resource';
import { loadRooms } from './queries/rooms';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
const createdResourceIds: string[] = [];

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });
});

afterAll(async () => {
  for (const id of createdResourceIds) {
    await withTenant(tenant, (tx) => tx`delete from resources where id = ${id}`);
  }
  await closeDb();
});

describe('resource.save & loadRooms & resource.setStatus', () => {
  it('创建工位/房间资源', async () => {
    const res = await dispatch<{ resourceId: string; created: boolean }>(
      'resource.save',
      {
        name: 'VIP Room 1',
        type: 'vip',
        capacity: 2,
        maxStaff: 2,
      },
      ownerCtx,
    );

    expect(res.result.created).toBe(true);
    expect(res.result.resourceId).toBeTruthy();
    createdResourceIds.push(res.result.resourceId);
  });

  it('查询房间列表并包含所创建的房间与概览指标', async () => {
    const list = await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx));
    expect(list.rooms.length).toBeGreaterThan(0);
    expect(list.metrics).toBeDefined();
    expect(list.metrics.total).toBeGreaterThan(0);
    expect(typeof list.metrics.occupancyRate).toBe('number');
    const vip = list.rooms.find((r) => r.id === createdResourceIds[0]);
    expect(vip).toBeTruthy();
    expect(vip?.name).toBe('VIP Room 1');
    expect(vip?.capacity).toBe(2);
    expect(vip?.status).toBe('available');
    expect(Array.isArray(vip?.todaySlots)).toBe(true);
  });

  it('人工状态只允许维护开关，服务与清洁状态由工作流推进', async () => {
    const resId = createdResourceIds[0]!;
    await expect(dispatch('resource.setStatus', {
        resourceId: resId,
        status: 'cleaning',
        note: '技师已完成服务，保洁清理中',
      }, ownerCtx)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'resource_state_is_workflow_managed' },
      });

    const res = await dispatch<{ resourceId: string; status: string }>(
      'resource.setStatus', { resourceId: resId, status: 'maintenance' }, ownerCtx);
    expect(res.result.status).toBe('maintenance');

    const list = await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx));
    const vip = list.rooms.find((r) => r.id === resId);
    expect(vip?.status).toBe('maintenance');

    await dispatch('resource.setStatus', { resourceId: resId, status: 'available' }, ownerCtx);
  });

  it('编辑房间名称和容量配置', async () => {
    const resId = createdResourceIds[0]!;
    const res = await dispatch<{ resourceId: string; created: boolean }>(
      'resource.save',
      {
        resourceId: resId,
        name: 'VIP Suite A',
        capacity: 3,
      },
      ownerCtx,
    );

    expect(res.result.created).toBe(false);

    const list = await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx));
    const vip = list.rooms.find((r) => r.id === resId);
    expect(vip?.name).toBe('VIP Suite A');
    expect(vip?.capacity).toBe(3);
  });

  it('删除工位/房间资源并从看板中移除', async () => {
    const resId = createdResourceIds[0]!;
    const res = await dispatch<{ resourceId: string; deleted: boolean }>(
      'resource.delete',
      {
        resourceId: resId,
        force: true,
      },
      ownerCtx,
    );

    expect(res.result.deleted).toBe(true);

    const list = await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx));
    const deleted = list.rooms.find((r) => r.id === resId);
    expect(deleted).toBeUndefined();
  });
});

describe('real occupancy and cleaning', () => {
  it('shows all occupied ticket items, with real order links, and blocks maintenance', async () => {
    const { result } = await dispatch<{ resourceId: string }>('resource.save', { name: 'Occupancy regression', capacity: 4 }, ownerCtx);
    const id = result.resourceId;
    try {
      const items = await withTenant(tenant, (tx) => tx<{ id: string; ticket_id: string }[]>`
        select ti.id, ti.ticket_id from ticket_items ti join tickets t on t.id = ti.ticket_id
        where t.location_id = ${NAIL_LOC} order by ti.id limit 2`);
      expect(items).toHaveLength(2);
      await withTenant(tenant, async (tx) => {
        for (const item of items) await tx`insert into resource_occupancies (org_id, location_id, resource_id, ticket_item_id, status)
          values (${NAIL_ORG}, ${NAIL_LOC}, ${id}, ${item.id}, 'in_use')`;
      });
      const room = (await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx))).rooms.find((room) => room.id === id)!;
      expect(room.status).toBe('in_service');
      expect(room.occupiedCount).toBe(2);
      expect(room.currentSessions.map((session) => session.ticketId).sort()).toEqual(items.map((item) => item.ticket_id).sort());
      await expect(dispatch('resource.setStatus', { resourceId: id, status: 'maintenance' }, ownerCtx)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      await withTenant(tenant, async (tx) => {
        await tx`update resource_occupancies set status = 'cleaning_required' where resource_id = ${id} and ticket_item_id = ${items[0]!.id}`;
        await tx`update resources set status = 'in_use' where id = ${id}`;
      });
      await dispatch('resource.beginCleaning', { resourceId: id }, ownerCtx);
      await dispatch('resource.completeCleaning', { resourceId: id }, ownerCtx, { idempotencyKey: crypto.randomUUID() });
      const partiallyOccupied = (await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx))).rooms.find((room) => room.id === id)!;
      expect(partiallyOccupied.status).toBe('in_service');
      expect(partiallyOccupied.occupiedCount).toBe(1);
      expect(partiallyOccupied.cleaningCount).toBe(0);

    } finally {
      await withTenant(tenant, async (tx) => {
        await tx`update resource_occupancies set status = 'released', released_at = now() where resource_id = ${id}`;
      });
    }
  });

  it('allows scheduled housekeeping on an empty room and completes the workflow', async () => {
    const { result } = await dispatch<{ resourceId: string }>('resource.save', { name: 'Housekeeping regression' }, ownerCtx);
    createdResourceIds.push(result.resourceId);
    await dispatch('resource.beginCleaning', { resourceId: result.resourceId }, ownerCtx);
    let room = (await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx))).rooms.find((room) => room.id === result.resourceId)!;
    expect(room.status).toBe('cleaning');
    await dispatch('resource.completeCleaning', { resourceId: result.resourceId }, ownerCtx, { idempotencyKey: crypto.randomUUID() });
    room = (await withTenant(tenant, (tx) => loadRooms(tx, ownerCtx))).rooms.find((room) => room.id === result.resourceId)!;
    expect(room.status).toBe('available');
    expect(room.currentSessions).toEqual([]);
  });
});

it('a booked time window alone does not imply a seated guest', async () => {
  const { result } = await dispatch<{ resourceId: string }>('resource.save', { name: 'Unarrived booking regression' }, ownerCtx);
  createdResourceIds.push(result.resourceId);
  const rollback = new Error('rollback test fixture');
  try {
    await withTenant(tenant, async (tx) => {
      const [item] = await tx<{ id: string }[]>`select id from appointment_items where location_id = ${NAIL_LOC} order by starts_at desc limit 1`;
      expect(item).toBeDefined();
      await tx`update appointment_items set resource_id = ${result.resourceId}, membership_id = null,
        status = 'booked', starts_at = now() - interval '1 minute', ends_at = now() + interval '20 minutes'
        where id = ${item!.id}`;
      const room = (await loadRooms(tx, ownerCtx)).rooms.find((room) => room.id === result.resourceId)!;
      expect(room.todaySlots.length).toBe(1);
      expect(room.status).toBe('available');
      expect(room.currentSession).toBeUndefined();
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
});
