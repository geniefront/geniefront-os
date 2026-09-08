/**
 * 个人资料、设备会话与偏好设置查询层
 */

import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext, pickText } from '@gf/contracts';

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
    /** 当前持有的技能字典 ID（自助编辑用 ID 选择，与 staff.saveProfile 同契约）。 */
    skillIds: string[];
    /** 本店可选技能字典：启用项 + 本人已关联的停用项。 */
    skillDirectory: Array<{ id: string; name: string; active: boolean }>;
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
  if (!userId) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'Missing authenticated user context' },
    });
  }

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
    where id = ${userId}`;

  if (!user) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'user', id: userId },
    });
  }

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
      skill_names: unknown;
      skill_ids: unknown;
      legacy_skills: string[] | null;
      is_bookable: boolean;
      max_concurrent_appointments: number;
      in_rotation: boolean;
      pin_hash: string | null;
    }[]>`
      select sp.membership_id, sp.display_name, sp.nickname,
             sp.employee_no, sp.job_title, sl.name as level_name,
             coalesce((select jsonb_agg(sk.name order by sk.key)
               from staff_skills ss join skills sk on sk.id = ss.skill_id
               where ss.membership_id = sp.membership_id), '[]'::jsonb) as skill_names,
             coalesce((select jsonb_agg(ss.skill_id order by ss.skill_id)
               from staff_skills ss
               where ss.membership_id = sp.membership_id), '[]'::jsonb) as skill_ids,
             sp.skills as legacy_skills, sp.is_bookable, sp.max_concurrent_appointments,
             coalesce(rp.in_rotation, false) as in_rotation,
             sp.pin_hash
      from staff_profiles sp
      left join staff_levels sl on sl.id = sp.level_id
      left join rotation_participants rp
        on rp.membership_id = sp.membership_id
       and rp.location_id = ${ctx.locationId}
       and rp.business_date = current_date
      where sp.membership_id = ${ctx.membershipId}`;

    let skillDirectory: Array<{ id: string; name: string; active: boolean }> = [];
    if (ctx.membershipId) {
      const dirRows = await tx<{ id: string; name: unknown; active: boolean }[]>`
        select sk.id, sk.name, sk.active from skills sk
        where sk.location_id = ${ctx.locationId}
          and (sk.active or exists (
            select 1 from staff_skills ss
            where ss.skill_id = sk.id and ss.membership_id = ${ctx.membershipId}))
        order by sk.key`;
      skillDirectory = dirRows.map((r) => ({
        id: r.id, name: pickText(r.name, ctx.locale) || '', active: r.active,
      }));
    }

    if (sp) {
      const canonicalSkills = Array.isArray(sp.skill_names)
        ? sp.skill_names.map((name) => pickText(name, ctx.locale)).filter(Boolean)
        : [];
      const legacySkills = sp.legacy_skills ?? [];
      const legacyMatchesCanonical = legacySkills.length === canonicalSkills.length
        && legacySkills.every((name) => canonicalSkills.includes(name));
      staffInfo = {
        membershipId: sp.membership_id,
        employeeNo: sp.employee_no || undefined,
        jobTitle: sp.job_title || undefined,
        levelName: sp.level_name ? pickText(sp.level_name, ctx.locale) : undefined,
        // The normalized catalog controls membership. Preserve legacy ordering
        // only when it represents the exact same set (older profile clients
        // expect the order they submitted).
        skills: canonicalSkills.length > 0
          ? (legacyMatchesCanonical ? legacySkills : canonicalSkills)
          : legacySkills,
        skillIds: Array.isArray(sp.skill_ids) ? (sp.skill_ids as string[]) : [],
        skillDirectory,
        isBookable: sp.is_bookable,
        maxConcurrentAppointments: sp.max_concurrent_appointments,
        inRotation: sp.in_rotation,
        hasPin: Boolean(sp.pin_hash),
      };
    }
  }

  return {
    userId: user.id,
    email: user.email ?? '',
    fullName: user.full_name ?? '',
    nickname: user.nickname ?? '',
    phone: user.phone ?? '',
    avatarUrl: user.avatar_url ?? '',
    locale: user.locale ?? ctx.locale,
    timezone: user.timezone ?? ctx.timezone,
    bio: user.bio ?? '',
    createdAt: user.created_at,
    staffInfo,
  };
}

export async function loadUserSessions(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  _currentIp?: string,
): Promise<UserSessionItemDto[]> {
  const userId = await resolveUserId(tx, ctx);
  if (!userId) return [];

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

  return rows.map((r) => ({
    id: r.id,
    deviceLabel: r.device_label,
    browser: r.browser ?? '',
    os: r.os ?? '',
    ipAddress: r.ip_address || undefined,
    lastActiveAt: r.last_active_at,
    createdAt: r.created_at,
    isCurrent: false,
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
