import { buildContext } from './actor';
import { dispatch } from './bus';
import { runReminderSweep } from './notify/reminder';
import { wallMinuteToInstant } from '@gf/scheduling';
import './handlers/appointment';
import './handlers/notify';
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


it('改期后重新生成新时间提醒，取消后不再生成提醒', async () => {
  const [member]=await withTenant(tenant,tx=>tx<{id:string;user_id:string}[]>`
    select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id
    join roles r on r.id=mr.role_id where m.location_id=${NAIL_LOC} and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  const ctx=await buildContext({userId:member!.user_id,membershipId:member!.id});
  await dispatch('notification.saveTemplate',{eventKey:'appointment_reminder',channel:'email',locale:'en',subject:'Reminder',body:'Reminder: {{when}} {{manage_url}}'},ctx);
  await dispatch('notification.toggleRule',{eventKey:'appointment_reminder',enabled:true,channels:['email'],offsetMin:0},ctx);
  const id=await makeAppointment(1,14);
  const [appt]=await withTenant(tenant,async tx=>{
    const [customer]=await tx<{id:string}[]>`insert into customers(org_id,primary_location_id,display_name,phone_e164,email)
      values(${NAIL_ORG},${NAIL_LOC},'Reminder QA','+16175550189','reminder-qa@example.invalid') returning id`;
    await tx`update appointments set customer_id=${customer!.id},source='web' where id=${id}`;
    await tx`insert into appointment_items(org_id,location_id,appointment_id,service_id,starts_at,ends_at,duration_min,price_cents_snapshot,seq)
      select ${NAIL_ORG},${NAIL_LOC},a.id,s.id,a.starts_at,a.ends_at,60,5000,0
      from appointments a cross join (select id from services where location_id=${NAIL_LOC} and active and not is_addon limit 1) s where a.id=${id}`;
    return tx<{day:string}[]>`select business_date::text as day from appointments where id=${id}`;
  });
  const app={log:{warn:()=>{},info:()=>{}}} as unknown as Parameters<typeof runReminderSweep>[0];
  const reminders=()=>withTenant(tenant,tx=>tx<{body_text:string;entity_type:string}[]>`select body_text,entity_type from email_outbox where entity_id=${id} and kind='appointment_reminder' order by created_at`);
  await runReminderSweep(app,{sendHour:0});
  const before=await reminders();expect(before.filter(r=>r.entity_type==='appointment')).toHaveLength(1);
  await dispatch('appointment.reschedule',{appointmentId:id,startsAt:wallMinuteToInstant(appt!.day,timezone,16*60).toISOString()},ctx);
  await runReminderSweep(app,{sendHour:0});
  const after=await reminders();expect(after.filter(r=>r.entity_type==='appointment')).toHaveLength(1);
  expect(after.find(r=>r.entity_type==='appointment')!.body_text).not.toBe(before[0]!.body_text);
  expect(after.some(r=>r.entity_type.includes(':superseded:'))).toBe(true);
  await dispatch('appointment.cancel',{appointmentId:id,reason:'guest_changed_mind',keepStaffTurn:false},ctx);
  await runReminderSweep(app,{sendHour:0});
  expect((await reminders()).filter(r=>r.entity_type==='appointment')).toHaveLength(0);
});
