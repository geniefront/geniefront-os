/**
 * 个人资料、安全 PIN 码与设备会话命令处理器
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  UpdateUserProfile,
  SetStaffPin,
  RevokeUserSession,
  SaveNotificationPreferences,
  AppError,
  ERROR_CODES,
  type CommandContext,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

export function hashPin(pin: string): string {
  return createHash('sha256').update(`gf_pin_salt_${pin}`, 'utf8').digest('hex');
}

async function resolveUserId(
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

// ───────────────────────────────────────────── 1. 更新个人档案与接单偏好
registerHandler(UpdateUserProfile, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof UpdateUserProfile.input._type>) => {
  const userId = await resolveUserId(tx, ctx);
  if (!userId) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'User identity required' } });
  }

  // 1. 更新 users 表
  await tx`
    update users set
      full_name = coalesce(${input.fullName ?? null}, full_name),
      nickname = coalesce(${input.nickname ?? null}, nickname),
      phone = coalesce(${input.phone ?? null}, phone),
      avatar_url = coalesce(${input.avatarUrl ?? null}, avatar_url),
      locale = coalesce(${input.locale ?? null}, locale),
      timezone = coalesce(${input.timezone ?? null}, timezone),
      bio = coalesce(${input.bio ?? null}, bio)
    where id = ${userId}`;

  // 2. 如果存在关联的 staff_profile，同步更新接单能力、并发数、技能标签与牌名
  if (ctx.membershipId) {
    const displayNameJson = input.nickname || input.fullName
      ? jsonb({ en: input.nickname || input.fullName, 'zh-Hans': input.nickname || input.fullName })
      : null;

    await tx`
      update staff_profiles set
        display_name = coalesce(${displayNameJson}::jsonb, display_name),
        nickname = coalesce(${input.nickname ?? null}, nickname),
        is_bookable = coalesce(${input.isBookable ?? null}, is_bookable),
        max_concurrent_appointments = coalesce(${input.maxConcurrentAppointments ?? null}, max_concurrent_appointments),
        skills = coalesce(${input.skills ?? null}, skills)
      where membership_id = ${ctx.membershipId}`;

    // Keep the normalized skill catalog authoritative for scheduling and
    // assignment while preserving the legacy array for older clients.
    if (input.skills !== undefined) {
      await tx`delete from staff_skills where membership_id = ${ctx.membershipId}`;
      for (const rawName of input.skills) {
        const skillName = rawName.trim();
        if (!skillName) continue;
        const [existingSkill] = await tx<{ id: string }[]>`
          select id from skills
          where location_id = ${ctx.locationId}
            and (key = ${skillName} or name->>'zh-Hans' = ${skillName} or name->>'en' = ${skillName})
          limit 1`;
        let skillId = existingSkill?.id;
        if (!skillId) {
          const [createdSkill] = await tx<{ id: string }[]>`
            insert into skills (org_id, location_id, key, name)
            values (${ctx.orgId}, ${ctx.locationId}, ${skillName},
                    ${jsonb({ en: skillName, 'zh-Hans': skillName })}::jsonb)
            returning id`;
          skillId = createdSkill!.id;
        }
        await tx`
          insert into staff_skills (membership_id, skill_id, proficiency)
          values (${ctx.membershipId}, ${skillId}, 1)
          on conflict do nothing`;
      }
    }
  }

  audit({
    entityType: 'user_profile',
    entityId: userId,
    after: {
      fullName: input.fullName,
      nickname: input.nickname,
      phone: input.phone,
      isBookable: input.isBookable,
      maxConcurrentAppointments: input.maxConcurrentAppointments,
      skills: input.skills,
    },
  });

  return { userId, updated: true };
});

// ───────────────────────────────────────────── 2. 设置/重置 POS 快速解锁 PIN 码
registerHandler(SetStaffPin, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetStaffPin.input._type>) => {
  const targetMembershipId = input.membershipId || ctx.membershipId;
  if (!targetMembershipId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'membership_id_required' } });
  }

  // 如果修改他人 PIN 需检查 staff.manage 权限
  if (input.membershipId && input.membershipId !== ctx.membershipId && !ctx.permissions.has('staff.manage')) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'staff.manage' } });
  }

  const hashed = hashPin(input.pin);

  const [row] = await tx<{ membership_id: string }[]>`
    update staff_profiles set
      pin_hash = ${hashed}
    where membership_id = ${targetMembershipId}
    returning membership_id`;

  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff_profile' } });
  }

  audit({
    entityType: 'staff_profile',
    entityId: targetMembershipId,
    after: { hasPin: true, action: 'pin_updated' },
  });

  return { membershipId: targetMembershipId, hasPin: true };
});

// ───────────────────────────────────────────── 3. 踢下线指定设备会话
registerHandler(RevokeUserSession, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RevokeUserSession.input._type>) => {
  const userId = await resolveUserId(tx, ctx);
  if (!userId) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'User identity required' } });
  }

  const [row] = await tx<{ id: string }[]>`
    update user_device_sessions set
      is_active = false,
      revoked_at = now()
    where id = ${input.sessionId} and user_id = ${userId}
    returning id`;

  if (!row) {
    // 幂等：若已不存在或已下线，仍返回成功
    return { sessionId: input.sessionId, revoked: true };
  }

  audit({
    entityType: 'user_device_session',
    entityId: input.sessionId,
    after: { isActive: false, revokedAt: new Date().toISOString() },
  });

  return { sessionId: input.sessionId, revoked: true };
});

// ───────────────────────────────────────────── 4. 保存个人多渠道通知偏好
registerHandler(SaveNotificationPreferences, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveNotificationPreferences.input._type>) => {
  const userId = await resolveUserId(tx, ctx);
  if (!userId) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'User identity required' } });
  }

  const inAppJson = input.inApp ? jsonb(input.inApp) : jsonb({});
  const smsJson = input.sms ? jsonb(input.sms) : jsonb({});
  const emailJson = input.email ? jsonb(input.email) : jsonb({});

  await tx`
    insert into user_notification_preferences (
      user_id, location_id, in_app, sms, email, updated_at
    ) values (
      ${userId}, ${ctx.locationId ?? null},
      coalesce(${input.inApp ? inAppJson : null}::jsonb, '{"appointmentNew": true, "appointmentChanged": true, "appointmentCancelled": true, "paymentFailed": true, "customerFeedback": true, "payoutSettled": true, "systemSecurity": true}'::jsonb),
      coalesce(${input.sms ? smsJson : null}::jsonb, '{"appointmentNew": true, "appointmentChanged": false, "emergencyAlerts": true}'::jsonb),
      coalesce(${input.email ? emailJson : null}::jsonb, '{"dailyDigest": true, "financialReports": true, "securityAlerts": true}'::jsonb),
      now()
    )
    on conflict (user_id) do update set
      in_app = case when ${input.inApp !== undefined} then ${inAppJson}::jsonb else user_notification_preferences.in_app end,
      sms = case when ${input.sms !== undefined} then ${smsJson}::jsonb else user_notification_preferences.sms end,
      email = case when ${input.email !== undefined} then ${emailJson}::jsonb else user_notification_preferences.email end,
      updated_at = now()`;

  audit({
    entityType: 'user_notification_preferences',
    entityId: userId,
    after: input,
  });

  return { userId, saved: true };
});
