/**
 * 财务与数据模块后端 API 增改集成验证测试套件
 * 包含：打烊日结面额拆解、商业智能 BI、资金结算薪酬、SaaS 订阅与算力资源中心
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/dayclose';
import './handlers/billing';
import './handlers/setup';
import './handlers/ticket';
import './handlers/staff';
import './handlers/customer';
import './handlers/resource';
import './handlers/marketing';
import './handlers/rotation';
import './handlers/appointment';
import { loadDayClose } from './queries/money';
import { loadHeatmap, loadRfmCustomers, loadTopServices, loadCopilotSummary } from './queries/analytics';
import { loadEarningsEstimates, loadEarningsEstimate, loadClawbacks } from './queries/payouts';
import { loadBillingInvoices, loadTaxProfile } from './queries/billingInvoices';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  const staffMembers = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active' and m.user_id is not null
      and r.key = 'manager'
    limit 1`);
  const ctx = await buildContext({ userId: staffMembers[0]!.user_id, membershipId: staffMembers[0]!.id });
  ownerCtx = {
    ...ctx,
    permissions: new Set([...ctx.permissions, 'billing.manage', 'report.view', 'payroll.view_all']) as unknown as typeof ctx.permissions,
  };
});

afterAll(async () => {
  await closeDb();
});

describe('财务与数据核心模块 API 完整增改测试', () => {

  // ───────────────────────────────────────────────────────── 模块一：打烊日结与财务对账
  describe('1. 打烊日结与财务对账 (/day-close)', () => {
    it('dayclose.recordCash 能够录入零用金收支流水', async () => {
      const res = await dispatch<{ movementId: string; businessDate: string }>(
        'dayclose.recordCash',
        {
          businessDate: today,
          kind: 'supply_purchase',
          amountCents: -3500, // 支出 $35.00 买棉片
          note: '前台采购一次性美甲棉片与酒精棉球',
        },
        ownerCtx,
      );

      expect(res.result.movementId).toBeDefined();
      expect(res.result.businessDate).toBe(today);
    });

    it('dayclose.saveCount 支持面额细分盘点并计算建议保险箱存入金额', async () => {
      const saveRes = await dispatch<{
        countedCashCents: number;
        expectedCashCents: number;
        cashVarianceCents: number;
      }>(
        'dayclose.saveCount',
        {
          businessDate: today,
          breakdown: {
            bill_100: 5,  // $500
            bill_50: 4,   // $200
            bill_20: 10,  // $200
            bill_10: 5,   // $50
            bill_5: 8,    // $40
            bill_1: 10,   // $10
            coin_25: 8,   // $2
          },
          countedCashCents: 100200, // $1002.00
          closingFloatCents: 20000, // 留存 $200.00
          cashVarianceReason: '前台找零微量舍入差异',
        },
        ownerCtx,
      );

      expect(saveRes.result.countedCashCents).toBe(100200);

      // 查询打烊快照
      const snapshot = await withTenant(tenant, (tx) => loadDayClose(tx, ownerCtx, today));
      expect(snapshot.status).toBe('counted');
      expect(snapshot.closingFloatCents).toBe(20000);
      expect(snapshot.safeDropCents).toBe(100200 - 20000); // 80200 = $802.00
      expect(snapshot.varianceThresholdCents).toBeGreaterThan(0);
      expect(snapshot.countBreakdown.bill_100).toBe(5);
      expect(snapshot.countBreakdown.bill_50).toBe(4);
    });
  });

  // ───────────────────────────────────────────────────────── 模块二：业务数据与商业智能 BI
  describe('2. 业务数据与商业智能 BI (/business-data)', () => {
    it('loadHeatmap 返回营业高峰时段热力图矩阵与平均产能利用率', async () => {
      const heatmap = await withTenant(tenant, (tx) => loadHeatmap(tx, ownerCtx, '2026-08-01', today));
      expect(heatmap.matrix).toBeDefined();
      expect(heatmap.matrix['周一']).toHaveLength(6);
      expect(heatmap.matrix['周六']).toHaveLength(6);
      expect(heatmap.peakHour).toBeTruthy();
      expect(heatmap.avgCapacityUtilizationBp).toBeGreaterThan(0);
    });

    it('loadRfmCustomers 返回 VIP/活跃/新客/沉睡客户分层与全渠道获客来源', async () => {
      const rfm = await withTenant(tenant, (tx) => loadRfmCustomers(tx, ownerCtx, '2026-08-01', today));
      expect(rfm.cohorts.vip.count).toBeGreaterThanOrEqual(0);
      expect(rfm.cohorts.active.count).toBeGreaterThanOrEqual(0);
      expect(rfm.cohorts.new.count).toBeGreaterThanOrEqual(0);
      expect(rfm.cohorts.sleeping.count).toBeGreaterThanOrEqual(0);
      expect(rfm.channels).toEqual([]);
    });

    it('loadTopServices 返回爆款服务排行、毛利率与评价', async () => {
      const top = await withTenant(tenant, (tx) => loadTopServices(tx, ownerCtx, '2026-08-01', today));
      expect(top.services.length).toBeGreaterThan(0);
      const first = top.services[0]!;
      expect(first.rank).toBe(1);
      expect(first.name).toBeTruthy();
      expect(first.marginPercent).toBe(0);
      expect(first.rating).toBe(0);
      expect(first.salesCount).toBeGreaterThan(0);
    });

    it('loadCopilotSummary 在尚未生成诊断时返回稳定空状态', async () => {
      const copilot = await withTenant(tenant, (tx) => loadCopilotSummary(tx, ownerCtx));
      expect(copilot.highlights).toEqual([]);
      expect(copilot.risks).toEqual([]);
      expect(copilot.actions).toEqual([]);
      expect(copilot.generatedAt).toBe('');
    });
  });

  // ───────────────────────────────────────────────────────── 模块三：收入估算与记录
  describe('3. 收入估算与记录 (/payouts)', () => {
    it('只从收入台账生成估算，不产生工资支付状态', async () => {
      const payroll = await withTenant(tenant, (tx) => loadEarningsEstimates(tx, ownerCtx));
      expect(payroll.rows.every((row) => row.status === 'estimate')).toBe(true);
      if (payroll.rows[0]) {
        const estimate = await withTenant(tenant, (tx) => loadEarningsEstimate(tx, ownerCtx, payroll.rows[0]!.membershipId));
        expect(estimate.estimate.status).toBe('estimate');
      }
    });

    it('未建立真实冲正台账时不估算提成冲正', async () => {
      const clawbacks = await withTenant(tenant, (tx) => loadClawbacks(tx, ownerCtx));
      expect(clawbacks.rows).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────── 模块四：SaaS 订阅与算力资源中心
  describe('4. SaaS 订阅与算力资源中心 (/subscription)', () => {
    it('billing.changePlan 拒绝本地改套餐，不写入付费状态', async () => {
      await expect(dispatch(
        'billing.changePlan',
        { targetPlan: 'growth', billingCycle: 'monthly' },
        ownerCtx,
      )).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        details: { reason: 'use_checkout_or_portal', command: 'billing.changePlan' },
      });
    });

    it('billing.buyAddon 拒绝本地入账，不写入额度或发票', async () => {
      await expect(dispatch(
        'billing.buyAddon',
        { addonType: 'voice_minutes_100', priceCents: 2500 },
        ownerCtx,
      )).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        details: { reason: 'use_checkout_or_portal', command: 'billing.buyAddon' },
      });
    });

    it('billing.saveTaxProfile 能够保存企业发票抬头与税号', async () => {
      const taxRes = await dispatch<{ saved: boolean }>(
        'billing.saveTaxProfile',
        {
          legalEntityName: 'Glamour Nails & Spa Inc.',
          taxId: 'XX-XXXX8892',
          billingEmail: 'finance@glamournails.com',
        },
        ownerCtx,
      );

      expect(taxRes.result.saved).toBe(true);

      const taxProfile = await withTenant(tenant, (tx) => loadTaxProfile(tx, ownerCtx));
      expect(taxProfile.taxProfile).toBeDefined();
      expect(taxProfile.taxProfile!.legalEntityName).toBe('Glamour Nails & Spa Inc.');
      expect(taxProfile.taxProfile!.taxId).toBe('XX-XXXX8892');
      expect(taxProfile.taxProfile!.billingEmail).toBe('finance@glamournails.com');
    });

    it('loadBillingInvoices 不依赖本地假付费命令', async () => {
      const invs = await withTenant(tenant, (tx) => loadBillingInvoices(tx, ownerCtx));
      expect(Array.isArray(invs.invoices)).toBe(true);
    });
  });
});
