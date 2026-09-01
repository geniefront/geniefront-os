/**
 * 通知设置的读写（`queries/notificationSettings.ts` + 节日日程两条命令）。
 *
 * ⭐ 这一页此前**完全不存在** —— 三张表都没有前端入口，店主无法自己打开
 * 任何一个通知开关。因此这里既测数据形状，也测那两条最容易写错的语义：
 *
 *   · 12 个事件**全部**要给出来，没配过的补一行默认关闭的；
 *   · 只给在用的模板，历史版本留在库里是给已入队的消息用的。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { NOTIFICATION_EVENTS } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadNotificationSettings } from './queries/notificationSettings';
import './handlers/notify';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
const madeHolidays: string[] = [];

const run = <T>(name: string, input: unknown): Promise<T> =>
  dispatch<T>(name, input, ctx, { idempotencyKey: crypto.randomUUID() })
    .then((r) => r.result);

const load = () => withTenant(tenant, (tx) => loadNotificationSettings(tx, ctx));

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
});

afterAll(async () => {
  if (madeHolidays.length > 0) {
    await withTenant(tenant, (tx) => tx`
      delete from marketing_holidays where id = any(${madeHolidays})`);
  }
  await closeDb();
});

describe('设置页读取', () => {
  /**
   * ⭐ 只返回已有行的话，界面上就只看得到店主动过的那几个 —— 而他找不到的
   * 那几个看起来像「这个功能不存在」，而不是「这个开关是关着的」。
   */
  it('⭐ 12 个事件全部给出来，没配过的补一行默认关闭的', async () => {
    const s = await load();
    expect(s.rules).toHaveLength(NOTIFICATION_EVENTS.length);
    for (const e of NOTIFICATION_EVENTS) {
      expect(s.rules.some((r) => r.eventKey === e), `${e} 应当出现`).toBe(true);
    }
  });

  it('每个事件带上它认得的变量 —— 否则店主只能对着空文本框猜', async () => {
    const s = await load();
    expect(s.variables['appointment_confirm']).toContain('customer_name');
    expect(s.variables['winback']).toContain('days_since');
    expect(s.variables['review_request']).toContain('review_url');
  });

  /**
   * ⭐ 闸门状态是这一页最要紧的一半：只给开关不给闸门，店主打开之后唯一
   * 能得到的反馈是「什么也没发生」—— 而那不会报错。
   */
  it('⭐ 带上营销的两道闸门与静默时段', async () => {
    const s = await load();
    expect(typeof s.gates.tenDlcStatus).toBe('string');
    expect(s.gates).toHaveProperty('marketingEmailFrom');
    expect(s.gates.quietHours).toEqual({ start: 8, end: 21 });
    expect(s.marketingEvents).toContain('birthday');
  });

  it('只给在用的模板 —— 历史版本是给已入队的消息用的', async () => {
    await run('notification.saveTemplate', {
      eventKey: 'appointment_reminder', channel: 'sms', locale: 'en',
      body: 'v1 body', active: true,
    });
    await run('notification.saveTemplate', {
      eventKey: 'appointment_reminder', channel: 'sms', locale: 'en',
      body: 'v2 body', active: true,
    });

    const s = await load();
    const mine = s.templates.filter(
      (t) => t.eventKey === 'appointment_reminder' && t.channel === 'sms' && t.locale === 'en');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toBe('v2 body');
  });
});

describe('规则开关', () => {
  it('打开之后读回来是打开的', async () => {
    await run('notification.toggleRule', {
      eventKey: 'appointment_reminder', enabled: true, channels: ['sms', 'email'],
    });
    const rule = (await load()).rules.find((r) => r.eventKey === 'appointment_reminder');
    expect(rule?.enabled).toBe(true);
    expect(rule?.channels.sort()).toEqual(['email', 'sms']);
  });

  it('渠道清空等同于关掉', async () => {
    await run('notification.toggleRule', {
      eventKey: 'appointment_reminder', enabled: false, channels: [],
    });
    const rule = (await load()).rules.find((r) => r.eventKey === 'appointment_reminder');
    expect(rule?.enabled).toBe(false);
    expect(rule?.channels).toEqual([]);
  });
});

describe('节日日程', () => {
  it('新增之后读得回来', async () => {
    const res = await run<{ holidayId: string }>('marketing.saveHoliday', {
      name: 'Thanksgiving', sendOn: '2026-11-26', enabled: true,
    });
    madeHolidays.push(res.holidayId);

    const h = (await load()).holidays.find((x) => x.id === res.holidayId);
    expect(h?.name).toBe('Thanksgiving');
    expect(h?.sendOn).toBe('2026-11-26');
  });

  /**
   * ⚠️ 同一家店同一天只能有一个：两条一起发，顾客一天收两封。
   * 撞车时按 `send_on` 覆盖而不是报错 —— 改名字走的正是这条路。
   */
  it('⚠️ 同一天再加一条是覆盖，不是报错也不是并存', async () => {
    const res = await run<{ holidayId: string }>('marketing.saveHoliday', {
      name: 'Thanksgiving Sale', sendOn: '2026-11-26', enabled: true,
    });
    madeHolidays.push(res.holidayId);

    const sameDay = (await load()).holidays.filter((x) => x.sendOn === '2026-11-26');
    expect(sameDay).toHaveLength(1);
    expect(sameDay[0]!.name).toBe('Thanksgiving Sale');
  });

  it('删掉之后就没了', async () => {
    const res = await run<{ holidayId: string }>('marketing.saveHoliday', {
      name: 'Temp', sendOn: '2026-12-24', enabled: true,
    });
    await run('marketing.deleteHoliday', { holidayId: res.holidayId });
    expect((await load()).holidays.some((x) => x.id === res.holidayId)).toBe(false);
  });

  it('删一个不存在的报 NOT_FOUND，而不是静默成功', async () => {
    await expect(run('marketing.deleteHoliday', { holidayId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
