/**
 * Phase 3 acceptance slice: arrival -> live ticket -> service -> payment.
 *
 * These tests intentionally cross command boundaries. A green unit test for each
 * command is not enough if the appointment, queue and ticket can drift apart.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDb, ts, withTenant } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/kiosk';
import './handlers/ticket';
import './handlers/staff';
import './handlers/resource';
import './handlers/rotation';
import { loadRooms } from './queries/rooms';
import { loadDayMoney } from './handlers/dayclose';
import { locationTaxCents } from './tax';

/** 莲花种子税率 8.875%。结账实收必须含服务端税额。 */
function dueCents(subtotalCents: number): number {
  return subtotalCents + locationTaxCents({
    afterDiscountCents: subtotalCents,
    salesTaxRatePercent: 8.875,
    taxCalculationMode: 'exclusive',
  });
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_LOCATION_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: ORG_ID, locationId: LOCATION_ID, membershipId: null };
const otherTenant = { orgId: OTHER_ORG_ID, locationId: OTHER_LOCATION_ID, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let membershipId = '';
let serviceId = '';
let servicePriceCents = 0;
let customerId = '';
let otherServiceId = '';
let otherMembershipId = '';
const appointmentIds: string[] = [];

async function businessDate(): Promise<string> {
  const [row] = await withTenant(tenant, (tx) => tx<{ value: string }[]>`
    select (((now() at time zone timezone) - business_day_cutoff)::date)::text as value
    from locations where id = ${LOCATION_ID}`);
  return row!.value;
}

async function createAppointment(): Promise<string> {
  const date = await businessDate();
  const startsAt = new Date(Date.now() + 30 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
  const id = await withTenant(tenant, async (tx) => {
    const [appointment] = await tx<{ id: string }[]>`
      insert into appointments
        (org_id, location_id, customer_id, business_date, starts_at, ends_at, source, created_by)
      values
        (${ORG_ID}, ${LOCATION_ID}, ${customerId}, ${date},
         ${ts(startsAt)}::timestamptz, ${ts(endsAt)}::timestamptz, 'desk', ${membershipId})
      returning id`;
    await tx`
      insert into appointment_items
        (org_id, location_id, appointment_id, service_id, membership_id,
         starts_at, ends_at, price_cents_snapshot, duration_min, seq)
      values
        (${ORG_ID}, ${LOCATION_ID}, ${appointment!.id}, ${serviceId}, ${membershipId},
         ${ts(startsAt)}::timestamptz, ${ts(endsAt)}::timestamptz,
         ${servicePriceCents}, 45, 0)`;
    return appointment!.id;
  });
  appointmentIds.push(id);
  return id;
}

const run = <T>(command: string, input: unknown, key: string = randomUUID()) =>
  dispatch<T>(command, input, ctx, { idempotencyKey: key });

const setCheckoutTiming = (timing: 'service_then_tip' | 'upfront_combined' | 'after_service_combined') =>
  withTenant(tenant, (tx) => tx`insert into location_checkout_settings (location_id, checkout_timing)
    values (${LOCATION_ID}, ${timing})
    on conflict (location_id) do update set checkout_timing = excluded.checkout_timing`);

beforeAll(async () => {
  const [staff] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${LOCATION_ID} and r.key in ('owner', 'manager')
    limit 1`);
  membershipId = staff!.id;
  ctx = await buildContext({ userId: staff!.user_id, membershipId });

  const [service] = await withTenant(tenant, (tx) => tx<{ id: string; price: number }[]>`
    select id, base_price_cents as price from services
    where location_id = ${LOCATION_ID} and active order by id limit 1`);
  serviceId = service!.id;
  servicePriceCents = service!.price;

  const [customer] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from customers where org_id = ${ORG_ID} and merged_into_id is null limit 1`);
  customerId = customer!.id;

  const [foreign] = await withTenant(otherTenant, (tx) => tx<{
    service_id: string; membership_id: string;
  }[]>`
    select s.id as service_id, sp.membership_id
    from services s
    cross join lateral (
      select membership_id from staff_profiles
      where location_id = ${OTHER_LOCATION_ID} and is_bookable = true
      limit 1
    ) sp
    where s.location_id = ${OTHER_LOCATION_ID} and s.active
    limit 1`);
  otherServiceId = foreign!.service_id;
  otherMembershipId = foreign!.membership_id;
});

afterEach(async () => {
  const ids = appointmentIds.splice(0);
  await setCheckoutTiming('after_service_combined');
  if (ids.length === 0) return;
  await withTenant(tenant, async (tx) => {
    const credits = await tx<{
      refund_id: string; ticket_id: string; customer_id: string; amount: number;
    }[]>`
      select tr.id as refund_id, tr.ticket_id, t.customer_id, tr.customer_credit_cents as amount
      from ticket_refunds tr join tickets t on t.id = tr.ticket_id
      where t.appointment_id = any(${ids}) and tr.customer_credit_cents > 0
        and tr.method = 'store_credit'
        and t.customer_id is not null
        and not exists (
          select 1 from customer_credit_ledger ccl
          where ccl.idem_key = 'test-cleanup-refund-' || tr.id::text
        )`;
    for (const credit of credits) {
      const [balance] = await tx<{ value: number }[]>`
        select coalesce(sum(amount_cents), 0)::int as value
        from customer_credit_ledger
        where kind = 'store_credit' and customer_id = ${credit.customer_id}`;
      await tx`insert into customer_credit_ledger
        (org_id, location_id, kind, subject_id, customer_id, entry,
         amount_cents, balance_after_cents, ticket_id, reason,
         actor_membership_id, idem_key, meta)
        values (${ORG_ID}, ${LOCATION_ID}, 'store_credit', ${credit.customer_id},
                ${credit.customer_id}, 'adjust', ${-credit.amount},
                ${(balance?.value ?? 0) - credit.amount}, ${credit.ticket_id},
                'Core loop test cleanup', ${membershipId},
                ${`test-cleanup-refund-${credit.refund_id}`},
                ${JSON.stringify({ testCleanup: true, refundId: credit.refund_id })}::jsonb)`;
    }
    // Financial rows are append-only. Detach and park test tickets, then remove
    // the scheduling/queue fixtures so repeated runs do not pollute the test shop.
    await tx`update earnings set reversed_at = coalesce(reversed_at, now()),
             reversed_by = ${membershipId}, business_date = '1985-01-01'
             where ticket_id in (select id from tickets where appointment_id = any(${ids}))`;
    await tx`update tip_allocations set reversed_at = coalesce(reversed_at, now()),
             reversed_by = ${membershipId}
             where ticket_id in (select id from tickets where appointment_id = any(${ids}))`;
    await tx`update cash_movements set business_date = '1985-01-01'
             where note in (
               select 'Refund ' || tr.id::text from ticket_refunds tr
               join tickets t on t.id = tr.ticket_id
               where t.appointment_id = any(${ids})
             )`;
    await tx`update tickets set appointment_id = null, business_date = '1985-01-01',
             status = 'voided', voided_at = coalesce(voided_at, now()),
             voided_by = coalesce(voided_by, ${membershipId}),
             void_reason = coalesce(void_reason, 'input_error')
             where appointment_id = any(${ids})`;
    await tx`delete from walkin_queue where appointment_id = any(${ids})`;
    await tx`delete from appointment_items where appointment_id = any(${ids})`;
    await tx`delete from appointments where id = any(${ids})`;
    await tx`delete from command_idempotency where location_id = ${LOCATION_ID}`;
  });
});

afterAll(async () => { await closeDb(); });

describe('预约到收银的真实闭环', () => {
  it.each([false, true])('multi-item seating, rollback and payment preserve resources (shared station: %s)', async (shared) => {
    const appointmentId = await createAppointment();
    await withTenant(tenant, (tx) => tx`insert into appointment_items
      (org_id, location_id, appointment_id, service_id, membership_id,
       starts_at, ends_at, price_cents_snapshot, duration_min, seq)
      select org_id, location_id, appointment_id, service_id, null,
       starts_at, ends_at, price_cents_snapshot, duration_min, 2
      from appointment_items where appointment_id = ${appointmentId}`);
    const [secondStaff] = await withTenant(tenant, (tx) => tx<{ membership_id: string }[]>`
      select sp.membership_id from staff_profiles sp join memberships m on m.id = sp.membership_id
      where sp.location_id = ${LOCATION_ID} and sp.is_bookable and m.status = 'active'
        and sp.membership_id <> ${membershipId} order by sp.membership_id limit 1`);
    const assignedStaff = [membershipId, shared ? membershipId : secondStaff!.membership_id];
    const firstRoom = (await run<{ resourceId: string }>('resource.save', {
      name: `Queue P0 ${randomUUID()}`, capacity: 1,
    })).result.resourceId;
    const secondRoom = shared ? firstRoom : (await run<{ resourceId: string }>('resource.save', {
      name: `Queue P0 ${randomUUID()}`, capacity: 1,
    })).result.resourceId;
    const opened = (await run<{ ticketId: string; ticketItemIds: string[]; subtotalCents: number }>('ticket.open', {
      appointmentId, customerId: null, items: [firstRoom, secondRoom].map((resourceId, index) => ({
        serviceId, membershipId: assignedStaff[index], minutes: 45, resourceId,
      })),
    })).result;
    const snapshots = await withTenant(tenant, (tx) => tx<{ membership_id: string; resource_id: string }[]>`
      select membership_id, resource_id from appointment_items where appointment_id = ${appointmentId} order by seq`);
    expect(snapshots).toEqual([firstRoom, secondRoom].map((resource_id, index) => ({ membership_id: assignedStaff[index], resource_id })));
    for (const [index, ticketItemId] of opened.ticketItemIds.entries()) await run('ticket.startItem', { ticketItemId, membershipId: assignedStaff[index] });
    const rooms = await withTenant(tenant, (tx) => loadRooms(tx, ctx));
    expect(rooms.rooms.find((room) => room.id === firstRoom)?.occupiedCount).toBe(1);
    for (const [index, ticketItemId] of opened.ticketItemIds.entries()) {
      await run('ticket.finishItem', { ticketItemId, membershipId: assignedStaff[index] });
      if (shared && index === 0) {
        const activeRoom = (await withTenant(tenant, (tx) => loadRooms(tx, ctx))).rooms.find((room) => room.id === firstRoom)!;
        expect(activeRoom.occupiedCount).toBe(1);
        expect(activeRoom.waitingCleaningCount).toBe(0);
      }
    }
    const rollback = { appointmentId, fromStage: 'ready_to_pay', targetStage: 'in_service', reason: 'service_restart' };
    // Reopening must not bypass housekeeping or leave the first item partially reopened.
    await run('resource.beginCleaning', { resourceId: secondRoom });
    await expect(run('queue.rollbackStage', rollback)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const stillFinished = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from ticket_items where ticket_id = ${opened.ticketId} and finished_at is not null`);
    expect(stillFinished[0]?.n).toBe(2);
    await run('resource.completeCleaning', { resourceId: secondRoom });
    await run('queue.rollbackStage', rollback);
    const reopened = await withTenant(tenant, (tx) => tx<{ finished_at: string | null; occupancy: string }[]>`
      select ti.finished_at, ro.status as occupancy from ticket_items ti
      join resource_occupancies ro on ro.ticket_item_id = ti.id and ro.resource_id = ti.resource_id
      where ti.ticket_id = ${opened.ticketId}`);
    expect(reopened).toHaveLength(2);
    expect(reopened.every((item) => item.finished_at === null && item.occupancy === 'in_use')).toBe(true);
    for (const [index, ticketItemId] of opened.ticketItemIds.entries()) await run('ticket.finishItem', { ticketItemId, membershipId: assignedStaff[index] });
    await run('ticket.pay', { ticketId: opened.ticketId, paymentStage: 'combined',
      payments: [{ method: 'cash', amountCents: dueCents(opened.subtotalCents), tipCents: 0,
        tenderedCents: dueCents(opened.subtotalCents) }],
    });
    for (const resourceId of new Set([firstRoom, secondRoom])) {
      await run('resource.beginCleaning', { resourceId });
      await run('resource.completeCleaning', { resourceId });
    }
  });

  it('真实角色权限边界与门店岗位一致', async () => {
    const roleContext = async (orgId: string, locationId: string, roleKey: string) => {
      const [member] = await withTenant(
        { orgId, locationId, membershipId: null },
        (tx) => tx<{ id: string; user_id: string }[]>`
          select m.id, m.user_id from memberships m
          join membership_roles mr on mr.membership_id = m.id
          join roles r on r.id = mr.role_id
          where m.location_id = ${locationId} and m.status = 'active'
            and r.key = ${roleKey} and m.user_id is not null
            and (${roleKey} <> 'tech' or not exists (
              select 1 from membership_roles other_mr
              join roles other_role on other_role.id = other_mr.role_id
              where other_mr.membership_id = m.id
                and other_role.key in ('owner','manager','front_desk')
            ))
          limit 1`,
      );
      return buildContext({ userId: member!.user_id, membershipId: member!.id });
    };

    const [owner, manager, frontDesk, technician] = await Promise.all([
      roleContext(OTHER_ORG_ID, OTHER_LOCATION_ID, 'owner'),
      roleContext(ORG_ID, LOCATION_ID, 'manager'),
      roleContext(ORG_ID, LOCATION_ID, 'front_desk'),
      roleContext(ORG_ID, LOCATION_ID, 'tech'),
    ]);

    for (const permission of ['queue.manage', 'ticket.write', 'ticket.void', 'dayclose.manage'] as const) {
      expect(owner.permissions.has(permission)).toBe(true);
    }
    expect(manager.permissions.has('queue.manage')).toBe(true);
    expect(manager.permissions.has('ticket.void')).toBe(true);
    expect(frontDesk.permissions.has('queue.manage')).toBe(true);
    expect(frontDesk.permissions.has('ticket.write')).toBe(true);
    expect(frontDesk.permissions.has('ticket.void')).toBe(false);
    expect(technician.permissions.has('ticket.write')).toBe(true);
    expect(technician.permissions.has('queue.manage')).toBe(false);
    expect(technician.permissions.has('ticket.void')).toBe(false);
  });

  it('签到、开工、完工、现金收银会推进同一条真实业务链', async () => {
    const appointmentId = await createAppointment();
    const queued = await run<{ queueId: string }>('queue.join', {
      appointmentId,
      customerId: null,
      source: 'desk',
    }, `checkin-${appointmentId}`);

    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `open-${appointmentId}`);
    expect(opened.result.ticketItemIds).toHaveLength(1);

    const added = await run<{ ticketItemId: string; subtotalCents: number }>('ticket.addItem', {
      ticketId: opened.result.ticketId,
      serviceId,
      membershipId,
      kind: 'addon',
      minutes: 45,
    }, `addon-${appointmentId}`);
    expect(added.result.subtotalCents).toBe(opened.result.subtotalCents + servicePriceCents);

    for (const ticketItemId of [...opened.result.ticketItemIds, added.result.ticketItemId]) {
      await run('ticket.startItem', { ticketItemId, membershipId });
      await run('ticket.finishItem', { ticketItemId, membershipId });
    }
    await run('ticket.close', {
      ticketId: opened.result.ticketId,
      payments: [{
        method: 'cash', amountCents: dueCents(added.result.subtotalCents),
        tipCents: 0, tenderedCents: dueCents(added.result.subtotalCents),
      }],
    }, `pay-${appointmentId}`);

    const [state] = await withTenant(tenant, (tx) => tx<{
      appointment_status: string; ticket_status: string; queue_status: string;
      ticket_customer_id: string | null;
    }[]>`
      select a.status as appointment_status, t.status as ticket_status,
             q.status as queue_status, t.customer_id as ticket_customer_id
      from appointments a
      join tickets t on t.appointment_id = a.id
      join walkin_queue q on q.id = ${queued.result.queueId}
      where a.id = ${appointmentId}`);
    expect(state).toEqual({
      appointment_status: 'done',
      ticket_status: 'closed',
      queue_status: 'completed',
      ticket_customer_id: customerId,
    });
  });

  it('先收项目款，完工后可确认无小费并关单', async () => {
    await setCheckoutTiming('service_then_tip');
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-a-${appointmentId}`);
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `timing-a-${appointmentId}`);

    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'service',
      payments: [{ method: 'card', amountCents: dueCents(opened.result.subtotalCents), tipCents: 0 }],
    }, `timing-a-service-${appointmentId}`);
    await expect(run('ticket.addItem', {
      ticketId: opened.result.ticketId, serviceId, membershipId,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await run('ticket.finishItem', { ticketItemId: opened.result.ticketItemIds[0]!, membershipId });
    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'tip',
      payments: [],
    }, `timing-a-tip-${appointmentId}`);

    const [closed] = await withTenant(tenant, (tx) => tx<{
      status: string; service_settled_at: string | null; tip_settled_at: string | null;
    }[]>`select status, service_settled_at::text, tip_settled_at::text
          from tickets where id = ${opened.result.ticketId}`);
    expect(closed?.status).toBe('closed');
    expect(closed?.service_settled_at).toBeTruthy();
    expect(closed?.tip_settled_at).toBeTruthy();
    await setCheckoutTiming('after_service_combined');
  });

  it('看板路径的两阶段收款：多项目单先收服务款，全部完工后按阶段键收小费', async () => {
    await setCheckoutTiming('service_then_tip');
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-stage-${appointmentId}`);
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `stage-open-${appointmentId}`);

    /*
     * 入座后立即加一项，复现看板上的真实单据形态：一位客人两项服务。
     * 单项目单走不到本用例要保护的路径 —— 服务款收过之后仍有项目未完工。
     * 加项必须在收服务款之前完成：结算之后条目即被冻结。
     */
    const added = await run<{ ticketItemId: string; subtotalCents: number }>('ticket.addItem', {
      ticketId: opened.result.ticketId,
      serviceId,
      membershipId,
      kind: 'addon',
      minutes: 45,
    }, `stage-addon-${appointmentId}`);
    const ticketItemIds = [...opened.result.ticketItemIds, added.result.ticketItemId];
    expect(ticketItemIds).toHaveLength(2);

    /*
     * 看板的幂等键格式为 `queue-pay-<ticketId>-<paymentStage>`。
     * 此处照搬该格式，用以固定 D7：两个阶段必须落在不同的键上。
     */
    const serviceKey = `queue-pay-${opened.result.ticketId}-service`;
    const tipKey = `queue-pay-${opened.result.ticketId}-tip`;

    const serviceDueCents = dueCents(added.result.subtotalCents);
    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'service',
      payments: [{ method: 'card', amountCents: serviceDueCents, tipCents: 0 }],
    }, serviceKey);

    // 服务款收完后仍未完工，此时收小费必须被拒绝，且要给出可执行的原因。
    await expect(run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'tip',
      payments: [{ method: 'cash', amountCents: 2000, tipCents: 2000 }],
    }, tipKey)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'tip_stage_not_available' },
    });

    for (const ticketItemId of ticketItemIds) {
      await run('ticket.finishItem', { ticketItemId, membershipId });
    }

    /*
     * 复用服务款阶段的幂等键会被判定为重放：命令不执行，小费收不进来，
     * 且不会报错 —— 这正是 D7 描述的失败形态，故在此固定住。
     */
    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'tip',
      payments: [{ method: 'cash', amountCents: 2000, tipCents: 2000 }],
    }, serviceKey);
    const [replayed] = await withTenant(tenant, (tx) => tx<{ tip_settled_at: string | null }[]>`
      select tip_settled_at::text from tickets where id = ${opened.result.ticketId}`);
    expect(replayed?.tip_settled_at).toBeNull();

    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'tip',
      payments: [{ method: 'cash', amountCents: 2000, tipCents: 2000 }],
    }, tipKey);

    const [settled] = await withTenant(tenant, (tx) => tx<{
      status: string; tip_cents: number;
      service_settled_at: string | null; tip_settled_at: string | null;
    }[]>`select status, tip_cents, service_settled_at::text, tip_settled_at::text
          from tickets where id = ${opened.result.ticketId}`);
    expect(settled?.status).toBe('closed');
    expect(settled?.tip_cents).toBe(2000);
    expect(settled?.service_settled_at).toBeTruthy();
    expect(settled?.tip_settled_at).toBeTruthy();
    await setCheckoutTiming('after_service_combined');
  });

  it('service_then_tip 下现场客做完才结账：两阶段窗口已过，允许一次性合并结清', async () => {
    await setCheckoutTiming('service_then_tip');
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-a2-${appointmentId}`);
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `timing-a2-${appointmentId}`);

    // 完工前从未收过服务款
    await run('ticket.finishItem', { ticketItemId: opened.result.ticketItemIds[0]!, membershipId });

    // combined 结清应放行（此前会抛 combined_stage_not_available，工单卡死）
    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'combined',
      payments: [{ method: 'card', amountCents: dueCents(opened.result.subtotalCents), tipCents: 0 }],
    }, `timing-a2-combined-${appointmentId}`);

    const [closed] = await withTenant(tenant, (tx) => tx<{
      status: string; service_settled_at: string | null; tip_settled_at: string | null;
    }[]>`select status, service_settled_at::text, tip_settled_at::text
          from tickets where id = ${opened.result.ticketId}`);
    expect(closed?.status).toBe('closed');
    expect(closed?.service_settled_at).toBeTruthy();
    expect(closed?.tip_settled_at).toBeTruthy();
    await setCheckoutTiming('after_service_combined');
  });

  it('service_then_tip 下服务未完工时，combined 结账仍被拒绝', async () => {
    await setCheckoutTiming('service_then_tip');
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-a3-${appointmentId}`);
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `timing-a3-${appointmentId}`);

    await expect(run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'combined',
      payments: [{ method: 'card', amountCents: dueCents(opened.result.subtotalCents), tipCents: 0 }],
    }, `timing-a3-combined-${appointmentId}`)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'combined_stage_not_available' },
    });
    await setCheckoutTiming('after_service_combined');
  });

  it('开工前合并收款，完工时自动关单且不重复收款', async () => {
    await setCheckoutTiming('upfront_combined');
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-b-${appointmentId}`);
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `timing-b-${appointmentId}`);

    await run('ticket.pay', {
      ticketId: opened.result.ticketId,
      paymentStage: 'combined',
      payments: [{ method: 'card', amountCents: dueCents(opened.result.subtotalCents), tipCents: 0 }],
    }, `timing-b-pay-${appointmentId}`);
    const [paid] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from tickets where id = ${opened.result.ticketId}`);
    expect(paid?.status).toBe('in_service');

    await run('ticket.finishItem', { ticketItemId: opened.result.ticketItemIds[0]!, membershipId });
    const [closed] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from tickets where id = ${opened.result.ticketId}`);
    expect(closed?.status).toBe('closed');
    await setCheckoutTiming('after_service_combined');
  });

  it('相同幂等键重放只开一张单，不同键也不能开第二张活跃单', async () => {
    const appointmentId = await createAppointment();
    const input = {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    };
    const key = `open-${appointmentId}`;
    const first = await run<{ ticketId: string }>('ticket.open', input, key);
    const replay = await run<{ ticketId: string }>('ticket.open', input, key);
    expect(replay.replayed).toBe(true);
    expect(replay.result.ticketId).toBe(first.result.ticketId);

    await expect(run('ticket.open', input, `${key}-different`))
      .rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: expect.objectContaining({ reason: 'appointment_ticket_exists' }),
      });

    const [count] = await withTenant(tenant, (tx) => tx<{ value: number }[]>`
      select count(*)::int as value from tickets
      where appointment_id = ${appointmentId} and status <> 'voided'`);
    expect(count!.value).toBe(1);
  });

  it('不能把预约挂到另一个客户名下', async () => {
    const appointmentId = await createAppointment();
    await expect(run('ticket.open', {
      appointmentId,
      customerId: randomUUID(),
      items: [{ serviceId, membershipId, minutes: 45 }],
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: expect.objectContaining({ reason: 'appointment_customer_mismatch' }),
    });
  });

  it('另一家店的服务和技师不能混入本店工单或加项', async () => {
    const appointmentId = await createAppointment();
    await expect(run('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId: otherMembershipId, minutes: 45 }],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const opened = await run<{ ticketId: string }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `open-${appointmentId}`);

    await expect(run('ticket.addItem', {
      ticketId: opened.result.ticketId,
      serviceId: otherServiceId,
      membershipId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run('ticket.addItem', {
      ticketId: opened.result.ticketId,
      serviceId,
      membershipId: otherMembershipId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('部分退款和全额退款会同步日结、现金与技师收入，退款账本不可篡改', async () => {
    const date = await businessDate();
    const baseline = await withTenant(tenant, (tx) => loadDayMoney(tx, LOCATION_ID, date));
    const appointmentId = await createAppointment();
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `open-${appointmentId}`);
    await run('ticket.startItem', {
      ticketItemId: opened.result.ticketItemIds[0], membershipId,
    });
    await run('ticket.finishItem', {
      ticketItemId: opened.result.ticketItemIds[0], membershipId,
    });
    const collectedCents = dueCents(opened.result.subtotalCents);
    await run('ticket.close', {
      ticketId: opened.result.ticketId,
      payments: [{
        method: 'cash', amountCents: collectedCents,
        tipCents: 0, tenderedCents: collectedCents,
      }],
    }, `pay-${appointmentId}`);

    const [commissionBefore] = await withTenant(tenant, (tx) => tx<{ value: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value from earnings
      where ticket_id = ${opened.result.ticketId} and kind = 'commission' and reversed_at is null`);
    const partialCents = Math.floor(opened.result.subtotalCents / 4);
    const partial = await run<{ status: string; refundedCents: number }>('ticket.refund', {
      ticketId: opened.result.ticketId,
      refundAmountCents: partialCents,
      refundTipCents: 0,
      reason: 'customer_dissatisfied',
      refundMethod: 'cash',
    }, `refund-partial-${appointmentId}`);
    expect(partial.result.status).toBe('closed');

    const afterPartial = await withTenant(tenant, (tx) => loadDayMoney(tx, LOCATION_ID, date));
    expect(afterPartial.netCents - baseline.netCents)
      .toBe(opened.result.subtotalCents - partialCents);
    expect(afterPartial.cashTakeCents - baseline.cashTakeCents).toBe(collectedCents);
    expect(afterPartial.movementsCents - baseline.movementsCents).toBe(-partialCents);

    const [commissionPartial] = await withTenant(tenant, (tx) => tx<{ value: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value from earnings
      where ticket_id = ${opened.result.ticketId} and kind = 'commission' and reversed_at is null`);
    expect(commissionPartial!.value).toBeGreaterThan(0);
    expect(commissionPartial!.value).toBeLessThan(commissionBefore!.value);

    const [creditBefore] = await withTenant(tenant, (tx) => tx<{ value: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value
      from customer_credit_ledger where kind = 'store_credit' and customer_id = ${customerId}`);
    const storeCreditCents = Math.floor(opened.result.subtotalCents / 4);
    await run('ticket.refund', {
      ticketId: opened.result.ticketId,
      refundAmountCents: storeCreditCents,
      refundTipCents: 0,
      reason: 'customer_dissatisfied',
      refundMethod: 'store_credit',
    }, `refund-credit-${appointmentId}`);
    const [creditAfter] = await withTenant(tenant, (tx) => tx<{ value: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value
      from customer_credit_ledger where kind = 'store_credit' and customer_id = ${customerId}`);
    expect(creditAfter!.value - creditBefore!.value).toBe(storeCreditCents);

    const remainingCents = collectedCents - partialCents - storeCreditCents;
    const full = await run<{ status: string }>('ticket.refund', {
      ticketId: opened.result.ticketId,
      refundAmountCents: remainingCents,
      refundTipCents: 0,
      reason: 'customer_dissatisfied',
      refundMethod: 'original_payment',
    }, `refund-full-${appointmentId}`);
    expect(full.result.status).toBe('refunded');

    const afterFull = await withTenant(tenant, (tx) => loadDayMoney(tx, LOCATION_ID, date));
    expect(afterFull.netCents).toBe(baseline.netCents);
    expect(afterFull.movementsCents - baseline.movementsCents)
      .toBe(-(collectedCents - storeCreditCents));

    const refunds = await withTenant(tenant, (tx) => tx<{ id: string; amount: number }[]>`
      select id, amount_cents as amount from ticket_refunds
      where ticket_id = ${opened.result.ticketId} order by created_at`);
    expect(refunds.map((refund) => refund.amount))
      .toEqual([partialCents, storeCreditCents, remainingCents]);
    await expect(withTenant(tenant, (tx) => tx`
      update ticket_refunds set amount_cents = 1 where id = ${refunds[0]!.id}`))
      .rejects.toThrow(/append-only|permission denied/i);
    const foreignView = await withTenant(otherTenant, (tx) => tx`
      select id from ticket_refunds where id = ${refunds[0]!.id}`);
    expect(foreignView).toHaveLength(0);
  });

  it('作废会回到已签到状态，并允许且只允许重开一张替代单', async () => {
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-${appointmentId}`);
    const input = {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    };
    const first = await run<{ ticketId: string }>('ticket.open', input, `open-${appointmentId}`);
    await run('ticket.void', { ticketId: first.result.ticketId, reason: 'input_error' });
    const replacement = await run<{ ticketId: string }>(
      'ticket.open', input, `reopen-${appointmentId}`,
    );
    expect(replacement.result.ticketId).not.toBe(first.result.ticketId);

    const rows = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from tickets where appointment_id = ${appointmentId} order by opened_at`);
    expect(rows.map((row) => row.status).sort()).toEqual(['in_service', 'voided']);
  });

  it('全额退款把排队记成离开并写原因，不因 left_reason 约束失败', async () => {
    const appointmentId = await createAppointment();
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-refund-${appointmentId}`);
    const opened = await run<{
      ticketId: string; ticketItemIds: string[]; subtotalCents: number;
    }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `open-refund-${appointmentId}`);
    await run('ticket.startItem', {
      ticketItemId: opened.result.ticketItemIds[0], membershipId,
    });
    await run('ticket.finishItem', {
      ticketItemId: opened.result.ticketItemIds[0], membershipId,
    });
    const collectedCents = dueCents(opened.result.subtotalCents);
    await run('ticket.close', {
      ticketId: opened.result.ticketId,
      payments: [{
        method: 'cash', amountCents: collectedCents,
        tipCents: 0, tenderedCents: collectedCents,
      }],
    }, `pay-refund-${appointmentId}`);

    const full = await run<{ status: string }>('ticket.refund', {
      ticketId: opened.result.ticketId,
      refundAmountCents: collectedCents,
      refundTipCents: 0,
      reason: 'customer_dissatisfied',
      refundMethod: 'original_payment',
    }, `refund-queue-${appointmentId}`);
    expect(full.result.status).toBe('refunded');

    const [queue] = await withTenant(tenant, (tx) => tx<{
      status: string; left_reason: string | null;
    }[]>`
      select status, left_reason from walkin_queue where appointment_id = ${appointmentId}`);
    expect(queue!.status).toBe('left');
    expect(queue!.left_reason).toBeTruthy();
  });

  it('客人改主意作废会取消预约，房间不再挂这场', async () => {
    const appointmentId = await createAppointment();
    const [resource] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from resources where location_id = ${LOCATION_ID} order by id limit 1`);
    expect(resource).toBeTruthy();
    await withTenant(tenant, (tx) => tx`
      update appointment_items set resource_id = ${resource!.id}
      where appointment_id = ${appointmentId}`);
    await run('queue.join', { appointmentId, source: 'desk' }, `checkin-void-${appointmentId}`);
    const opened = await run<{ ticketId: string }>('ticket.open', {
      appointmentId,
      customerId: null,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `open-void-${appointmentId}`);
    await run('ticket.void', { ticketId: opened.result.ticketId, reason: 'guest_changed_mind' });

    const [appt] = await withTenant(tenant, (tx) => tx<{
      appointment_status: string; item_status: string; queue_status: string; queue_reason: string | null;
    }[]>`
      select a.status as appointment_status, ai.status as item_status,
             q.status as queue_status, q.left_reason as queue_reason
      from appointments a
      join appointment_items ai on ai.appointment_id = a.id
      join walkin_queue q on q.appointment_id = a.id
      where a.id = ${appointmentId}`);
    expect(appt!.appointment_status).toBe('cancelled');
    expect(appt!.item_status).toBe('cancelled');
    expect(appt!.queue_status).toBe('left');
    expect(appt!.queue_reason).toBeTruthy();
  });

  it('客户储值并发消费只允许一笔成功，余额不会变成负数', async () => {
    const [customer] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into customers (org_id, display_name, source)
      values (${ORG_ID}, ${`Credit race ${randomUUID()}`}, 'desk') returning id`);
    const open = async (suffix: string) => (await run<{
      ticketId: string; subtotalCents: number;
    }>('ticket.open', {
      customerId: customer!.id,
      items: [{ serviceId, membershipId, minutes: 45 }],
    }, `credit-open-${suffix}-${randomUUID()}`)).result;
    const [first, second] = await Promise.all([open('a'), open('b')]);
    const openItems = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id in (${first.ticketId}, ${second.ticketId})`);
    for (const item of openItems) {
      await run('ticket.finishItem', { ticketItemId: item.id });
    }
    await withTenant(tenant, (tx) => tx`insert into customer_credit_ledger
      (org_id, location_id, kind, subject_id, customer_id, entry, amount_cents,
       balance_after_cents, reason, actor_membership_id, idem_key, meta)
      values (${ORG_ID}, ${LOCATION_ID}, 'store_credit', ${customer!.id}, ${customer!.id},
              'adjust', ${dueCents(first.subtotalCents)}, ${dueCents(first.subtotalCents)}, 'concurrency test',
              ${membershipId}, ${`credit-seed-${randomUUID()}`}, '{}'::jsonb)`);

    const close = (ticketId: string, amountCents: number) => dispatch(
      'ticket.close', { ticketId, payments: [{ method: 'customer_credit', amountCents, tipCents: 0 }] },
      ctx, { idempotencyKey: randomUUID() },
    );
    const results = await Promise.allSettled([
      close(first.ticketId, dueCents(first.subtotalCents)),
      close(second.ticketId, dueCents(second.subtotalCents)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'STORE_CREDIT_INSUFFICIENT' } });
    const [balance] = await withTenant(tenant, (tx) => tx<{ value: number; minimum: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value,
             min(balance_after_cents)::int as minimum
      from customer_credit_ledger where customer_id = ${customer!.id} and kind = 'store_credit'`);
    expect(balance).toEqual({ value: 0, minimum: 0 });
  });

  it('技师只能写自己被分配的服务备注，房态按开工、完工、清洁事务推进', async () => {
    const members = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where m.location_id = ${LOCATION_ID} and r.key = 'tech' and m.user_id is not null
        and not exists (
          select 1 from membership_roles x join roles xr on xr.id = x.role_id
          where x.membership_id = m.id and xr.key in ('owner','manager','front_desk')
        ) order by m.id limit 2`);
    expect(members).toHaveLength(2);
    const techCtx = await buildContext({ userId: members[0]!.user_id, membershipId: members[0]!.id });
    const otherCtx = await buildContext({ userId: members[1]!.user_id, membershipId: members[1]!.id });
    const [resource] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from resources where location_id = ${LOCATION_ID} and capacity = 1
      order by id limit 1`);
    await withTenant(tenant, (tx) => tx`update resources set status = 'available' where id = ${resource!.id}`);
    const opened = (await dispatch<{ ticketId: string; ticketItemIds: string[] }>(
      'ticket.open', {
        customerId,
        items: [{ serviceId, membershipId: members[0]!.id, resourceId: resource!.id, minutes: 45 }],
      }, ctx, { idempotencyKey: randomUUID() },
    )).result;
    const itemId = opened.ticketItemIds[0]!;

    await expect(dispatch('ticket.saveServiceNote', {
      ticketItemId: itemId, content: 'not mine', visibility: 'assigned_staff',
      containsSensitiveData: false,
    }, otherCtx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await dispatch('ticket.saveServiceNote', {
      ticketItemId: itemId, content: 'pressure level four', visibility: 'assigned_staff',
      containsSensitiveData: false,
    }, techCtx, { idempotencyKey: randomUUID() });
    await dispatch('ticket.startItem', { ticketItemId: itemId }, techCtx,
      { idempotencyKey: randomUUID() });
    await expect(withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from resources where id = ${resource!.id}`))
      .resolves.toEqual([{ status: 'in_use' }]);
    await dispatch('ticket.finishItem', { ticketItemId: itemId }, techCtx,
      { idempotencyKey: randomUUID() });
    await dispatch('resource.beginCleaning', { resourceId: resource!.id }, ctx,
      { idempotencyKey: randomUUID() });
    await dispatch('resource.completeCleaning', { resourceId: resource!.id }, ctx,
      { idempotencyKey: randomUUID() });
    const [state] = await withTenant(tenant, (tx) => tx<{
      status: string; occupancy: string; notes: number;
    }[]>`select r.status,
        (select status from resource_occupancies where ticket_item_id = ${itemId}) as occupancy,
        (select count(*)::int from ticket_service_notes where ticket_item_id = ${itemId}) as notes
      from resources r where r.id = ${resource!.id}`);
    expect(state).toEqual({ status: 'available', occupancy: 'released', notes: 1 });
  });
});
