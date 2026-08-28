/**
 * 系统设置模块全量 10 大面板与 6 大板块后端 API 与数据库改造测试套件
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/setup';
import './handlers/phone';
import './handlers/staff';
import { buildServer } from './server';
import { issueStaffSession, STAFF_TOKEN_HEADER } from './auth/staffSession';
import {
  loadDeskSettings, loadCheckoutSettings, load10DlcStatus, loadIntakeWaiver, loadWebhooks,
} from './queries/settings';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let staffToken: string;
let ownerMembershipId: string;

beforeAll(async () => {
  const staffMembers = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active' and m.user_id is not null
      and r.key = 'manager'
    limit 1`);
  ownerMembershipId = staffMembers[0]!.id;
  const ctx = await buildContext({ userId: staffMembers[0]!.user_id, membershipId: ownerMembershipId });
  ownerCtx = {
    ...ctx,
    permissions: new Set([...ctx.permissions, 'settings.manage', 'staff.manage', 'ticket.read']) as unknown as typeof ctx.permissions,
  };

  const session = await issueStaffSession(
    { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: ownerMembershipId },
    'claim_code',
    'test_device',
  );
  staffToken = session.token;

  app = buildServer();
});

afterAll(async () => {
  await closeDb();
});

describe('系统设置增强模块与全新 REST API 接口测试', () => {

  // 1. 门店基础档案与营业时间
  describe('1. 基础档案与营业时间', () => {
    it('PATCH /v1/desk/settings/location 与 /api/desk/settings/location 成功更新门店信息', async () => {
      const payload = {
        name: 'Lotus Spa & Beauty Wellness',
        slug: 'lotus-spa-nyc',
        businessType: 'mixed',
        phone: '+1 (212) 580-8888',
        email: 'contact@lotusspanyc.com',
        addressStreet: '128 E 56th St, Suite 4B',
        addressCity: 'New York',
        addressState: 'NY',
        addressZip: '10022',
        businessDayCutoff: '03:00',
      };

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/desk/settings/location',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().locationId).toBe(NAIL_LOC);

      const [loc] = await withTenant(tenant, (tx) => tx<{
        slug: string; business_type: string; phone: string; email: string;
        address_street: string; address_city: string;
      }[]>`
        select slug, business_type, phone, email, address_street, address_city
        from locations where id = ${NAIL_LOC}`);

      expect(loc?.slug).toBe('lotus-spa-nyc');
      expect(loc?.business_type).toBe('mixed');
      expect(loc?.phone).toBe('+1 (212) 580-8888');
      expect(loc?.email).toBe('contact@lotusspanyc.com');
      expect(loc?.address_street).toBe('128 E 56th St, Suite 4B');
    });

    it('PUT /api/desk/settings/business-hours 保存营业时间', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/desk/settings/business-hours',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          hours: {
            mon: { open: '09:30', close: '19:30' },
            tue: { open: '09:30', close: '19:30' },
            wed: { open: '09:30', close: '19:30' },
            thu: { open: '09:30', close: '19:30' },
            fri: { open: '09:30', close: '20:00' },
            sat: { open: '10:00', close: '20:00' },
            sun: null,
          },
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // 2. 收银偏好与小费税率配置
  describe('2. 收银偏好与小费税率配置', () => {
    it('PUT /api/desk/settings/checkout 与 GET /api/desk/settings/checkout', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/desk/settings/checkout',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          salesTaxRatePercent: 8.875,
          taxCalculationMode: 'exclusive',
          suggestedTipPercentages: [15, 18, 20, 25],
          allowCustomTip: true,
          defaultCashFloatCents: 20000,
          receiptFooterMessage: '感谢光临！WiFi: LotusGuest',
          autoPrintReceipt: true,
          autoSendSmsReceipt: true,
        },
      });

      expect(putRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/desk/settings/checkout',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(getRes.statusCode).toBe(200);
      const data = getRes.json();
      expect(data.salesTaxRatePercent).toBe(8.875);
      expect(data.taxCalculationMode).toBe('exclusive');
      expect(data.suggestedTipPercentages).toEqual([15, 18, 20, 25]);
      expect(data.defaultCashFloatCents).toBe(20000);
      expect(data.receiptFooterMessage).toBe('感谢光临！WiFi: LotusGuest');
    });
  });

  // 3. 在线预约与排班规则
  describe('3. 在线预约与排班规则', () => {
    it('PUT /api/desk/settings/online-booking 保存扩展预约规则', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/desk/settings/online-booking',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          enabled: true,
          maxDaysAhead: 60,
          minMinutesAhead: 120,
          cancelCutoffHours: 4,
          slotIntervalMinutes: 30,
          depositRequired: true,
          depositAmountCents: 2500,
          allowClientPickStaff: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(true);
    });
  });

  // 4. AI 电话助手高级配置
  describe('4. AI 电话助手高级配置', () => {
    it('PUT /api/desk/settings/phone-assistant 保存问候语与转接号', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/desk/settings/phone-assistant',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          greetingPrompt: '您好，感谢致电 Lotus Spa！请问有什么可以帮您？',
          forwardPhoneNumber: '+12125550199',
          autoBookEnabled: true,
          voiceTone: 'warm',
          afterHoursVoicemail: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().saved).toBe(true);
    });
  });

  // 5. 10DLC 品牌认证资质申请
  describe('5. 10DLC 品牌认证资质申请', () => {
    it('POST /api/desk/settings/10dlc/apply 与 GET /api/desk/settings/10dlc/status', async () => {
      const postRes = await app.inject({
        method: 'POST',
        url: '/api/desk/settings/10dlc/apply',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          legalBusinessName: 'Lotus Spa & Wellness LLC',
          ein: '12-3456789',
          businessStructure: 'llc',
          registeredAddress: '128 E 56th St, New York, NY 10022',
          repName: 'Emily Zhang',
          repTitle: 'Store Owner',
          repEmail: 'owner@lotusspanyc.com',
          repPhone: '+12125808888',
          optInMethod: '顾客在官网预约勾选同意，或在 iPad 签到签署',
          sampleMessages: ['Lotus Spa: Hi {Name}, your appointment is confirmed.'],
        },
      });

      expect(postRes.statusCode).toBe(200);
      expect(postRes.json().status).toBe('pending_review');

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/desk/settings/10dlc/status',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(getRes.statusCode).toBe(200);
      const data = getRes.json();
      expect(data.status).toBe('pending_review');
      expect(data.legalBusinessName).toBe('Lotus Spa & Wellness LLC');
      expect(data.ein).toBe('12-3456789');
    });
  });

  // 6. 大堂 iPad 免责知情声明模板
  describe('6. 大堂 iPad 免责知情声明模板', () => {
    it('PUT /api/desk/settings/hardware/intake-waiver 与 GET /api/desk/settings/hardware/intake-waiver', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/desk/settings/hardware/intake-waiver',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          waiverTitle: '顾客服务知情同意书与健康声明',
          waiverContent: '本人确认已如实告知自身健康状况及过敏史...',
          requireSignature: true,
          requireHealthAllergies: true,
          requirePressurePreference: true,
        },
      });

      expect(putRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/desk/settings/hardware/intake-waiver',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().waiverTitle).toBe('顾客服务知情同意书与健康声明');
      expect(getRes.json().requireSignature).toBe(true);
    });
  });

  // 7. Webhook 事件回调配置
  describe('7. Webhook 事件回调配置', () => {
    it('PUT /api/desk/settings/webhooks 与 GET /api/desk/settings/webhooks', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/desk/settings/webhooks',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
        payload: {
          url: 'https://api.mybrand.com/webhooks/gf-events',
          events: ['booking.created', 'ticket.paid'],
        },
      });

      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().webhookId).toBeTruthy();

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/desk/settings/webhooks',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().length).toBeGreaterThan(0);
    });
  });

  // 8. 主聚合查询接口 GET /api/desk/settings & GET /v1/desk/settings
  describe('8. 全局设置聚合查询 GET /api/desk/settings & GET /v1/desk/settings', () => {
    it('GET /api/desk/settings 返回符合前端契约的完整主响应数据', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/desk/settings',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.location).toBeTruthy();
      expect(data.location.slug).toBe('lotus-spa-nyc');
      expect(data.location.businessType).toBe('mixed');
      expect(data.location.phone).toBe('+1 (212) 580-8888');
      expect(data.location.email).toBe('contact@lotusspanyc.com');
      expect(data.location.addressStreet).toBe('128 E 56th St, Suite 4B');

      expect(data.checkout).toBeTruthy();
      expect(data.checkout.salesTaxRatePercent).toBe(8.875);
      expect(data.checkout.defaultCashFloatCents).toBe(20000);

      expect(data.guest).toBeTruthy();
      expect(data.guest.onlineBooking.slotIntervalMinutes).toBe(30);

      expect(data.tenDlc.status).toBe('pending_review');
      expect(data.intakeWaiver.waiverTitle).toBe('顾客服务知情同意书与健康声明');
      expect(data.webhooks.length).toBeGreaterThan(0);
    });

    it('GET /v1/desk/settings 同步返回完整主响应数据', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/desk/settings',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().location.slug).toBe('lotus-spa-nyc');
    });
  });

});
