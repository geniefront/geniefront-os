import { renderMarketingEmail } from './email/layout';
/**
 * 外发消息的准入闸门（2026-09-01 店主定的四条决定）。
 *
 * 这一组测的都不是「渲染得对不对」，而是**该不该发出去** ——
 * 每一条对应一个已经明确的后果：
 *
 *   · 在未获批的 10DLC 品牌上发商业性短信 → 运营商掐整条通道，
 *     届时连预约确认也一并发不出去；
 *   · 用平台域名群发商业邮件 → 投诉率算在平台头上，一家店被举报，
 *     受损的是所有门店事务性邮件的送达率；
 *   · 抄送与顾客那封共用幂等键 → 后写的被 `do nothing` 吞掉，
 *     表现为「顾客收到了，店主没收到」，日志里看不出异常。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { notifyEvent } from './notify/dispatch';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const ctx = {
  orgId: NAIL_ORG,
  locationId: NAIL_LOC,
  userId: '00000000-0000-4000-8000-000000000000',
  membershipId: null,
  permissions: new Set<string>(),
  actorKind: 'api',
  locale: 'en',
  timezone: 'America/New_York',
} as unknown as CommandContext;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

const VARS = {
  customer_name: 'Jane',
  shop_name: 'Lotus Nails',
  service_name: 'Gel Manicure',
  when: 'Wed Aug 26, 12:30 PM',
  shop_phone: '(617) 555-0142',
  days_since: '92',
};

let customerId = '';
const notificationAppointmentIds:string[]=[];

async function setTenDlc(tx: Tx, status: string): Promise<void> {
  await tx`
    insert into location_10dlc_registrations (location_id, status)
    values (${NAIL_LOC}, ${status})
    on conflict (location_id) do update set status = excluded.status`;
}

async function setRule(tx: Tx, event: string, channels: string[]): Promise<void> {
  await tx`
    insert into notification_rules (org_id, location_id, event_key, enabled, channels)
    values (${NAIL_ORG}, ${NAIL_LOC}, ${event}, true, ${channels}::text[])
    on conflict (location_id, event_key) do update
      set enabled = true, channels = excluded.channels`;
}

/**
 * 每条断言用一个全新的 `entityId`。
 *
 * ⚠️ 不能靠「删掉上一条」来复位：`app_user` 对两个发件箱**没有 delete 权限**
 * （sql/0029 —— 发件箱是「我们对顾客说过什么」的凭据，运行时角色只能写入
 * 与更新状态）。而 outbox 的幂等键是 `(entity_type, entity_id, kind)`，
 * 复用同一个 id 会让第二次入队被 `do nothing` 静默吞掉，
 * 断言随之变成「测了个寂寞」。
 */
const freshEntity = (): string => crypto.randomUUID();

beforeAll(async () => {
  await withTenant(tenant, async (tx) => {
    const [c] = await tx<{ id: string }[]>`
      insert into customers
        (org_id, primary_location_id, display_name, phone_e164, email,
         marketing_sms_opt_in, marketing_email_opt_in)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'Policy Test', '+16175557777',
              'policy-test@maildrop.cc', true, true)
      returning id`;
    customerId = c!.id;
  });
});

afterAll(async () => {
  await withTenant(tenant, async tx => {
    for(const id of notificationAppointmentIds)await tx`delete from appointments where id=${id}`;
    await tx`delete from customers where id=${customerId}`;
  });
  await closeDb();
});

beforeEach(async () => {
  await withTenant(tenant, (tx) => tx`
    update locations set marketing_email_from = null where id = ${NAIL_LOC}`);
});

describe('短信品牌闸门', () => {
  it('🔴 门店 10DLC 未获批时，营销短信一条都不发', async () => {
    const entityId = freshEntity();
    const queued = await withTenant(tenant, async (tx) => {
      await setTenDlc(tx, 'pending_review');
      await setRule(tx, 'winback', ['sms']);
      return notifyEvent(tx, ctx, {
        event: 'winback',
        entityType: 'customer', entityId,
        vars: VARS, toPhone: '+16175557777', toEmail: null,
        customerId, locale: 'en',
      });
    });
    expect(queued).toBe(0);

    const rows = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from sms_outbox where entity_id = ${entityId}`);
    expect(rows).toHaveLength(0);
  });

  it('一期即使 10DLC 获批也不发送营销短信', async () => {
    const queued = await withTenant(tenant, async (tx) => {
      await setTenDlc(tx, 'approved');
      await setRule(tx, 'winback', ['sms']);
      return notifyEvent(tx, ctx, {
        event: 'winback',
        entityType: 'customer', entityId: freshEntity(),
        vars: VARS, toPhone: '+16175557777', toEmail: null,
        customerId, locale: 'en',
      });
    });
    expect(queued).toBe(0);
  });

  /**
   * ⭐ 事务性通知走的是**平台**注册品牌，与门店自身的注册状态无关。
   *
   * 把它们一并卡住的话，一家还没提交 10DLC 的新店连预约确认都发不出去；
   * 技师也收不到自己班上的单动了的通知。划线的地方是「营销 / 非营销」，
   * 不是「顾客 / 员工」（店主 2026-09-01 确认）。
   */
  it('⭐ 预约类与技师侧都不受门店 10DLC 状态影响', async () => {
    for (const event of [
      'appointment_confirm', 'appointment_changed',
      'appointment_cancelled', 'appointment_reminder',
      'staff_pending_confirm', 'staff_assigned', 'staff_changed', 'staff_cancelled',
    ] as const) {
      const queued = await withTenant(tenant, async (tx) => {
        await setTenDlc(tx, 'not_submitted');
        await setRule(tx, event, ['sms']);
        return notifyEvent(tx, ctx, {
          event,
          entityType: 'customer', entityId: freshEntity(),
          vars: VARS, toPhone: '+16175557777', toEmail: null,
          locale: 'en',
        });
      });
      expect(queued, `${event} 应当照常发出`).toBe(1);
    }
  });

  /**
   * 🔴 这一条是整道闸门里唯一不可退让的：**10DLC 获批之前，营销一条都不发**。
   *
   * 四个营销事件逐一验证，而不是抽查一个 —— 放行清单是手写的，
   * 漏一条的表现是安静的：短信照常发出去，直到运营商把整条通道掐掉。
   */
  it('🔴 四个营销事件在未获批时全部拦下，一条都不漏', async () => {
    for (const event of ['birthday', 'holiday', 'winback', 'review_request'] as const) {
      const queued = await withTenant(tenant, async (tx) => {
        await setTenDlc(tx, 'not_submitted');
        await setRule(tx, event, ['sms']);
        return notifyEvent(tx, ctx, {
          event,
          entityType: 'customer', entityId: freshEntity(),
          vars: VARS, toPhone: '+16175557777', toEmail: null,
          customerId, locale: 'en',
        });
      });
      expect(queued, `${event} 必须被拦下`).toBe(0);
    }
  });

  it('🔴 pending_review / under_review / rejected 一律按未获批处理', async () => {
    for (const status of ['pending_review', 'under_review', 'rejected'] as const) {
      const queued = await withTenant(tenant, async (tx) => {
        await setTenDlc(tx, status);
        await setRule(tx, 'birthday', ['sms']);
        return notifyEvent(tx, ctx, {
          event: 'birthday',
          entityType: 'customer', entityId: freshEntity(),
          vars: VARS, toPhone: '+16175557777', toEmail: null,
          customerId, locale: 'en',
        });
      });
      expect(queued, `${status} 不是 approved，必须拦下`).toBe(0);
    }
  });
});

describe('营销邮件的发件域名闸门', () => {
  it('🔴 门店没配专属发件地址时，营销邮件不发', async () => {
    const queued = await withTenant(tenant, async (tx) => {
      await setRule(tx, 'winback', ['email']);
      return notifyEvent(tx, ctx, {
        event: 'winback',
        entityType: 'customer', entityId: freshEntity(),
        vars: VARS, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        customerId, locale: 'en',
      });
    });
    expect(queued).toBe(0);
  });

  it('一期即使配好营销域名也不入队', async () => {
    const entityId = freshEntity();
    const queued = await withTenant(tenant, async (tx) => {
      await tx`update locations set marketing_email_from = 'oasisspa@mkt.geniefront.com'
               where id = ${NAIL_LOC}`;
      await setRule(tx, 'winback', ['email']);
      return notifyEvent(tx, ctx, {
        event: 'winback',
        entityType: 'customer', entityId,
        vars: VARS, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        customerId, locale: 'en',
      });
    });
    expect(queued).toBe(0);
  });

  it('营销模板保留渲染能力，但不触发发送', () => {
    const {html,text}=renderMarketingEmail('Hello','https://geniefront.com/unsubscribe?t=test');
    expect(html).toContain('max-width:600px');
    expect(html).toContain('Unsubscribe');
    expect(text).toContain('https://geniefront.com/unsubscribe?t=test');
  });

  /**
   * ⭐ 事务性邮件不写发件人，投递时用平台的 `FROM_EMAIL`。
   * 写成门店地址的话，一家还没配域名的店连预约确认都发不出去。
   */
  it('⭐ 预约类邮件不占用门店发件地址', async () => {
    const entityId = freshEntity();
    await withTenant(tenant, async (tx) => {
      await tx`update locations set marketing_email_from = 'oasisspa@mkt.geniefront.com'
               where id = ${NAIL_LOC}`;
      await setRule(tx, 'appointment_changed', ['email']);
      await notifyEvent(tx, ctx, {
        event: 'appointment_changed',
        entityType: 'customer', entityId,
        vars: VARS, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        locale: 'en',
      });
    });

    const rows = await withTenant(tenant, (tx) => tx<{
      from_email: string | null; entity_type: string;
    }[]>`
      select from_email, entity_type from email_outbox
      where entity_id = ${entityId} order by entity_type`);
    const toCustomer = rows.find((r) => r.entity_type === 'customer');
    expect(toCustomer?.from_email).toBeNull();
  });
});

describe('预约邮件抄送门店', () => {
  it('旧抄送开关发独立门店收据，不复制顾客私有管理链接', async () => {
    const entityId = freshEntity();
    notificationAppointmentIds.push(entityId);
    await withTenant(tenant, async (tx) => {
      await tx`insert into appointments(id,org_id,location_id,customer_id,business_date,starts_at,ends_at,source)
        values(${entityId},${NAIL_ORG},${NAIL_LOC},${customerId},(now()+interval '2 days')::date,now()+interval '2 days',now()+interval '2 days 30 minutes','web')`;
      await tx`update locations set settings=jsonb_set(settings,'{public_booking_profile}',
        coalesce(settings->'public_booking_profile','{}'::jsonb)||'{"shopNotifications":{"email":false,"sms":false}}'::jsonb) where id=${NAIL_LOC}`;
      await tx`update locations set appointment_email_copy_to_shop = true,
                                    email = 'shop@maildrop.cc'
               where id = ${NAIL_LOC}`;
      await setRule(tx, 'appointment_changed', ['email']);
      await notifyEvent(tx, ctx, {
        event: 'appointment_changed',
        entityType: 'customer', entityId,
        vars: {...VARS,manage_url:'https://book.example.test/booking#mt_customer_private_test'}, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        locale: 'en',
      });
    });

    const rows = await withTenant(tenant, (tx) => tx<{
      to_email: string; subject: string; body_text: string; entity_type: string;
    }[]>`
      select to_email, subject, body_text, entity_type from email_outbox
      where entity_id = ${entityId} order by entity_type`);

    expect(rows).toHaveLength(2);
    const cust = rows.find((r) => r.entity_type === 'customer')!;
    const shop = rows.find((r) => r.entity_type === 'customer_shop')!;

    expect(shop.to_email).toBe('shop@maildrop.cc');
    expect(cust.body_text).toContain('mt_customer_private_test');
    expect(shop.body_text).not.toContain('mt_customer_private_test');
    expect(shop.body_text).toContain('Policy Test');
    expect(shop.body_text).not.toBe(cust.body_text);
    expect(shop.subject).not.toMatch(/^Copy:/);
  });

  it('关掉之后不再抄送', async () => {
    const entityId = freshEntity();
    await withTenant(tenant, async (tx) => {
      await tx`update locations set appointment_email_copy_to_shop = false,
                                    email = 'shop@maildrop.cc'
               where id = ${NAIL_LOC}`;
      await setRule(tx, 'appointment_changed', ['email']);
      await notifyEvent(tx, ctx, {
        event: 'appointment_changed',
        entityType: 'customer', entityId,
        vars: VARS, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        locale: 'en',
      });
    });

    const rows = await withTenant(tenant, (tx) => tx<{ entity_type: string }[]>`
      select entity_type from email_outbox where entity_id = ${entityId}`);
    expect(rows.map((r) => r.entity_type)).toEqual(['customer']);
  });

  it('门店邮箱与顾客邮箱相同时不抄送 —— 否则同一封信发两遍', async () => {
    const entityId = freshEntity();
    await withTenant(tenant, async (tx) => {
      await tx`update locations set appointment_email_copy_to_shop = true,
                                    email = 'policy-test@maildrop.cc'
               where id = ${NAIL_LOC}`;
      await setRule(tx, 'appointment_changed', ['email']);
      await notifyEvent(tx, ctx, {
        event: 'appointment_changed',
        entityType: 'customer', entityId,
        vars: VARS, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        locale: 'en',
      });
    });

    const rows = await withTenant(tenant, (tx) => tx<{ entity_type: string }[]>`
      select entity_type from email_outbox where entity_id = ${entityId}`);
    expect(rows).toHaveLength(1);
  });

  it('营销邮件不抄送门店', async () => {
    const entityId = freshEntity();
    await withTenant(tenant, async (tx) => {
      await tx`update locations set appointment_email_copy_to_shop = true,
                                    email = 'shop@maildrop.cc',
                                    marketing_email_from = 'oasisspa@mkt.geniefront.com'
               where id = ${NAIL_LOC}`;
      await setRule(tx, 'winback', ['email']);
      await notifyEvent(tx, ctx, {
        event: 'winback',
        entityType: 'customer', entityId,
        vars: VARS, toEmail: 'policy-test@maildrop.cc', toPhone: null,
        customerId, locale: 'en',
      });
    });

    const rows = await withTenant(tenant, (tx) => tx<{ entity_type: string }[]>`
      select entity_type from email_outbox where entity_id = ${entityId}`);
    expect(rows.map((r) => r.entity_type)).toEqual([]);
  });
});
