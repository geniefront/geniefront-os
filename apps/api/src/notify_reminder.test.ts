/**
 * 次日预约提醒的取件口径（sql/0088 的 `gf_appointments_due_for_reminder`）。
 *
 * 这一组测的全是**边界**，因为口径错的表现都是安静的：
 * 多发一天等于骚扰，少发一天等于顾客白等，两者都不会报错。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, withTenant, closeDb } from '@gf/db';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let timezone = '';
const madeAppointments: string[] = [];

interface DueRow { org_id: string; location_id: string; appointment_id: string }

/** 取件。`sendHour = 0` 表示「不看时点」，专门用来测日期那一维。 */
async function due(sendHour = 0): Promise<DueRow[]> {
  return sql<DueRow[]>`
    select * from gf_appointments_due_for_reminder(${sendHour}, 500)`;
}

/**
 * 在门店本地时间的第 `dayOffset` 天、`hour` 点建一张单。
 *
 * ⚠️ 时刻由数据库按门店时区算，不在 JS 里拼 —— 夏令时切换那两天，
 * 「本地明天 14:00」与「此刻 + 24 小时」不是同一个瞬间。
 */
async function makeAppointment(dayOffset: number, hour = 14): Promise<string> {
  const id = await withTenant(tenant, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into appointments
        (org_id, location_id, walk_in_name, business_date, starts_at, ends_at, status)
      select ${NAIL_ORG}, ${NAIL_LOC}, 'Reminder Test',
             ((now() at time zone ${timezone})::date + ${dayOffset}::int),
             (((now() at time zone ${timezone})::date + ${dayOffset}::int)::timestamp
               + make_interval(hours => ${hour}::int)) at time zone ${timezone},
             (((now() at time zone ${timezone})::date + ${dayOffset}::int)::timestamp
               + make_interval(hours => ${hour + 1}::int)) at time zone ${timezone},
             'booked'
      returning id`;
    return row!.id;
  });
  madeAppointments.push(id);
  return id;
}

beforeAll(async () => {
  const [loc] = await withTenant(tenant, (tx) => tx<{ timezone: string }[]>`
    select timezone from locations where id = ${NAIL_LOC}`);
  timezone = loc!.timezone;
});

afterAll(async () => {
  if (madeAppointments.length > 0) {
    await withTenant(tenant, (tx) => tx`
      delete from appointments where id = any(${madeAppointments})`);
  }
  await closeDb();
});

describe('次日提醒取件', () => {
  it('⭐ 只取门店本地日期意义上的「明天」', async () => {
    const tomorrow = await makeAppointment(1);
    const today = await makeAppointment(0);
    const dayAfter = await makeAppointment(2);

    const ids = (await due()).map((r) => r.appointment_id);
    expect(ids).toContain(tomorrow);
    expect(ids).not.toContain(today);
    expect(ids).not.toContain(dayAfter);
  });

  /**
   * ⚠️ 本地时间未到发送时点就不发。整天平摊的话，凌晨两点会给顾客发短信。
   * 这里用 `sendHour = 24`（永远到不了）来构造「还没到点」。
   */
  it('本地时间没到发送时点就一条都不取', async () => {
    await makeAppointment(1);
    expect(await due(24)).toHaveLength(0);
  });

  it('已取消的单不提醒', async () => {
    const cancelled = await makeAppointment(1);
    await withTenant(tenant, (tx) => tx`
      update appointments set status = 'cancelled' where id = ${cancelled}`);

    const ids = (await due()).map((r) => r.appointment_id);
    expect(ids).not.toContain(cancelled);
  });

  /**
   * ⭐ 排过一次就不再返回。
   *
   * 去重本可以只靠发件箱的唯一索引，但那样每一轮都会为同一批预约白跑一遍
   * 事务 —— 一家有两百单的店，每半小时就是两百次无谓的渲染。
   */
  it('已经排过提醒的不再返回', async () => {
    const appt = await makeAppointment(1);
    expect((await due()).map((r) => r.appointment_id)).toContain(appt);

    await withTenant(tenant, (tx) => tx`
      insert into sms_outbox
        (org_id, location_id, kind, to_e164, from_e164, body, segments,
         entity_type, entity_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'appointment_reminder', '+16175551111',
              '+18005550199', 'GenieFront: reminder. Reply STOP to opt out.', 1,
              'appointment', ${appt})`);

    expect((await due()).map((r) => r.appointment_id)).not.toContain(appt);
  });

  it('返回的行带着 org 与 location —— 调用方要按门店进 withTenant', async () => {
    await makeAppointment(1);
    const rows = await due();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.org_id).toBeTruthy();
      expect(r.location_id).toBeTruthy();
    }
  });
});
