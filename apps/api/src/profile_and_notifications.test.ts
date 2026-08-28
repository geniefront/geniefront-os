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

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let staffToken: string;
let ownerUserId: string;
let ownerMembershipId: string;
const ownerTenant = () => ({ ...tenant, userId: ownerUserId });

beforeAll(async () => {
  const staffMembers = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    where m.location_id = ${NAIL_LOC} and m.status = 'active' and m.user_id is not null
    limit 1`);
  ownerMembershipId = staffMembers[0]!.id;
  ownerUserId = staffMembers[0]!.user_id;

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

  // ───────────────────────────────────────────────────────── 1. 个人资料与账号管理
  describe('1. 个人资料与账号管理 (Profile & Identity)', () => {
    it('user.updateProfile 更新个人姓名、昵称、手机号、技能与接单设置', async () => {
      const res = await dispatch<{ userId: string; updated: boolean }>(
        'user.updateProfile',
        {
          fullName: 'Emily Watson',
          nickname: 'Lisa',
          phone: '+1 (555) 019-2834',
          bio: '前台运营及门店管理负责人 · 专注于极致客户体验与高效店务调度',
          locale: 'zh',
          timezone: 'America/New_York',
          isBookable: true,
          maxConcurrentAppointments: 2,
          skills: ['日式光疗美甲', '手足精油SPA', '前台店务调度'],
        },
        ownerCtx,
      );

      expect(res.result.userId).toBe(ownerUserId);
      expect(res.result.updated).toBe(true);

      const profile = await withTenant(ownerTenant(), (tx) => loadUserProfile(tx, ownerCtx));
      expect(profile.fullName).toBe('Emily Watson');
      expect(profile.nickname).toBe('Lisa');
      expect(profile.phone).toBe('+1 (555) 019-2834');
      expect(profile.staffInfo?.isBookable).toBe(true);
      expect(profile.staffInfo?.maxConcurrentAppointments).toBe(2);
      expect(profile.staffInfo?.skills).toEqual(['日式光疗美甲', '手足精油SPA', '前台店务调度']);
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
      expect(data.staffInfo.skills).toContain('日式光疗美甲');
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
      const res = await dispatch<{ notificationId: string }>(
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
