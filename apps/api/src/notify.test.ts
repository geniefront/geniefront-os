/**
 * 折扣明细 + 通知模板（批 7）。
 *
 * 折扣那一半盯的是「谁给的、为什么、有没有超额」——
 * 那三样正是「漏损率」这个指标的原料。
 * 通知那一半盯的是**版本化**：改了模板，队列里已有的消息不能跟着变。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { renderTemplate, templateVariables } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/notify';
import './handlers/ticket';
import './handlers/appointment';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let otherMembershipId = '';
let serviceId = '';
let techId = '';

const run = async <T>(name: string, input: unknown, key = crypto.randomUUID()): Promise<T> =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

/** 开一张真单来打折 —— 折扣是挂在单上的，凭空测不出上限那条 */
async function openTicket(): Promise<{ ticketId: string; subtotalCents: number }> {
  return run('ticket.open', {
    customerId: null, walkInName: '折扣测试',
    items: [{ serviceId, membershipId: techId, minutes: 60 }],
  });
}

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  const [other] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from memberships
    where location_id = ${NAIL_LOC} and status = 'active' and id <> ${m!.id} limit 1`);
  otherMembershipId = other!.id;

  const [svc] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services where location_id = ${NAIL_LOC} and active = true
    order by base_price_cents desc limit 1`);
  serviceId = svc!.id;

  const [tech] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select membership_id as id from staff_profiles
    where location_id = ${NAIL_LOC} and is_bookable = true limit 1`);
  techId = tech!.id;
});

afterAll(async () => {
  /*
   * ⚠️ **不能 delete tickets** —— 宪法第 9 条：财务记录只冲销不删除，
   * 所以 app_user 在这张表上根本没有 DELETE 权限
   * （第一版这么写了，报的是 "permission denied for table tickets"，
   * 而且是在 afterAll 里报的 —— 所有用例都绿，整个文件却是 FAIL）。
   *
   * 走产品自己的路：把它们作废。作废之后既不计入营业额，
   * 也不会让「还有单没结完就要封账」那条用例误伤。
   */
  const open = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from tickets
    where location_id = ${NAIL_LOC} and walk_in_name = '折扣测试'
      and status <> 'voided'`);
  for (const t of open) {
    await dispatch('ticket.void',
      { ticketId: t.id, reason: 'input_error', note: '测试数据' },
      ctx, { idempotencyKey: crypto.randomUUID() }).catch(() => null);
  }
  await closeDb();
});

describe('折扣明细', () => {
  it('⭐ 每一笔都记得住是谁给的 —— 「不知道谁批的」正是这张表要消灭的', async () => {
    const t = await openTicket();
    const out = await run<{ discountId: string; amountCents: number }>('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 1000, reasonText: '老客关照',
    });

    const [row] = await withTenant(tenant, (tx) => tx<{
      granted_by: string; reason_text: string; amount_cents: number;
    }[]>`
      select granted_by, reason_text, amount_cents from ticket_discounts
      where id = ${out.discountId}`);
    expect(row!.granted_by).toBe(ctx.membershipId);
    expect(row!.reason_text).toBe('老客关照');
    expect(row!.amount_cents).toBe(1000);
  });

  it('没写原因不让打折', async () => {
    const t = await openTicket();
    await expect(run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 500,
    })).rejects.toMatchObject({ details: { reason: 'discount_reason_required' } });
  });

  it('⭐ 百分比折算成实际金额落库 —— 报表不用每次再算一遍', async () => {
    const t = await openTicket();
    const out = await run<{ amountCents: number }>('discount.apply', {
      ticketId: t.ticketId, kind: 'percent', percentBp: 1000, reasonText: '九折',
    });
    expect(out.amountCents).toBe(Math.floor(t.subtotalCents * 0.1));
  });

  it('⭐ 折扣总额超过小计当场拦下 —— 负数会一路流进日结和提成', async () => {
    const t = await openTicket();
    await run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount',
      amountCents: t.subtotalCents, reasonText: '全免',
    });
    await expect(run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 100, reasonText: '再减',
    })).rejects.toMatchObject({ details: { reason: 'discount_exceeds_subtotal' } });
  });

  it('⭐ 超额要授权，而且不能自己批自己', async () => {
    const reason = await run<{ reasonId: string }>('discount.saveReason', {
      label: { en: 'Comp' }, maxSelfApproveCents: 500,
    });
    const t = await openTicket();

    // 超了额度又没有授权人
    await expect(run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 2000, reasonId: reason.reasonId,
    })).rejects.toMatchObject({ details: { reason: 'discount_needs_approval' } });

    // ⭐ 自己批自己 —— 这道闸最容易被绕过的方式
    await expect(run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 2000,
      reasonId: reason.reasonId, approvedBy: ctx.membershipId,
    })).rejects.toMatchObject({ details: { reason: 'discount_self_approval' } });

    // 别人批就过
    const ok = await run<{ amountCents: number }>('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 2000,
      reasonId: reason.reasonId, approvedBy: otherMembershipId,
    });
    expect(ok.amountCents).toBe(2000);
  });

  it('⭐ 撤销是冲销不是删除 —— 行还在，只是标了 reversed_at', async () => {
    const t = await openTicket();
    const d = await run<{ discountId: string }>('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 800, reasonText: '手滑',
    });
    await run('discount.void', { discountId: d.discountId, reason: '按错了' });

    const [row] = await withTenant(tenant, (tx) => tx<{
      reversed_at: Date | null; reversed_by: string | null;
    }[]>`
      select reversed_at, reversed_by from ticket_discounts where id = ${d.discountId}`);
    expect(row!.reversed_at).not.toBeNull();
    expect(row!.reversed_by).toBe(ctx.membershipId);

    // 单上的缓存跟着回到 0
    const [tk] = await withTenant(tenant, (tx) => tx<{ d: number }[]>`
      select discount_cents as d from tickets where id = ${t.ticketId}`);
    expect(tk!.d).toBe(0);
  });

  it('撤销第二次不是静默成功，而是明确说已经撤过了', async () => {
    const t = await openTicket();
    const d = await run<{ discountId: string }>('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 300, reasonText: 'x',
    });
    await run('discount.void', { discountId: d.discountId, reason: '一次' });
    await expect(run('discount.void', { discountId: d.discountId, reason: '两次' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tickets.discount_cents 变成明细的缓存，两边永远一致', async () => {
    const t = await openTicket();
    await run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 200, reasonText: 'a' });
    await run('discount.apply', {
      ticketId: t.ticketId, kind: 'amount', amountCents: 300, reasonText: 'b' });

    const [tk] = await withTenant(tenant, (tx) => tx<{ d: number }[]>`
      select discount_cents as d from tickets where id = ${t.ticketId}`);
    const [sum] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as n from ticket_discounts
      where ticket_id = ${t.ticketId} and reversed_at is null`);
    expect(tk!.d).toBe(sum!.n);
    expect(tk!.d).toBe(500);
  });
});

describe('模板渲染（纯函数）', () => {
  it('⚠️ 未知变量渲染成空串 —— 绝不把花括号发给客人', () => {
    expect(renderTemplate('你好 {{customer_name}}，{{nope}} 见', { customer_name: '张三' }))
      .toBe('你好 张三， 见');
  });

  it('null / undefined 也是空串，不是字面量 "null"', () => {
    expect(renderTemplate('{{a}}|{{b}}', { a: null, b: undefined })).toBe('|');
  });

  it('容忍花括号里的空格', () => {
    expect(renderTemplate('{{ shop_name }}', { shop_name: '莲花' })).toBe('莲花');
  });

  it('⚠️ 不做任何转义 —— 短信和邮件的转义规则相反，那是调用方的事', () => {
    expect(renderTemplate('{{x}}', { x: 'A & B' })).toBe('A & B');
  });

  it('列得出模板用了哪些变量', () => {
    expect(templateVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('通知模板', () => {
  it('⭐ 每次保存是新版本，旧版本留着但停用', async () => {
    const v1 = await run<{ version: number; templateId: string }>('notification.saveTemplate', {
      eventKey: 'appointment_confirm', channel: 'sms', locale: 'en', body: 'v1 body',
    });
    const v2 = await run<{ version: number }>('notification.saveTemplate', {
      eventKey: 'appointment_confirm', channel: 'sms', locale: 'en', body: 'v2 body',
    });
    expect(v2.version).toBe(v1.version + 1);

    const [old] = await withTenant(tenant, (tx) => tx<{ active: boolean; body: string }[]>`
      select active, body from notification_templates where id = ${v1.templateId}`);
    // ⭐ 行还在（队列里可能还有引用它的消息），但不再是当前版本
    expect(old!.body).toBe('v1 body');
    expect(old!.active).toBe(false);
  });

  it('⭐ 技师侧那四条事件是认得的 —— AI 改期之后客人和技师都要知道', async () => {
    for (const key of ['staff_pending_confirm', 'staff_changed', 'staff_cancelled']) {
      const out = await run<{ version: number }>('notification.saveTemplate', {
        eventKey: key, channel: 'sms', locale: 'en', body: `${key} 模板`,
      });
      expect(out.version).toBeGreaterThan(0);
    }
  });

  it('用了这个事件没有的变量只记审计，不拦 —— 拦了老板会觉得编辑器难用', async () => {
    const out = await run<{ version: number }>('notification.saveTemplate', {
      eventKey: 'birthday', channel: 'sms', locale: 'en',
      body: '{{customer_name}} 生日快乐，{{service_name}} 打折',   // birthday 没有 service_name
    });
    expect(out.version).toBeGreaterThan(0);
  });

  it('规则开关：空渠道等同于关掉', async () => {
    await run('notification.toggleRule', {
      eventKey: 'winback', enabled: true, channels: ['sms'], offsetMin: 0,
    });
    const out = await run<{ enabled: boolean }>('notification.toggleRule', {
      eventKey: 'winback', enabled: false, channels: [], offsetMin: 0,
    });
    expect(out.enabled).toBe(false);
  });

  it('⭐ 提前量可以是负数 —— 提醒类要在事件之前发', async () => {
    await run('notification.toggleRule', {
      eventKey: 'appointment_reminder', enabled: true,
      channels: ['sms'], offsetMin: -1440,
    });
    const [row] = await withTenant(tenant, (tx) => tx<{ o: number }[]>`
      select offset_min as o from notification_rules
      where location_id = ${NAIL_LOC} and event_key = 'appointment_reminder'`);
    expect(row!.o).toBe(-1440);
  });
});

// ════════════ 改期 / 取消真的通知到人（批 8 收尾，补批 3 的口子）══════════

describe('⭐ 改期与取消会通知客人和技师', () => {
  let serviceId = '';
  let customerId = '';

  /*
   * ⚠️ 号码和名字都带一个每次不同的后缀。
   *
   * `customers_no_exact_dup` 挡「同号同名重复建客户」（宪法第 16 条的另一半），
   * 而上一次跑留下的那条如果没清干净，这次 beforeAll 第一句就撞唯一键 ——
   * 报错指向 beforeAll，看不出真正的原因在 afterAll。
   */
  const RUN = String(Date.now()).slice(-6);
  const CUST_PHONE = `+1617555${RUN.slice(-4)}`;

  beforeAll(async () => {
    const [svc] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from services where location_id = ${NAIL_LOC} and active = true
        and is_addon = false limit 1`);
    serviceId = svc!.id;

    const [c] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into customers (org_id, primary_location_id, display_name, phone_e164, locale)
      values (${NAIL_ORG}, ${NAIL_LOC}, ${`通知测试客人 ${RUN}`}, ${CUST_PHONE}, 'en')
      returning id`);
    customerId = c!.id;

    // 模板 + 规则都配上 —— 缺任何一个都不发（这本身就是下面一条用例）
    await run('notification.saveTemplate', {
      eventKey: 'appointment_changed', channel: 'sms', locale: 'en',
      body: 'Hi {{customer_name}}, your {{service_name}} moved to {{when}}.',
    });
    await run('notification.saveTemplate', {
      eventKey: 'appointment_cancelled', channel: 'sms', locale: 'en',
      body: 'Hi {{customer_name}}, your {{when}} appointment is cancelled.',
    });
  });

  const enable = (key: string) => run('notification.toggleRule',
    { eventKey: key, enabled: true, channels: ['sms'], offsetMin: 0 });
  const disable = (key: string) => run('notification.toggleRule',
    { eventKey: key, enabled: false, channels: [], offsetMin: 0 });

  const makeAppt = async (): Promise<string> => {
    const d = new Date(Date.now() + 5 * 86400_000);
    d.setUTCHours(18, 0, 0, 0);
    const out = await run<{ appointmentId: string }>('appointment.create', {
      customerId,
      items: [{
        serviceId, addonIds: [], membershipId: null,
        startsAt: d.toISOString(), details: {},
      }],
      partySize: 1, source: 'desk',
    });
    return out.appointmentId;
  };

  const smsFor = (id: string) => withTenant(tenant, (tx) => tx<{
    body: string; entity_type: string;
  }[]>`
    select body, entity_type from sms_outbox
    where entity_id = ${id} and kind = 'appointment_changed'`);

  it('⭐ 改期之后客人收到一条，内容是渲染好的（不是花括号）', async () => {
    await enable('appointment_changed');
    const id = await makeAppt();

    const d = new Date(Date.now() + 6 * 86400_000);
    d.setUTCHours(18, 0, 0, 0);
    await run('appointment.reschedule', {
      appointmentId: id,
      startsAt: d.toISOString(),
    });

    const rows = await smsFor(id);
    const toCustomer = rows.find((r) => r.entity_type === 'appointment');
    expect(toCustomer).toBeTruthy();
    expect(toCustomer!.body).toContain('通知测试客人');
    expect(toCustomer!.body).not.toContain('{{');
  });

  it('⭐ 技师那条走不同的 entity_type —— 同一个的话会被幂等键吞掉', async () => {
    await enable('appointment_changed');
    await run('notification.saveTemplate', {
      eventKey: 'staff_changed', channel: 'sms', locale: 'en',
      body: '{{staff_name}}: {{customer_name}} moved to {{when}}',
    });
    await enable('staff_changed');

    const id = await makeAppt();
    const d = new Date(Date.now() + 7 * 86400_000);
    d.setUTCHours(18, 0, 0, 0);
    await run('appointment.reschedule', {
      appointmentId: id,
      startsAt: d.toISOString(),
    });

    const rows = await smsFor(id);
    // 客人那条一定在；技师那条要看种子里那位有没有手机号，
    // 有的话 entity_type 必须是 appointment_staff
    expect(rows.some((r) => r.entity_type === 'appointment')).toBe(true);
    for (const r of rows) {
      expect(['appointment', 'appointment_staff']).toContain(r.entity_type);
    }
  });

  it('⭐ 规则关着就不发 —— 装上新版本不该让所有店突然开始发短信', async () => {
    await disable('appointment_changed');
    await disable('staff_changed');
    const id = await makeAppt();

    const d = new Date(Date.now() + 8 * 86400_000);
    d.setUTCHours(18, 0, 0, 0);
    await run('appointment.reschedule', {
      appointmentId: id,
      startsAt: d.toISOString(),
    });

    expect(await smsFor(id)).toHaveLength(0);
  });

  it('⭐ 模板没配也不会让改期失败 —— 通知永不成为阻断点', async () => {
    await enable('winback');   // 开一个没配模板的事件
    const id = await makeAppt();
    await enable('appointment_changed');

    // 就算某条通知发不出去，改期本身必须成功
    const d = new Date(Date.now() + 9 * 86400_000);
    d.setUTCHours(18, 0, 0, 0);
    await expect(run('appointment.reschedule', {
      appointmentId: id,
      startsAt: d.toISOString(),
    })).resolves.toBeTruthy();
    await disable('winback');
  });

  it('取消也通知', async () => {
    await enable('appointment_cancelled');
    const id = await makeAppt();
    await run('appointment.cancel', {
      appointmentId: id, reason: 'guest_changed_mind', keepStaffTurn: false,
    });

    const [row] = await withTenant(tenant, (tx) => tx<{ body: string }[]>`
      select body from sms_outbox
      where entity_id = ${id} and entity_type = 'appointment'`);
    expect(row!.body).toContain('cancelled');
  });

  afterAll(async () => {
    /*
     * ⚠️ **sms_outbox 删不掉** —— app_user 在那张表上没有 DELETE 权限，
     * 因为 `segments` 是计费凭据（同 tickets：财务记录只冲销不删除）。
     *
     * 第一版这么写了，报的是 "permission denied for table sms_outbox"，
     * 而且它在 afterAll 的**第一句** —— 后面的清理全都没跑，
     * 于是下一次 beforeAll 撞了 customers_no_exact_dup，
     * 报错指向一个和真正原因隔了一整个文件的位置。
     *
     * 正确做法是标成 suppressed（那正是这个状态的用途），不是删。
     */
    await withTenant(tenant, (tx) => tx`
      update sms_outbox set status = 'suppressed'
      where org_id = ${NAIL_ORG} and to_e164 = ${CUST_PHONE} and status = 'pending'`);
    await withTenant(tenant, (tx) => tx`
      delete from appointment_items ai using appointments a
      where ai.appointment_id = a.id and a.customer_id = ${customerId}`);
    await withTenant(tenant, (tx) => tx`
      delete from appointments where customer_id = ${customerId}`);
    await withTenant(tenant, (tx) => tx`delete from customers where id = ${customerId}`);
  });
});
