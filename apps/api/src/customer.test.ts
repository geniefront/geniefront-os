/**
 * 客户档案聚合（批 6）。
 *
 * 最要紧的是**脱敏在服务端**那一条：技师拿到的 payload 里
 * 不该有完整号码，也不该有任何金额。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { readCustomerProfile } from '@gf/contracts';
import { buildContext } from './actor';
import { loadCustomerDetail, loadCustomerList } from './queries/customer';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let techCtx: Awaited<ReturnType<typeof buildContext>> | null = null;
let customerId = '';

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });

  const [tech] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key = 'therapist' and m.user_id is not null limit 1`);
  if (tech) techCtx = await buildContext({ userId: tech.user_id, membershipId: tech.id });

  const [c] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164, vip_level)
    values (${NAIL_ORG}, ${NAIL_LOC}, ${'档案测试客人'}, ${'+16175558877'}, 1)
    returning id`);
  customerId = c!.id;

  await withTenant(tenant, (tx) => tx`
    insert into customer_preferences (customer_id, org_id, preferred_gender, profile)
    values (${customerId}, ${NAIL_ORG}, 'female',
            ${JSON.stringify({
              pressure: 'firm', serviceLanguage: 'zh-Hans',
              focusAreas: ['neck', 'shoulders'],
              legacyJunk: '当年随手塞进去的',   // ⭐ 认不出的 key 要被丢掉而不是报错
            })}::jsonb)
    on conflict (customer_id) do update set
      preferred_gender = excluded.preferred_gender, profile = excluded.profile`);
});

afterAll(async () => {
  await withTenant(tenant, (tx) => tx`
    delete from customer_preferences where customer_id = ${customerId}`);
  await withTenant(tenant, (tx) => tx`delete from customers where id = ${customerId}`);
  await closeDb();
});

describe('偏好 schema', () => {
  it('⭐ 认不出的 key 丢掉，合法的留下 —— 不为一个拼错的 key 让整页打不开', () => {
    const out = readCustomerProfile({
      pressure: 'firm', serviceLanguage: 'zh-Hans', bogus: 1, aroma: '超级浓',
    });
    expect(out.pressure).toBe('firm');
    expect(out.serviceLanguage).toBe('zh-Hans');
    expect(out).not.toHaveProperty('bogus');
    // aroma 取值非法 → 丢掉那一项，不影响别的
    expect(out.aroma).toBeUndefined();
  });

  it('null / undefined 返回空对象而不是炸', () => {
    expect(readCustomerProfile(null)).toEqual({});
    expect(readCustomerProfile(undefined)).toEqual({});
  });
});

describe('客户详情', () => {
  it('一个请求带回档案、偏好、到访、礼品卡、消费、健康表', async () => {
    const d = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, customerId));
    expect(d).toBeTruthy();
    expect(d!.displayName).toBe('档案测试客人');
    expect(d!.vipLevel).toBe(1);
    expect(d!.preferences.preferredGender).toBe('female');
    expect(d!.preferences.profile.pressure).toBe('firm');
    expect(d!.preferences.profile.serviceLanguage).toBe('zh-Hans');
    // 数组字段永远是数组，不是 null —— 前端少一堆判空
    expect(Array.isArray(d!.giftCards)).toBe(true);
    expect(Array.isArray(d!.recentTickets)).toBe(true);
    expect(Array.isArray(d!.forms)).toBe(true);
  });

  it('⭐ 老板看得到完整号码', async () => {
    const d = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, customerId));
    expect(d!.phone).toBe('+16175558877');
  });

  it('⭐ 技师拿到的是脱敏号码，而且 payload 里一个金额都没有', async () => {
    if (!techCtx) return;   // 种子里没技师就跳过，不是失败
    const d = await withTenant(tenant, (tx) => loadCustomerDetail(tx, techCtx!, customerId));

    // 保留尾号（他要认出「上次那个 8877 的客人」），但拿不到完整号
    expect(d!.phone).toMatch(/\*\*\*-8877$/);
    expect(d!.phone).not.toBe('+16175558877');
    expect(d!.email).toBeNull();

    /*
     * ⭐ 金额是 **null 而不是 0**。
     * 0 会被前端渲染成「$0.00」，而那读起来是「这位客人一分钱没花过」——
     * 一个明确的错误信息，比空着糟得多。
     */
    expect(d!.visits.avgSpendCents).toBeNull();
    expect(d!.visits.lifetimeSpendCents).toBeNull();
    for (const t of d!.recentTickets) expect(t.totalCents).toBeNull();
  });

  it('查不到返回 null，不抛异常', async () => {
    const d = await withTenant(tenant, (tx) =>
      loadCustomerDetail(tx, ownerCtx, '00000000-0000-4000-8000-000000000000'));
    expect(d).toBeNull();
  });
});

describe('客户列表', () => {
  it('⭐ 按手机后四位搜得到 —— 前台在电话里问的就是这四位', async () => {
    const out = await withTenant(tenant, (tx) =>
      loadCustomerList(tx, ownerCtx, { q: '8877' }));
    expect(out.rows.some((r) => r.id === customerId)).toBe(true);
  });

  it('带横线、带括号的输入也认', async () => {
    const out = await withTenant(tenant, (tx) =>
      loadCustomerList(tx, ownerCtx, { q: '(8877)' }));
    expect(out.rows.some((r) => r.id === customerId)).toBe(true);
  });

  it('按名字也搜得到', async () => {
    const out = await withTenant(tenant, (tx) =>
      loadCustomerList(tx, ownerCtx, { q: '档案测试' }));
    expect(out.rows.some((r) => r.id === customerId)).toBe(true);
  });

  it('VIP 过滤', async () => {
    const out = await withTenant(tenant, (tx) =>
      loadCustomerList(tx, ownerCtx, { vipOnly: true, limit: 200 }));
    expect(out.rows.every((r) => r.vipLevel > 0)).toBe(true);
  });

  it('列表里的号码同样按角色脱敏', async () => {
    if (!techCtx) return;
    const out = await withTenant(tenant, (tx) =>
      loadCustomerList(tx, techCtx!, { q: '8877' }));
    const row = out.rows.find((r) => r.id === customerId);
    expect(row?.phone).not.toBe('+16175558877');
  });

  it('limit 收在 1..200 之间 —— 不让一个请求把整张表拉出来', async () => {
    const out = await withTenant(tenant, (tx) =>
      loadCustomerList(tx, ownerCtx, { limit: 99999 }));
    expect(out.rows.length).toBeLessThanOrEqual(200);
  });
});
