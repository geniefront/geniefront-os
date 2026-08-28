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

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: ORG_ID, locationId: LOCATION_ID, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let membershipId = '';
let serviceId = '';
let servicePriceCents = 0;
let customerId = '';
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
});

afterEach(async () => {
  const ids = appointmentIds.splice(0);
  if (ids.length === 0) return;
  await withTenant(tenant, async (tx) => {
    // Financial rows are append-only. Detach and park test tickets, then remove
    // the scheduling/queue fixtures so repeated runs do not pollute the test shop.
    await tx`update earnings set reversed_at = coalesce(reversed_at, now()),
             reversed_by = ${membershipId}, business_date = '1985-01-01'
             where ticket_id in (select id from tickets where appointment_id = any(${ids}))`;
    await tx`update tip_allocations set reversed_at = coalesce(reversed_at, now()),
             reversed_by = ${membershipId}
             where ticket_id in (select id from tickets where appointment_id = any(${ids}))`;
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

    await run('ticket.startItem', {
      ticketItemId: opened.result.ticketItemIds[0], membershipId,
    });
    await run('ticket.finishItem', {
      ticketItemId: opened.result.ticketItemIds[0], membershipId,
    });
    await run('ticket.close', {
      ticketId: opened.result.ticketId,
      payments: [{
        method: 'cash', amountCents: opened.result.subtotalCents,
        tipCents: 0, tenderedCents: opened.result.subtotalCents,
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
});
