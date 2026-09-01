import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadReviewsSummary } from './queries/reviews';
import { loadQueue } from './queries/queue';
import { loadAppointmentForms } from './queries/forms';
import { loadOrders } from './queries/orders';
import { loadFormKey, encryptAnswers } from './kiosk/crypto';

import './handlers/appointment';
import './handlers/ticket';
import './handlers/rotation';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let membershipId: string;
let staff2Id: string;
let testCustomerId: string;
let testServiceId: string;
let testTemplateId: string;
const today = new Date().toISOString().slice(0, 10);
const historicalDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const historicalStart = `${historicalDay}T14:00:00Z`;
const historicalEnd = `${historicalDay}T15:00:00Z`;

beforeAll(async () => {
  const staffMembers = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active' and m.user_id is not null
      and r.key in ('owner', 'manager')
    limit 1`);

  membershipId = staffMembers[0]!.id;
  ownerCtx = await buildContext({ userId: staffMembers[0]!.user_id, membershipId });

  const otherStaff = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from memberships where location_id = ${NAIL_LOC} and id <> ${membershipId} limit 1`);
  staff2Id = otherStaff[0]?.id ?? membershipId;

  // 1. 创建测试客户
  const dynamicPhone = `+1617${Math.floor(1000000 + Math.random() * 9000000)}`;
  const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164, email, vip_level)
    values (${NAIL_ORG}, ${NAIL_LOC}, '工作台测试客', ${dynamicPhone}, 'ws-test@maildrop.cc', 2)
    returning id`);
  testCustomerId = cust!.id;

  const [svc] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services where location_id = ${NAIL_LOC} limit 1`);
  testServiceId = svc!.id;

  // 2. 创建或获取健康表模板
  const [tpl] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from form_templates where location_id = ${NAIL_LOC} limit 1`);
  if (tpl) {
    testTemplateId = tpl.id;
  } else {
    const [newTpl] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into form_templates (
        org_id, location_id, key, version, title, schema, requires_signature, published_at
      ) values (
        ${NAIL_ORG}, ${NAIL_LOC}, 'health_intake', 1, '{"zh": "健康问卷", "en": "Health Intake"}'::jsonb,
        '[]'::jsonb, true, now()
      ) returning id`);
    testTemplateId = newTpl!.id;
  }
});

afterAll(async () => {
  await closeDb();
});

describe('前台 5 大核心工作台后端专项测试', () => {
  describe('1. 概览仪表盘 (Dashboard & Reviews)', () => {
    it('loadReviewsSummary 正常返回多平台口碑聚合及 AI 智能总结', async () => {
      const summary = await withTenant(tenant, (tx) => loadReviewsSummary(tx, ownerCtx));

      expect(typeof summary.overallScore).toBe('number');
      expect(summary.overallScore).toBeGreaterThanOrEqual(1);
      expect(typeof summary.totalReviewCount).toBe('number');
      expect(summary.platformBreakdown).toBeDefined();
      expect(summary.platformBreakdown.google).toBeDefined();
      expect(summary.platformBreakdown.yelp).toBeDefined();
      expect(summary.platformBreakdown.inStore).toBeDefined();
      // AI summaries are persisted facts, not seed-time placeholder content.
      expect(Array.isArray(summary.aiSummary.topKeywords)).toBe(true);
      expect(Array.isArray(summary.aiSummary.topStaff)).toBe(true);
      expect(Array.isArray(summary.recentReviews)).toBe(true);
    });
  });

  describe('2. 日程安排 (Schedule & Form Versioning)', () => {
    let createdAptId: string;

    it('appointment.create 支持过去时间补单审计字段并成功入库', async () => {
      const res = await dispatch<{ appointmentId: string; businessDate: string }>(
        'appointment.create',
        {
          customerId: testCustomerId,
          partySize: 1,
          notes: '前台补录工单',
          source: 'desk',
          isBackfill: true,
          backfillReason: '事后补录工单',
          backfillNotes: '客人现金离线结账后补充预约',
          override: { reason: 'desk_coordination', note: '补录工单测试' },
          items: [
            {
              serviceId: testServiceId,
              addonIds: [],
              membershipId,
              startsAt: historicalStart,
              durationMin: 45,
            },
          ],
        },
        ownerCtx,
        { idempotencyKey: `idemp-apt-backfill-${Date.now()}` },
      );

      expect(res.result.appointmentId).toBeDefined();
      createdAptId = res.result.appointmentId;

      const [row] = await withTenant(tenant, (tx) => tx<{
        is_backfill: boolean; backfill_reason: string; backfill_notes: string;
      }[]>`
        select is_backfill, backfill_reason, backfill_notes
        from appointments where id = ${createdAptId}`);

      expect(row!.is_backfill).toBe(true);
      expect(row!.backfill_reason).toBe('事后补录工单');
      expect(row!.backfill_notes).toBe('客人现金离线结账后补充预约');
    });

    it('健康问卷多版本存证与重填 (loadAppointmentForms & Version Chaining)', async () => {
      const key = loadFormKey(process.env['FORM_ENCRYPTION_KEY']);
      const encrypted = encryptAnswers({ allergies: ['penicillin'], pregnant: false }, key);

      // 首次签署 Version 1
      const [v1] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into form_submissions (
          org_id, location_id, customer_id, appointment_id, template_id, template_version,
          version, is_latest, answers_encrypted, enc_alg, signature_url, signed_at,
          signer_name, signer_relation, source
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${testCustomerId}, ${createdAptId},
          ${testTemplateId}, 1, 1, true, ${encrypted}, 'aes-256-gcm.v1',
          'signatures/v1.svg', now(), '工作台测试客', 'self', 'desk'
        ) returning id`);

      // 重填 Version 2 并 supersede Version 1
      const [v2] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into form_submissions (
          org_id, location_id, customer_id, appointment_id, template_id, template_version,
          version, is_latest, answers_encrypted, enc_alg, signature_url, signed_at,
          signer_name, signer_relation, source
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${testCustomerId}, ${createdAptId},
          ${testTemplateId}, 1, 2, true, ${encrypted}, 'aes-256-gcm.v1',
          'signatures/v2.svg', now(), '工作台测试客', 'self', 'desk'
        ) returning id`);

      await withTenant(tenant, (tx) => tx`
        update form_submissions set is_latest = false, superseded_by = ${v2!.id}
        where id = ${v1!.id}`);

      // 查询预约关联的所有历史问卷版本
      const res = await withTenant(tenant, (tx) => loadAppointmentForms(tx, ownerCtx, createdAptId));
      expect(res.forms.length).toBeGreaterThanOrEqual(2);
      expect(res.forms[0]!.version).toBe(2);
      expect(res.forms[0]!.isLatest).toBe(true);
      expect(res.forms[1]!.version).toBe(1);
      expect(res.forms[1]!.isLatest).toBe(false);
    });
  });

  describe('3. 运营看板 (Queue & Stage Rollback)', () => {
    let queueAptId: string;
    let queueEntryId: string;

    it('loadQueue 能够富载返回 VIP 级别、健康问卷签署状态与禁忌', async () => {
      const [qRow] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into walkin_queue (
          org_id, location_id, customer_id, business_date, ticket_number, status, source
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${testCustomerId}, ${today}, ${Math.floor(100 + Math.random() * 800)}, 'waiting', 'kiosk'
        ) returning id`);
      queueEntryId = qRow!.id;

      const q = await withTenant(tenant, (tx) => loadQueue(tx, ownerCtx, today));
      const entry = q.waiting.find((e) => e.queueId === queueEntryId);
      expect(entry).toBeDefined();
      expect(entry!.vipLevel).toBe(2);
      expect(typeof entry!.intakeSigned).toBe('boolean');
    });

    it('queue.rollbackStage 逆向安全回退状态并记录审计', async () => {
      // 创建预约并更新为 in_service
      const [apt] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into appointments (
          org_id, location_id, customer_id, business_date, starts_at, ends_at, status
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${testCustomerId}, ${historicalDay},
          ${historicalStart}, ${historicalEnd}, 'in_service'
        ) returning id`);
      queueAptId = apt!.id;

      // 触发回退命令回到 checked_in
      const res = await dispatch<{ appointmentId: string; targetStage: string; rolledBack: boolean }>(
        'queue.rollbackStage',
        {
          appointmentId: queueAptId,
          fromStage: 'in_service',
          targetStage: 'checked_in',
          reason: 'wrong_drag',
          notes: '前台误将客人拖入服务中',
        },
        ownerCtx,
      );

      expect(res.result.rolledBack).toBe(true);
      expect(res.result.targetStage).toBe('checked_in');

      const [updated] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
        select status from appointments where id = ${queueAptId}`);
      expect(updated!.status).toBe('checked_in');
    });
  });

  describe('4. 收银结账 (Checkout & Multi-Staff Tip Splits)', () => {
    it('ticket.pay 支持刷卡手续费 surchargeCents 与多技师小费分账 tipSplits', async () => {
      // 1. 创建待结账单据
      const [t] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into tickets (
          org_id, location_id, customer_id, business_date, status,
          subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${testCustomerId}, ${historicalDay}, 'open',
          10000, 0, 0, 0, 10000
        ) returning id`);

      await withTenant(tenant, (tx) => tx`
        insert into ticket_items (
          org_id, location_id, ticket_id, service_id, kind, name_snapshot, unit_price_cents, total_cents
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${t!.id}, ${testServiceId}, 'service', '高级 SPA', 10000, 10000
        )`);

      await withTenant(tenant, (tx) => tx`
        insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
        values (
          ${NAIL_ORG},
          (select id from ticket_items where ticket_id = ${t!.id} limit 1),
          ${membershipId}, 'primary', 60
        )`);

      // 2. 结账：$100 本金 + $3.50 刷卡手续费 (350) + $20 小费 (2000) = $123.50 (12350)
      // 小费分给技师1 $12 (1200), 技师2 $8 (800)
      const res = await dispatch<{
        ticketId: string;
        totalCents: number;
        tipCents: number;
        allocations: Array<{ membershipId: string; amountCents: number }>;
      }>(
        'ticket.pay',
        {
          ticketId: t!.id,
          surchargeCents: 350,
          discountCents: 0,
          payments: [
            {
              method: 'card',
              amountCents: 12350,
              tipCents: 2000,
            },
          ],
          tipSplits: [
            {
              staffMembershipId: membershipId,
              staffName: '技师甲',
              amountCents: 1200,
              percentageBp: 6000,
            },
            {
              staffMembershipId: staff2Id,
              staffName: '技师乙',
              amountCents: 800,
              percentageBp: 4000,
            },
          ],
        },
        ownerCtx,
        { idempotencyKey: `idemp-pay-${Date.now()}` },
      );

      expect(res.result.totalCents).toBe(12350);
      expect(res.result.tipCents).toBe(2000);
      expect(res.result.allocations.length).toBe(2);

      const [closedRow] = await withTenant(tenant, (tx) => tx<{
        status: string; surcharge_cents: number; total_cents: number; tip_cents: number;
      }[]>`
        select status, surcharge_cents, total_cents, tip_cents
        from tickets where id = ${t!.id}`);

      expect(closedRow!.status).toBe('closed');
      expect(closedRow!.surcharge_cents).toBe(350);
      expect(closedRow!.total_cents).toBe(12350);
      expect(closedRow!.tip_cents).toBe(2000);
    });
  });

  describe('5. 订单记录与退款冲销 (Orders & Ticket Refund)', () => {
    let refundTicketId: string;

    it('loadOrders 支持多维筛选与分页', async () => {
      const orders = await withTenant(tenant, (tx) =>
        loadOrders(tx, ownerCtx, {
          status: 'all',
          from: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10),
          to: today,
          limit: 20,
        })
      );

      expect(orders.total).toBeGreaterThan(0);
      expect(orders.rows.length).toBeGreaterThan(0);
      expect(orders.rows[0]!.ticketId).toBeDefined();
      expect(orders.rows[0]!.items).toBeDefined();
    });

    it('ticket.refund 对已结账单据发起退款并更新状态', async () => {
      // 1. 创建已结单据
      const [t] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into tickets (
          org_id, location_id, customer_id, business_date, status,
          subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${testCustomerId}, ${historicalDay}, 'closed',
          5000, 0, 0, 0, 5000
        ) returning id`);
      refundTicketId = t!.id;

      // 2. 执行全额退款
      const res = await dispatch<{
        ticketId: string;
        status: string;
        refundedCents: number;
        refundMethod: string;
      }>(
        'ticket.refund',
        {
          ticketId: refundTicketId,
          refundAmountCents: 5000,
          reason: 'customer_dissatisfied',
          refundMethod: 'cash',
          notes: '客户对效果不满意，予以全额现金退款',
        },
        ownerCtx,
      );

      expect(res.result.status).toBe('refunded');
      expect(res.result.refundedCents).toBe(5000);

      const [row] = await withTenant(tenant, (tx) => tx<{
        status: string; refund_cents: number; refund_reason: string; refund_method: string;
      }[]>`
        select status, refund_cents, refund_reason, refund_method
        from tickets where id = ${refundTicketId}`);

      expect(row!.status).toBe('refunded');
      expect(row!.refund_cents).toBe(5000);
      expect(row!.refund_reason).toBe('customer_dissatisfied');
      expect(row!.refund_method).toBe('cash');
    });
  });
});
