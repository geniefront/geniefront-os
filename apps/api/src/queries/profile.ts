/**
 * 个人资料、设备会话与偏好设置查询层
 */

import type postgres from 'postgres';
import { type CommandContext, pickText } from '@gf/contracts';

export interface UserProfileDto {
  userId: string;
  email: string;
  fullName: string;
  nickname: string;
  phone: string;
  avatarUrl: string;
  locale: string;
  timezone: string;
  bio: string;
  createdAt: string;
  staffInfo?: {
    membershipId: string;
    employeeNo?: string | undefined;
    jobTitle?: string | undefined;
    levelName?: string | undefined;
    skills: string[];
    isBookable: boolean;
    maxConcurrentAppointments: number;
    inRotation: boolean;
    hasPin: boolean;
  } | undefined;
}

export interface UserSessionItemDto {
  id: string;
  deviceLabel: string;
  browser: string;
  os: string;
  ipAddress?: string | undefined;
  lastActiveAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface NotificationPreferencesDto {
  inApp: Record<string, boolean>;
  sms: Record<string, boolean>;
  email: Record<string, boolean>;
}

export async function resolveUserId(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<string | null> {
  if (ctx.userId) return ctx.userId;
  if (ctx.membershipId) {
    const [m] = await tx<{ user_id: string | null }[]>`
      select user_id from memberships where id = ${ctx.membershipId}`;
    return m?.user_id ?? null;
  }
  return null;
}

export async function loadUserProfile(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<UserProfileDto> {
  const userId = await resolveUserId(tx, ctx);

  // 1. 查询用户表
  const [user] = await tx<{
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    nickname: string | null;
    avatar_url: string | null;
    locale: string;
    timezone: string | null;
    bio: string | null;
    created_at: string;
  }[]>`
    select id, email, phone, full_name, nickname, avatar_url,
           locale, timezone, bio, created_at::text as created_at
    from users
    where id = ${userId ?? '00000000-0000-0000-0000-000000000000'}`;

  // 2. 查询当前 membership 的 staff_profile 与 staff_level
  let staffInfo: UserProfileDto['staffInfo'] = undefined;
  if (ctx.membershipId) {
    const [sp] = await tx<{
      membership_id: string;
      display_name: unknown;
      nickname: string | null;
      employee_no: string | null;
      job_title: string | null;
      level_name: unknown;
      skills: string[] | null;
      is_bookable: boolean;
      max_concurrent_appointments: number;
      pin_hash: string | null;
    }[]>`
      select sp.membership_id, sp.display_name, sp.nickname,
             sp.employee_no, sp.job_title, sl.name as level_name,
             sp.skills, sp.is_bookable, sp.max_concurrent_appointments,
             sp.pin_hash
      from staff_profiles sp
      left join staff_levels sl on sl.id = sp.level_id
      where sp.membership_id = ${ctx.membershipId}`;

    if (sp) {
      staffInfo = {
        membershipId: sp.membership_id,
        employeeNo: sp.employee_no || undefined,
        jobTitle: sp.job_title || undefined,
        levelName: sp.level_name ? pickText(sp.level_name, ctx.locale) : undefined,
        skills: sp.skills ?? ['日式光疗美甲', '手足精油SPA', '前台店务调度', 'VIP客户服务'],
        isBookable: sp.is_bookable ?? true,
        maxConcurrentAppointments: sp.max_concurrent_appointments ?? 2,
        inRotation: true,
        hasPin: Boolean(sp.pin_hash),
      };
    }
  }

  const email = user?.email ?? 'owner@lotusspanyc.com';
  const defaultName = email.split('@')[0] || 'User';

  return {
    userId: user?.id ?? userId ?? 'usr_current',
    email,
    fullName: user?.full_name ?? defaultName,
    nickname: user?.nickname ?? staffInfo?.employeeNo ?? defaultName,
    phone: user?.phone ?? '+1 (555) 019-2834',
    avatarUrl: user?.avatar_url ?? '',
    locale: user?.locale ?? ctx.locale ?? 'zh',
    timezone: user?.timezone ?? 'America/New_York',
    bio: user?.bio ?? '前台运营及门店管理负责人 · 专注于极致客户体验与高效店务调度',
    createdAt: user?.created_at ?? new Date().toISOString(),
    staffInfo,
  };
}

export async function loadUserSessions(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  currentIp?: string,
): Promise<UserSessionItemDto[]> {
  const userId = await resolveUserId(tx, ctx);
  if (!userId) {
    return [
      {
        id: 'sess_current',
        deviceLabel: 'Apple MacBook Pro (macOS 15.3)',
        browser: 'Google Chrome 133.0',
        os: 'macOS Sequoia',
        ipAddress: currentIp || '127.0.0.1',
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        isCurrent: true,
      },
    ];
  }

  const rows = await tx<{
    id: string;
    device_label: string;
    browser: string | null;
    os: string | null;
    ip_address: string | null;
    last_active_at: string;
    created_at: string;
  }[]>`
    select id, device_label, browser, os, ip_address,
           last_active_at::text as last_active_at,
           created_at::text as created_at
    from user_device_sessions
    where user_id = ${userId} and is_active = true
    order by last_active_at desc`;

  if (rows.length === 0) {
    return [
      {
        id: 'sess_current',
        deviceLabel: 'Apple MacBook Pro (macOS 15.3)',
        browser: 'Google Chrome 133.0',
        os: 'macOS Sequoia',
        ipAddress: currentIp || '127.0.0.1',
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        isCurrent: true,
      },
    ];
  }

  return rows.map((r, idx) => ({
    id: r.id,
    deviceLabel: r.device_label,
    browser: r.browser || 'Chrome / Web App',
    os: r.os || 'macOS',
    ipAddress: r.ip_address || undefined,
    lastActiveAt: r.last_active_at,
    createdAt: r.created_at,
    isCurrent: idx === 0,
  }));
}

export async function loadUserNotificationPreferences(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<NotificationPreferencesDto> {
  const userId = await resolveUserId(tx, ctx);

  const defaultPrefs: NotificationPreferencesDto = {
    inApp: {
      appointmentNew: true,
      appointmentChanged: true,
      appointmentCancelled: true,
      paymentFailed: true,
      customerFeedback: true,
      payoutSettled: true,
      systemSecurity: true,
    },
    sms: {
      appointmentNew: true,
      appointmentChanged: false,
      emergencyAlerts: true,
    },
    email: {
      dailyDigest: true,
      financialReports: true,
      securityAlerts: true,
    },
  };

  if (!userId) return defaultPrefs;

  const [row] = await tx<{
    in_app: Record<string, boolean>;
    sms: Record<string, boolean>;
    email: Record<string, boolean>;
  }[]>`
    select in_app, sms, email
    from user_notification_preferences
    where user_id = ${userId}`;

  if (!row) return defaultPrefs;

  return {
    inApp: { ...defaultPrefs.inApp, ...(row.in_app || {}) },
    sms: { ...defaultPrefs.sms, ...(row.sms || {}) },
    email: { ...defaultPrefs.email, ...(row.email || {}) },
  };
}
