import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatchWithCommerceSale as dispatch } from './test/commerceSaleDispatch';
import { loadStaffDirectory } from './queries/staffList';
import { loadCustomerList } from './queries/customer';
import { loadPackages } from './queries/marketing';
import { loadRotation, currentBusinessDate } from './handlers/rotation';

import './handlers/staff';
import './handlers/customer';
import './handlers/resource';
import './handlers/marketing';
import './handlers/rotation';
import './handlers/appointment';
import './handlers/ticket';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let membershipId: string;
let testCustomerAId: string;
let testCustomerBId: string;
let testResourceId: string;
let testTemplateId: string;

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

  // 1. 创建测试客户 A 与 B（用于 CRM 与合并测试）
  const dynamicPhoneA = `+1617${Math.floor(1000000 + Math.random() * 9000000)}`;
  const dynamicPhoneB = `+1617${Math.floor(1000000 + Math.random() * 9000000)}`;

  const [custA] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164, email, vip_level)
    values (${NAIL_ORG}, ${NAIL_LOC}, '主档案客户', ${dynamicPhoneA}, 'cust-a@maildrop.cc', 1)
    returning id`);
  testCustomerAId = custA!.id;

  const [custB] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164, email, vip_level)
    values (${NAIL_ORG}, ${NAIL_LOC}, '副档案客户(待合并)', ${dynamicPhoneB}, 'cust-b@maildrop.cc', 0)
    returning id`);
  testCustomerBId = custB!.id;

  // 偏好与禁忌
  await withTenant(tenant, (tx) => tx`
    insert into customer_preferences (
      customer_id, org_id, allergies, free_notes
    ) values (
      ${testCustomerBId}, ${NAIL_ORG}, '{"fragrance": true}'::jsonb, '喜欢喝热柠檬水'
    ) on conflict (customer_id) do nothing`);

  // 2. 创建测试房间/工位
  const [rt] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from resource_types where location_id = ${NAIL_LOC} limit 1`);
  let resourceTypeId = rt?.id;
  if (!resourceTypeId) {
    const [newRt] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into resource_types (org_id, location_id, key, name)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'vip_room', '{"zh-Hans": "VIP 包厢", "en": "VIP Room"}'::jsonb)
      returning id`);
    resourceTypeId = newRt!.id;
  }

  const [res] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into resources (org_id, location_id, resource_type_id, name, capacity, status)
    values (${NAIL_ORG}, ${NAIL_LOC}, ${resourceTypeId}, 'VIP 美甲包厢 888', 2, 'available')
    returning id`);
  testResourceId = res!.id;

  // 3. 创建次卡套餐模板
  const [tpl] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into package_templates (
      org_id, location_id, name, price_cents, sessions, valid_days, scope, active
    ) values (
      ${NAIL_ORG}, ${NAIL_LOC}, '{"zh-Hans": "10次美甲护理卡", "en": "10x Manicure Pack"}'::jsonb,
      28000, 10, 180, 'location', true
    ) returning id`);
  testTemplateId = tpl!.id;
});

afterAll(async () => {
  await closeDb();
});

describe('五大核心中台工作台后端 API 完整增改验证测试', () => {
  describe('1. 技师轮牌调度 (Rotation API)', () => {
    it('loadRotation 与 currentBusinessDate 支持历史与今日查询', async () => {
      const { date: todayDate } = await withTenant(tenant, (tx) => currentBusinessDate(tx, NAIL_LOC));
      expect(todayDate).toBeDefined();

      const { participants, events } = await withTenant(tenant, (tx) => loadRotation(tx, ownerCtx, todayDate));
      expect(Array.isArray(participants)).toBe(true);
      expect(Array.isArray(events)).toBe(true);
    });

    it('rotation.reorder / rotation.updatePolicy / rotation.checkIn / checkOut 调度命令执行正常', async () => {
      // 考勤打卡到店
      const inRes = await dispatch(
        'rotation.checkIn',
        { membershipId, note: '早班按时到店' },
        ownerCtx,
      );
      expect(inRes.result).toBeDefined();

      // 调整轮牌策略
      const policyRes = await dispatch(
        'rotation.updatePolicy',
        {
          fairnessWindowDays: 14,
          overdueThresholdHours: 36,
          carryoverPolicy: 'all',
          priorityOwedMakeup: true,
        },
        ownerCtx,
      );
      expect(policyRes.result).toBeDefined();

      // 手工微调排序
      const reorderRes = await dispatch(
        'rotation.reorder',
        {
          membershipId,
          toPosition: 1,
          reason: 'desk_coordination',
          note: '前台调度微调',
        },
        ownerCtx,
      );
      expect(reorderRes.result).toBeDefined();
    });
  });

  describe('2. 房间与工位状态 (Rooms / Resources API)', () => {
    it('resource.setStatus 只管理维护状态，不伪造服务占用事实', async () => {
      await expect(dispatch(
        'resource.setStatus',
        {
          resourceId: testResourceId,
          status: 'in_service',
          guestName: 'Jessica',
          serviceName: '日式猫眼美甲',
          note: '客人要求加深色号',
        },
        ownerCtx,
      )).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'resource_state_is_workflow_managed' },
      });

      const res = await dispatch<{ resourceId: string; status: string }>(
        'resource.setStatus',
        {
          resourceId: testResourceId,
          status: 'maintenance',
          note: '设备检修',
        },
        ownerCtx,
      );

      expect(res.result.status).toBe('maintenance');

      const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
        select status from resources where id = ${testResourceId}`);
      expect(row!.status).toBe('maintenance');

      await dispatch('resource.setStatus', {
        resourceId: testResourceId,
        status: 'available',
      }, ownerCtx);
    });

    it('resource.delete 能够校验预约冲突并完成安全删除', async () => {
      const delRes = await dispatch<{ resourceId: string; deleted: boolean }>(
        'resource.delete',
        { resourceId: testResourceId },
        ownerCtx,
      );

      expect(delRes.result.deleted).toBe(true);

      const [check] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        select id from resources where id = ${testResourceId}`);
      expect(check).toBeUndefined();
    });
  });

  describe('3. 客户列表与 CRM (Customers API)', () => {
    it('loadCustomerList 支持 filterType 与模糊搜索', async () => {
      const allRes = await withTenant(tenant, (tx) =>
        loadCustomerList(tx, ownerCtx, { filterType: 'all', query: '主档案' })
      );
      expect(allRes.total).toBeGreaterThanOrEqual(1);
      expect(allRes.rows.some((r) => r.id === testCustomerAId)).toBe(true);

      const vipRes = await withTenant(tenant, (tx) =>
        loadCustomerList(tx, ownerCtx, { filterType: 'vip' })
      );
      expect(vipRes.rows.every((r) => r.vipLevel > 0)).toBe(true);
    });

    it('customer.sendSms 发送短信入库 outbox', async () => {
      /*
       * ⚠️ 自 2026-09-01 起，前台手打短信要门店自己的 10DLC **获批**之后
       * 才受理（`sms/gate.ts`）。这里先把状态摆好，否则测的就不是
       * 「入库对不对」而是「闸门拦住了吗」——后者有专门的测试
       * （`sms_direct.test.ts` 的「10DLC 闸门」一组）。
       */
      await withTenant(tenant, (tx) => tx`
        insert into location_10dlc_registrations (location_id, status)
        values (${NAIL_LOC}, 'approved')
        on conflict (location_id) do update set status = 'approved'`);

      const smsRes = await dispatch<{ outboxId: string; customerId: string; status: string; segments: number }>(
        'customer.sendSms',
        {
          customerId: testCustomerAId,
          body: '尊贵的会员您好，您的专属美甲保养优惠券已送达！',
        },
        ownerCtx,
      );

      expect(smsRes.result.outboxId).toBeDefined();
      expect(smsRes.result.status).toBe('pending');
      expect(smsRes.result.segments).toBe(1);
    });

    it('customer.merge 合并档案、偏好与资产', async () => {
      const mergeRes = await dispatch<{ targetCustomerId: string; sourceCustomerId: string; mergedCount: number }>(
        'customer.merge',
        {
          targetCustomerId: testCustomerAId,
          sourceCustomerId: testCustomerBId,
        },
        ownerCtx,
        { idempotencyKey: `idemp-merge-${Date.now()}` },
      );

      expect(mergeRes.result.targetCustomerId).toBe(testCustomerAId);

      // 验证 preferences 合并
      const [targetPref] = await withTenant(tenant, (tx) => tx<{
        allergies: any; free_notes: string;
      }[]>`
        select allergies, free_notes from customer_preferences
        where customer_id = ${testCustomerAId}`);

      expect(targetPref?.allergies).toMatchObject({ fragrance: true });
      expect(targetPref?.free_notes).toContain('热柠檬水');

      // 验证 source 已标记合并
      const [sourceCust] = await withTenant(tenant, (tx) => tx<{ merged_into_id: string }[]>`
        select merged_into_id from customers where id = ${testCustomerBId}`);
      expect(sourceCust!.merged_into_id).toBe(testCustomerAId);
    });
  });

  describe('4. 营销中心 (Marketing API)', () => {
    let issuedPackageId: string;
    let issuedCouponId: string;

    it('marketing.issuePackage / package.issue 支持价格覆盖并记入资产账本', async () => {
      const issueRes = await dispatch<{ packageId: string; customerId: string; totalSessions: number }>(
        'marketing.issuePackage',
        {
          templateId: testTemplateId,
          customerId: testCustomerAId,
          soldPriceCentsOverride: 25000, // 优惠价 $250
        },
        ownerCtx,
      );

      expect(issueRes.result.packageId).toBeDefined();
      expect(issueRes.result.totalSessions).toBe(10);
      issuedPackageId = issueRes.result.packageId;

      // 验证预付资产流水
      const [ledger] = await withTenant(tenant, (tx) => tx<{ amount_cents: number; entry: string }[]>`
        select amount_cents, entry from customer_credit_ledger
        where subject_id = ${issuedPackageId} and customer_id = ${testCustomerAId}`);
      expect(ledger!.entry).toBe('issue');
      expect(ledger!.amount_cents).toBe(25000);
    });

    it('marketing.redeemPackage / package.redeem 支持快捷核销', async () => {
      const redeemRes = await dispatch<{ packageId: string; remainingSessions: number; redeemedSessions: number; status: string }>(
        'marketing.redeemPackage',
        {
          customerPackageId: issuedPackageId,
          units: 2,
          reason: '前台双人手部美甲核销',
        },
        ownerCtx,
      );

      expect(redeemRes.result.remainingSessions).toBe(8);
      expect(redeemRes.result.redeemedSessions).toBe(2);
      expect(redeemRes.result.status).toBe('active');
    });

    it('loadPackages 聚合返回套餐模板与会员次卡列表', async () => {
      const pkgs = await withTenant(tenant, (tx) => loadPackages(tx, ownerCtx));
      expect(pkgs.templates.length).toBeGreaterThan(0);
      expect(pkgs.userPackages.length).toBeGreaterThan(0);
      const userPkg = pkgs.userPackages.find((p) => p.id === issuedPackageId);
      expect(userPkg).toBeDefined();
      expect(userPkg!.remainingUnits).toBe(8);
    });

    it('marketing.saveCouponTemplate / voidCoupon 优惠券全生命周期', async () => {
      const couponCode = `SAVE${Math.floor(100 + Math.random() * 800)}`;
      const saveRes = await dispatch<{ templateId: string; code: string; created: boolean }>(
        'marketing.saveCouponTemplate',
        {
          code: couponCode,
          name: { 'zh-Hans': '新客立减 $15', en: '$15 OFF New Guest' },
          kind: 'amount',
          discountCents: 1500,
          minSpendCents: 5000,
          active: true,
        },
        ownerCtx,
      );

      expect(saveRes.result.templateId).toBeDefined();
      issuedCouponId = saveRes.result.templateId;

      const voidRes = await dispatch<{ couponId: string; voided: boolean }>(
        'marketing.voidCoupon',
        {
          couponId: issuedCouponId,
          reason: '活动到期作废',
        },
        ownerCtx,
      );

      expect(voidRes.result.voided).toBe(true);
    });

    it('marketing.adjustLoyaltyPoints 人工调整会员积分', async () => {
      const loyaltyRes = await dispatch<{ customerId: string; deltaPoints: number; currentPoints: number }>(
        'marketing.adjustLoyaltyPoints',
        {
          customerId: testCustomerAId,
          pointsDelta: 200,
          reason: '老带新推荐赠送积分',
        },
        ownerCtx,
      );

      expect(loyaltyRes.result.deltaPoints).toBe(200);
      expect(loyaltyRes.result.currentPoints).toBeGreaterThanOrEqual(200);
    });
  });

  describe('5. 员工中心 (Staff Directory API)', () => {
    let createdStaffMemberId: string;

    it('staff.saveProfile 支持新建员工、工号、职位、技能与薪酬方案联动', async () => {
      // 岗位 / 职级 / 技能须先入本店目录（ID 契约，U02 / W2）
      for (const name of ['资深美甲美睫师']) {
        await dispatch('staff.saveDirectoryOption', { kind: 'job', name }, ownerCtx);
      }
      for (const name of ['高级技师']) {
        await dispatch('staff.saveDirectoryOption', { kind: 'level', name }, ownerCtx);
      }
      for (const name of ['法式光疗', '手部SPA', '日式睫毛']) {
        await dispatch('staff.saveDirectoryOption', { kind: 'skill', name }, ownerCtx);
      }
      const saveRes = await dispatch<{ membershipId: string; created: boolean }>(
        'staff.saveProfile',
        {
          name: 'Vivian 欣欣',
          employeeNo: 'EMP-9088',
          jobTitle: '资深美甲美睫师',
          level: '高级技师',
          skills: ['法式光疗', '手部SPA', '日式睫毛'],
          status: 'active',
          hireDate: '2025-03-01',
          note: '熟练掌握各类彩绘美甲技术',
          isBookable: true,
          payroll: {
            kind: 'commission',
            ratePercent: 50,
            hourlyRateDollars: 20,
            base: 'net',
          },
        },
        ownerCtx,
      );

      expect(saveRes.result.membershipId).toBeDefined();
      expect(saveRes.result.created).toBe(true);
      createdStaffMemberId = saveRes.result.membershipId;

      // 验证 profile 字段入库
      const [profile] = await withTenant(tenant, (tx) => tx<{
        employee_no: string; job_title: string; notes: string;
      }[]>`
        select employee_no, job_title, notes from staff_profiles
        where membership_id = ${createdStaffMemberId}`);

      expect(profile!.employee_no).toBe('EMP-9088');
      expect(profile!.job_title).toBe('资深美甲美睫师');
      expect(profile!.notes).toBe('熟练掌握各类彩绘美甲技术');
    });

    it('loadStaffDirectory 返回完整花名册信息', async () => {
      const roster = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ownerCtx));
      expect(roster.staff.length).toBeGreaterThan(0);

      const vivian = roster.staff.find((s) => s.membershipId === createdStaffMemberId);
      expect(vivian).toBeDefined();
      expect(vivian!.employeeNo).toBe('EMP-9088');
      expect(vivian!.name).toContain('Vivian');
      expect(vivian!.skills).toContain('法式光疗');
      expect(vivian!.payroll?.ratePercent).toBe(50);
      expect(vivian!.status).toBe('active');
    });

    it('staff.setEmployment 修改在岗状态并在离职/休假时生效', async () => {
      // 设为休假
      const leaveRes = await dispatch<{ membershipId: string; status: string }>(
        'staff.setEmployment',
        {
          membershipId: createdStaffMemberId,
          status: 'on_leave',
        },
        ownerCtx,
      );

      expect(leaveRes.result.status).toBe('on_leave');

      // 验证 memberships 状态已变更为 suspended
      const [m] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
        select status from memberships where id = ${createdStaffMemberId}`);
      expect(m!.status).toBe('suspended');

      // 再次设为在职
      const activeRes = await dispatch<{ membershipId: string; status: string }>(
        'staff.setEmployment',
        {
          membershipId: createdStaffMemberId,
          status: 'active',
        },
        ownerCtx,
      );

      expect(activeRes.result.status).toBe('active');
    });
  });
});
