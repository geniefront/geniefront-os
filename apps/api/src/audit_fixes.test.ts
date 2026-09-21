import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadGiftCardVerify, loadGiftCards } from './queries/giftcard';
import { loadAppointmentDetail } from './queries/appointmentDetail';
import { loadReport, reportToCsv } from './queries/money';
import { loadPackages, loadCoupons, loadLoyalty } from './queries/marketing';
import './handlers/ticket';
import './handlers/phone';
import './handlers/marketing';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };
// Seed closes the most recent 14 historical days. This remote date is
// intentionally outside seeded accounting history and remains writable.
const TEST_DAY = '1998-02-03';

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let membershipId: string;
let testTicketId: string;
let testAptId: string;
let testGiftCardCode: string;

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  
  membershipId = owner!.id;
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });

  // 1. 创建测试客户
  const dynamicPhone = `+1617${Math.floor(1000000 + Math.random() * 9000000)}`;
  const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164, email)
    values (${NAIL_ORG}, ${NAIL_LOC}, '审计修复测试客', ${dynamicPhone}, 'test-audit@maildrop.cc')
    returning id`);

  // 2. 创建测试工单
  const [ticket] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into tickets (
      org_id, location_id, customer_id, business_date, status,
      subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents
    ) values (
      ${NAIL_ORG}, ${NAIL_LOC}, ${cust!.id}, ${TEST_DAY}, 'closed',
      5000, 0, 300, 1000, 6300
    ) returning id`);
  testTicketId = ticket!.id;

  await withTenant(tenant, (tx) => tx`
    insert into ticket_items (
      org_id, location_id, ticket_id, service_id, kind, name_snapshot, unit_price_cents, total_cents
    ) values (
      ${NAIL_ORG}, ${NAIL_LOC}, ${testTicketId},
      (select id from services where location_id = ${NAIL_LOC} limit 1),
      'service', '经典美甲', 5000, 5000
    )`);

  // 3. 创建测试礼品卡
  testGiftCardCode = `GC-AUDIT-${Math.floor(1000 + Math.random() * 9000)}`;
  await withTenant(tenant, (tx) => tx`
    insert into gift_cards (
      org_id, location_id, code, face_value_cents, sale_price_cents, balance_cents,
      scope, status, source, recipient_name
    ) values (
      ${NAIL_ORG}, ${NAIL_LOC}, ${testGiftCardCode}, 5000, 5000, 5000,
      'location', 'active', 'front_desk', 'Lisa Chen'
    )`);

  // 4. 创建测试预约单
  const [apt] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into appointments (
      org_id, location_id, customer_id, business_date, starts_at, ends_at, status, notes
    ) values (
      ${NAIL_ORG}, ${NAIL_LOC}, ${cust!.id}, ${TEST_DAY},
      ${`${TEST_DAY} 14:00:00+00`}, ${`${TEST_DAY} 14:45:00+00`}, 'booked', '客人要求轻一点'
    ) returning id`);
  testAptId = apt!.id;

  const [svc] = await withTenant(tenant, (tx) => tx<{ id: string; price_cents?: number; base_price_cents?: number }[]>`
    select id, base_price_cents from services where location_id = ${NAIL_LOC} limit 1`);

  await withTenant(tenant, (tx) => tx`
    insert into appointment_items (
      org_id, location_id, appointment_id, service_id, starts_at, ends_at,
      price_cents_snapshot, duration_min, membership_id
    ) values (
      ${NAIL_ORG}, ${NAIL_LOC}, ${testAptId}, ${svc!.id},
      ${`${TEST_DAY} 14:00:00+00`}, ${`${TEST_DAY} 14:45:00+00`},
      ${svc!.base_price_cents ?? 4500}, 45, ${membershipId}
    )`);
});

afterAll(async () => {
  await closeDb();
});

describe('审计后端修复专项测试', () => {
  describe('1. 礼品卡余额预检 (loadGiftCardVerify)', () => {
    it('查询有效礼品卡返回卡内余额与 active 状态', async () => {
      const res = await withTenant(tenant, (tx) =>
        loadGiftCardVerify(tx, ownerCtx, testGiftCardCode)
      );

      expect(res.valid).toBe(true);
      expect(res.code).toBe(testGiftCardCode);
      expect(res.balanceCents).toBe(5000);
      expect(res.recipientName).toBe('Lisa Chen');
      expect(res.status).toBe('active');
    });

    it('查询不存在的礼品卡返回 valid: false 与 0 余额', async () => {
      const res = await withTenant(tenant, (tx) =>
        loadGiftCardVerify(tx, ownerCtx, 'NONEXISTENT_CODE')
      );

      expect(res.valid).toBe(false);
      expect(res.balanceCents).toBe(0);
      expect(res.status).toBe('void');
    });
  });

  /*
   * 「2. 电子小票发送命令」整组已随 `ticket.sendReceipt` 于 2026-09-01 移除
   * （店主定：消费小票不再走短信与邮件，只保留打印）。
   * 命令本身已从契约中删除，因此这里没有可测的对象。
   */

  describe('3. 预约详情穿透查询 (loadAppointmentDetail)', () => {
    it('返回预约单据、客户信息及项目列表', async () => {
      const data = await withTenant(tenant, (tx) =>
        loadAppointmentDetail(tx, ownerCtx, testAptId)
      );

      expect(data.appointmentId).toBe(testAptId);
      expect(data.status).toBe('booked');
      expect(data.customer.name).toBe('审计修复测试客');
      expect(data.notes).toBe('客人要求轻一点');
      expect(data.items.length).toBeGreaterThanOrEqual(1);
      expect(data.items[0]!.serviceName).toBeDefined();
      expect(data.items[0]!.durationMin).toBe(45);
    });
  });

  describe('4. 营业报表与 CSV 导出 (loadReport & reportToCsv)', () => {
    it('loadReport 正常返回区间报表汇总并可导出为 CSV', async () => {
      const report = await withTenant(tenant, (tx) =>
        loadReport(tx, ownerCtx, TEST_DAY, TEST_DAY)
      );

      expect(report.fromDate).toBe(TEST_DAY);
      expect(report.toDate).toBe(TEST_DAY);
      expect(report.byDay.length).toBeGreaterThan(0);

      const csv = reportToCsv(report);
      expect(csv).toContain('GenieFront');
      expect(typeof csv).toBe('string');
    });
  });

  describe('5. 营销中心查询模块 (loadPackages, loadCoupons, loadLoyalty, loadGiftCards)', () => {
    it('loadPackages 正常返回次卡模板列表', async () => {
      const res = await withTenant(tenant, (tx) => loadPackages(tx, ownerCtx));
      expect(Array.isArray(res.templates)).toBe(true);
    });

    it('loadCoupons 正常返回优惠券列表', async () => {
      const res = await withTenant(tenant, (tx) => loadCoupons(tx, ownerCtx));
      expect(Array.isArray(res.coupons)).toBe(true);
    });

    it('loadLoyalty 正常返回会员积分设置', async () => {
      const res = await withTenant(tenant, (tx) => loadLoyalty(tx, ownerCtx));
      expect(typeof res.enabled).toBe('boolean');
      expect(typeof res.earnRateCentsPerPoint).toBe('number');
      expect(typeof res.totalPointsOutstanding).toBe('number');
    });

    it('loadGiftCards 正常返回礼品卡列表', async () => {
      const res = await withTenant(tenant, (tx) => loadGiftCards(tx, ownerCtx));
      expect(res.total).toBeGreaterThanOrEqual(1);
      expect(res.rows.some((r) => r.code === testGiftCardCode)).toBe(true);
    });
  });

  describe('6. AI 电话配置由 Ops 维护', () => {
    it('拒绝店主通过旧命令直接修改应答配置和通知收件人', async () => {
      const [before] = await withTenant(tenant, tx => tx<{ settings: Record<string, unknown> }[]>`select settings from locations where id=${NAIL_LOC}`);
      for (const [command, input] of [
        ['settings.savePhoneAssistant', { greetingPrompt: 'Customer override', autoBookEnabled: true }],
        ['settings.saveVoiceNotifications', { email: 'override@example.com', phone: '+16676606667' }],
      ] as const) {
        await expect(dispatch(command, input, ownerCtx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'ops_managed_voice_settings' } });
      }
      const [after] = await withTenant(tenant, tx => tx<{ settings: Record<string, unknown> }[]>`select settings from locations where id=${NAIL_LOC}`);
      expect(after!.settings).toEqual(before!.settings);
    });
  });
});
