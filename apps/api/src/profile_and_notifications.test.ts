/**
 * 个人资料 (Profile) 与应用内通知中心 (Notifications) 全套后端 API 与数据库集成测试套件
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/profile';
import './handlers/notification';
import './handlers/staff';
import { buildServer } from './server';
import { issueStaffSession, STAFF_TOKEN_HEADER } from './auth/staffSession';
import {
  loadUserProfile, loadUserSessions, loadUserNotificationPreferences,
} from './queries/profile';
import {
  loadDeskNotifications, loadDeskNotificationStats,
} from './queries/notifications';
import { dispatchSystem } from './test/systemDispatch';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let staffToken: string;
let ownerUserId: string;
let ownerMembershipId: string;
const ownerTenant = () => ({ ...tenant, userId: ownerUserId });

/**
 * 取一个**指定角色**的 membership。
 *
 * ⚠️ 原来这里是不带 order by 的 `limit 1`，取到谁完全由物理行序决定 ——
 * 而本文件后面整组用例（`notification.*`、资料修改）都需要 `settings.manage`。
 * 取到一个技师时，五条用例一起报 PERMISSION_DENIED，而报错内容与「行序」
 * 毫无关联，排查方向会整个跑偏。
 *
 * 这一点在 2026-09-01 换种子邮箱域名时被触发：删除与重新插入改变了行序，
 * 于是一次与权限毫不相干的改动让这一组用例集体变红。
 *
 * 与 `auditFixes.test.ts` 的 `ctxForRole` 同一个写法。
 */
async function membershipWithRole(
  role: string,
): Promise<{ id: string; user_id: string } | null> {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and m.user_id is not null and r.key = ${role}
    order by m.id
    limit 1`);
  return m ?? null;
}

beforeAll(async () => {
  // 美甲店里权限最大的那个（种子里是 manager，owner 挂在足疗店）
  const owner = (await membershipWithRole('manager')) ?? (await membershipWithRole('owner'));
  if (!owner) throw new Error('种子里找不到带 manager/owner 角色的 membership');
  ownerMembershipId = owner.id;
  ownerUserId = owner.user_id;

  ownerCtx = await buildContext({ userId: ownerUserId, membershipId: ownerMembershipId });

  const session = await issueStaffSession(
    { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: ownerMembershipId },
    'claim_code',
    'test_macbook_pro',
  );
  staffToken = session.token;

  app = buildServer();
});

afterAll(async () => {
  await closeDb();
});

describe('个人资料与通知中心全量功能后端测试', () => {

  it('voice_booking profile saves, preserves omitted phone and clears explicitly across transactions', async () => {
    const [billing] = await withTenant(ownerTenant(), tx => tx<{ plan: string }[]>`
      select plan from billing_accounts where location_id = ${NAIL_LOC}`);
    try {
      await withTenant(ownerTenant(), tx => tx`update billing_accounts set plan = 'voice_booking' where location_id = ${NAIL_LOC}`);
      const ctx = await buildContext({ userId: ownerUserId, membershipId: ownerMembershipId });
      await dispatch('user.updateProfile', { phone: '+16175550199' }, ctx);
      await dispatch('user.updateProfile', { fullName: 'Voice profile test' }, ctx);
      expect((await withTenant(ownerTenant(), tx => loadUserProfile(tx, ctx))).phone).toBe('+16175550199');
      await dispatch('user.updateProfile', { phone: null }, ctx);
      const fresh = await buildContext({ userId: ownerUserId, membershipId: ownerMembershipId });
      const profile = await withTenant(ownerTenant(), tx => loadUserProfile(tx, fresh));
      expect(profile.phone).toBe('');
      const [stored] = await withTenant(ownerTenant(), tx => tx<{ phone: string | null }[]>`select phone from users where id = ${ownerUserId}`);
      expect(stored?.phone).toBeNull();
      expect(profile.fullName).toBe('Voice profile test');
    } finally {
      if (billing) await withTenant(ownerTenant(), async tx => {
        await tx`update billing_accounts set plan = 'growth' where location_id = ${NAIL_LOC}`;
        await tx`update billing_accounts set plan = ${billing.plan} where location_id = ${NAIL_LOC}`;
      });
    }
  });

  // ───────────────────────────────────────────────────────── 1. 个人资料与账号管理
  describe('1. 个人资料与账号管理 (Profile & Identity)', () => {
    it('user.updateProfile 更新个人姓名、昵称、手机号、技能与接单设置', async () => {
      // 技能一律走本店技能字典 ID（sql/0114 / 批次 #7 契约），自助端不新建
      const dir = await withTenant(ownerTenant(), (tx) => tx<{ id: string; key: string }[]>`
        select id, key from skills where location_id = ${NAIL_LOC} order by key`);
      const gel = dir.find((s) => s.key === 'gel')!;
      const pedicure = dir.find((s) => s.key === 'pedicure')!;

      const res = await dispatch<{ userId: string; updated: boolean }>(
        'user.updateProfile',
        {
          fullName: 'Emily Watson',
          nickname: 'Lisa',
          phone: '+1 (617) 555-0199',
          bio: '前台运营及门店管理负责人 · 专注于极致客户体验与高效店务调度',
          locale: 'zh',
          timezone: 'America/New_York',
          isBookable: true,
          maxConcurrentAppointments: 2,
          skillIds: [gel.id, pedicure.id],
        },
        ownerCtx,
      );

      expect(res.result.userId).toBe(ownerUserId);
      expect(res.result.updated).toBe(true);

      const profile = await withTenant(ownerTenant(), (tx) => loadUserProfile(tx, ownerCtx));
      expect(profile.fullName).toBe('Emily Watson');
      expect(profile.nickname).toBe('Lisa');
      expect(profile.phone).toBe('+16175550199');
      expect(profile.staffInfo?.isBookable).toBe(true);
      expect(profile.staffInfo?.maxConcurrentAppointments).toBe(2);
      expect(new Set(profile.staffInfo?.skillIds)).toEqual(new Set([gel.id, pedicure.id]));
      expect(profile.staffInfo?.skills.slice().sort()).toEqual(['手足 SPA', '甲油胶彩绘']);
      // 字典给出的是本店实际技能，含刚勾选的两项
      expect(profile.staffInfo?.skillDirectory.map((s) => s.id)).toEqual(
        expect.arrayContaining([gel.id, pedicure.id]),
      );
    });

    it('user.updateProfile 自由文本技能只解析现存项，未知值拒绝、不新建字典', async () => {
      const before = await withTenant(ownerTenant(), (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from skills where location_id = ${NAIL_LOC}`);

      await expect(dispatch(
        'user.updateProfile',
        { skills: ['谁也没听过的技能'] },
        ownerCtx,
      )).rejects.toThrow(/VALIDATION_FAILED|unknown_skill/);

      const after = await withTenant(ownerTenant(), (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from skills where location_id = ${NAIL_LOC}`);
      expect(after[0]!.n).toBe(before[0]!.n); // 一行都没新建

      // 而对得上字典名 / key 的自由文本仍可解析
      const ok = await dispatch<{ updated: boolean }>(
        'user.updateProfile',
        { skills: ['甲油胶彩绘', 'pedicure'] },
        ownerCtx,
      );
      expect(ok.result.updated).toBe(true);
      const profile = await withTenant(ownerTenant(), (tx) => loadUserProfile(tx, ownerCtx));
      expect(profile.staffInfo?.skills.slice().sort()).toEqual(['手足 SPA', '甲油胶彩绘']);
    });

    it('GET /v1/me/profile 获取当前登录用户档案信息', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/profile',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.fullName).toBe('Emily Watson');
      expect(data.nickname).toBe('Lisa');
      expect(data.staffInfo).toBeTruthy();
      expect(data.staffInfo.skills).toContain('甲油胶彩绘');
      expect(Array.isArray(data.staffInfo.skillIds)).toBe(true);
      expect(Array.isArray(data.staffInfo.skillDirectory)).toBe(true);
    });

    it('staff.setPin 设置 4 位数字安全 PIN 码并验证已保存哈希', async () => {
      const res = await dispatch<{ membershipId: string; hasPin: boolean }>(
        'staff.setPin',
        {
          pin: '8899',
          membershipId: ownerMembershipId,
        },
        ownerCtx,
      );

      expect(res.result.membershipId).toBe(ownerMembershipId);
      expect(res.result.hasPin).toBe(true);

      const [sp] = await withTenant(ownerTenant(), (tx) => tx<{ pin_hash: string | null }[]>`
        select pin_hash from staff_profiles where membership_id = ${ownerMembershipId}`);

      expect(sp?.pin_hash).toBeTruthy();
      expect(sp?.pin_hash).not.toBe('8899'); // 绝不存明文
    });

    it('GET /v1/me/sessions 获取活跃设备列表与当前设备', async () => {
      // 插入一条测试设备会话
      await withTenant(ownerTenant(), (tx) => tx`
        insert into user_device_sessions (
          user_id, device_label, browser, os, ip_address, is_active
        ) values (
          ${ownerUserId}, 'iPad Pro 12.9" (前台主收银终端)', 'Safari 18.2', 'iPadOS 18.2', '192.168.1.102', true
        )`);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/sessions',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.sessions).toBeTruthy();
      expect(data.sessions.length).toBeGreaterThan(0);
      expect(data.sessions.some((s: any) => s.deviceLabel.includes('iPad'))).toBe(true);
    });

    it('user.revokeSession 踢下线指定设备会话', async () => {
      const [sess] = await withTenant(ownerTenant(), (tx) => tx<{ id: string }[]>`
        select id from user_device_sessions where user_id = ${ownerUserId} and is_active = true limit 1`);

      const res = await dispatch<{ sessionId: string; revoked: boolean }>(
        'user.revokeSession',
        { sessionId: sess!.id },
        ownerCtx,
      );

      expect(res.result.sessionId).toBe(sess!.id);
      expect(res.result.revoked).toBe(true);

      const [revoked] = await withTenant(ownerTenant(), (tx) => tx<{ is_active: boolean }[]>`
        select is_active from user_device_sessions where id = ${sess!.id}`);
      expect(revoked?.is_active).toBe(false);
    });

    it('user.saveNotificationPreferences 保存个人多渠道通知偏好 & GET 查询', async () => {
      const payload = {
        inApp: {
          appointmentNew: true,
          appointmentChanged: true,
          appointmentCancelled: true,
          paymentFailed: true,
          customerFeedback: false,
          payoutSettled: true,
          systemSecurity: true,
        },
        sms: {
          appointmentNew: true,
          appointmentChanged: false,
          emergencyAlerts: true,
        },
        email: {
          dailyDigest: false,
          financialReports: true,
          securityAlerts: true,
        },
      };

      const res = await dispatch<{ userId: string; saved: boolean }>(
        'user.saveNotificationPreferences',
        payload,
        ownerCtx,
      );

      expect(res.result.saved).toBe(true);

      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/me/notification-preferences',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(getRes.statusCode).toBe(200);
      const data = getRes.json();
      expect(data.inApp.customerFeedback).toBe(false);
      expect(data.email.dailyDigest).toBe(false);
      expect(data.sms.emergencyAlerts).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────── 2. 应用内通知中心
  describe('2. 应用内通知中心 (Notification Center)', () => {
    let createdNotifId: string;

    it('notification.create 能够创建应用内通知', async () => {
      /**
       * ⭐ `notification.create` 是系统自有命令（AUD-06）。
       *
       * 原来它一条权限都没声明，而 `recipientUserId` 留空就是全店广播 ——
       * 任何一个登录的技师都能发一条「GenieFront 系统通知」冒充平台说话。
       * 现在只能由服务端编排（预约创建、扣款失败等）触发，
       * 所以测试也必须走系统入口，而不是假装租户能调它。
       */
      const res = await dispatchSystem<{ notificationId: string }>(
        'notification.create',
        {
          category: 'bookings',
          level: 'info',
          title: '新的线上预约已提交',
          titleKey: 'notifNewBooking',
          message: '顾客 Sophia Taylor 预约了今日 15:30 [日式极致光疗美甲]，指定技师 Lisa。',
          actionType: 'appointment',
          actionTargetId: 'apt-test-101',
          actionUrl: '/schedule',
          meta: {
            customerName: 'Sophia Taylor',
            serviceName: '日式极致光疗美甲',
          },
        },
        ownerCtx,
      );

      expect(res.result.notificationId).toBeTruthy();
      createdNotifId = res.result.notificationId;
    });

    it('GET /v1/desk/notifications & /api/desk/notifications 返回通知列表并支持分类筛选', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/desk/notifications?category=bookings',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.notifications).toBeTruthy();
      expect(data.notifications.length).toBeGreaterThan(0);
      expect(data.notifications[0].category).toBe('bookings');
    });

    it('GET /v1/desk/notifications/stats 获取各分类未读统计', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/desk/notifications/stats',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });

      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.unread).toBeGreaterThanOrEqual(1);
      expect(stats.bookingsUnread).toBeGreaterThanOrEqual(1);
    });

    it('notification.markRead 标记单条通知为已读', async () => {
      const res = await dispatch<{ notificationId: string; read: boolean }>(
        'notification.markRead',
        { notificationId: createdNotifId },
        ownerCtx,
      );

      expect(res.result.notificationId).toBe(createdNotifId);
      expect(res.result.read).toBe(true);

      const [n] = await withTenant(ownerTenant(), (tx) => tx<{ read: boolean }[]>`
        select read from in_app_notifications where id = ${createdNotifId}`);
      expect(n?.read).toBe(true);
    });

    it('notification.markAllRead 一键全部标记已读', async () => {
      // 插入一条未读
      await withTenant(ownerTenant(), (tx) => tx`
        insert into in_app_notifications (
          org_id, location_id, category, level, title, message, read
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, 'operations', 'warning', '退款预警', '工单发生退款', false
        )`);

      const res = await dispatch<{ markedCount: number }>(
        'notification.markAllRead',
        { category: 'all' },
        ownerCtx,
      );

      expect(res.result.markedCount).toBeGreaterThanOrEqual(1);
    });

    it('notification.delete 删除单条通知', async () => {
      const res = await dispatch<{ notificationId: string; deleted: boolean }>(
        'notification.delete',
        { notificationId: createdNotifId },
        ownerCtx,
      );

      expect(res.result.deleted).toBe(true);

      const [n] = await withTenant(ownerTenant(), (tx) => tx<{ id: string }[]>`
        select id from in_app_notifications where id = ${createdNotifId}`);
      expect(n).toBeUndefined();
    });

    it('notification.clearRead 一键清理所有已读通知', async () => {
      const res = await dispatch<{ clearedCount: number }>(
        'notification.clearRead',
        { category: 'all' },
        ownerCtx,
      );

      expect(res.result.clearedCount).toBeGreaterThanOrEqual(0);
    });
  });

});
