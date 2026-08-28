/**
 * 系统设置模块全量 10 大面板与 6 大板块后端 API 与数据库改造测试套件
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb, adminSql } from '@gf/db';
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
  // 1. 执行 DDL 迁移
  await adminSql.unsafe(`
    alter table locations add column if not exists business_type text not null default 'mixed';
    alter table locations add column if not exists phone text;
    alter table locations add column if not exists email text;
    alter table locations add column if not exists address_street text;
    alter table locations add column if not exists address_city text;
    alter table locations add column if not exists address_state text;
    alter table locations add column if not exists address_zip text;

    create table if not exists location_checkout_settings (
      location_id uuid primary key references locations(id) on delete cascade,
      sales_tax_rate_percent numeric(6, 4) not null default 8.8750,
      tax_calculation_mode text not null default 'exclusive',
      suggested_tip_percentages integer[] not null default '{15, 18, 20, 25}',
      allow_custom_tip boolean not null default true,
      default_cash_float_cents integer not null default 20000,
      receipt_footer_message text,
      auto_print_receipt boolean not null default true,
      auto_send_sms_receipt boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table location_checkout_settings enable row level security;
    alter table location_checkout_settings force row level security;
    drop policy if exists tenant_isolation on location_checkout_settings;
    create policy tenant_isolation on location_checkout_settings
      using (location_id = app_location_id()) with check (location_id = app_location_id());
    grant select, insert, update on location_checkout_settings to app_user;

    create table if not exists location_scheduling_rules (
      location_id uuid primary key references locations(id) on delete cascade,
      slot_interval_minutes integer not null default 30,
      cancel_cutoff_hours integer not null default 4,
      deposit_required boolean not null default false,
      deposit_amount_cents integer not null default 2000,
      allow_client_pick_staff boolean not null default true,
      require_card_on_file boolean not null default false,
      cancellation_policy_notice text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table location_scheduling_rules enable row level security;
    alter table location_scheduling_rules force row level security;
    drop policy if exists tenant_isolation on location_scheduling_rules;
    create policy tenant_isolation on location_scheduling_rules
      using (location_id = app_location_id()) with check (location_id = app_location_id());
    grant select, insert, update on location_scheduling_rules to app_user;

    create table if not exists location_intake_templates (
      location_id uuid primary key references locations(id) on delete cascade,
      waiver_title text not null default '顾客服务知情同意书与健康声明',
      waiver_content text,
      require_signature boolean not null default true,
      require_health_allergies boolean not null default true,
      require_pressure_preference boolean not null default true,
      auto_sync_to_profile boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table location_intake_templates enable row level security;
    alter table location_intake_templates force row level security;
    drop policy if exists tenant_isolation on location_intake_templates;
    create policy tenant_isolation on location_intake_templates
      using (location_id = app_location_id()) with check (location_id = app_location_id());
    grant select, insert, update on location_intake_templates to app_user;

    create table if not exists location_10dlc_registrations (
      location_id uuid primary key references locations(id) on delete cascade,
      status text not null default 'not_submitted',
      legal_business_name text,
      ein text,
      business_structure text not null default 'llc',
      registered_address text,
      rep_name text,
      rep_title text,
      rep_email text,
      rep_phone text,
      opt_in_method text,
      sample_message_1 text,
      sample_message_2 text,
      sample_messages text[] not null default '{}',
      submitted_at timestamptz,
      reviewed_at timestamptz,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table location_10dlc_registrations enable row level security;
    alter table location_10dlc_registrations force row level security;
    drop policy if exists tenant_isolation on location_10dlc_registrations;
    create policy tenant_isolation on location_10dlc_registrations
      using (location_id = app_location_id()) with check (location_id = app_location_id());
    grant select, insert, update on location_10dlc_registrations to app_user;

    create table if not exists location_webhooks (
      id uuid primary key default gen_random_uuid(),
      location_id uuid not null references locations(id) on delete cascade,
      url text not null,
      events text[] not null default '{booking.created, ticket.paid}',
      active boolean not null default true,
      secret text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table location_webhooks enable row level security;
    alter table location_webhooks force row level security;
    drop policy if exists tenant_isolation on location_webhooks;
    create policy tenant_isolation on location_webhooks
      using (location_id = app_location_id()) with check (location_id = app_location_id());
    grant select, insert, update, delete on location_webhooks to app_user;
  `);

  const staffMembers = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    where m.location_id = ${NAIL_LOC} and m.status = 'active' and m.user_id is not null
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
