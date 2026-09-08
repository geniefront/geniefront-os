/**
 * 个人资料、安全 PIN 码与设备会话命令处理器
 */

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
import { hashPin } from '../auth/pin';

/**
 * ⚠️ 这里以前是 `sha256('gf_pin_salt_' + pin)` —— 全局盐、单轮（AUD-11）。
 * 实现已经挪到 `auth/pin.ts`：每行一个随机盐 + scrypt，
 * 而且写入方和校验方从此共用同一个模块（原来两边算法不一样，永远对不上）。
 */
export { hashPin };

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
        max_concurrent_appointments = coalesce(${input.maxConcurrentAppointments ?? null}, max_concurrent_appointments)
      where membership_id = ${ctx.membershipId}`;

    /*
     * 技能同步 —— 与 `staff.saveProfile`（sql/0114 / 批次 #7）同一条纪律：
     *   · `skillIds` 是权威入口，校验本店 + 可用（active 或本人已关联）；
     *   · `skills` 自由文本只解析现存项、**不再新建**，解析不到即拒绝。
     * 自助编辑面不承担创建门店技能字典的职责。
     */
    if (input.skillIds !== undefined || input.skills !== undefined) {
      const priorSkills = await tx<{ skill_id: string }[]>`
        select skill_id from staff_skills where membership_id = ${ctx.membershipId}`;
      const heldIds = new Set(priorSkills.map((s) => s.skill_id));
      const resolvedIds = new Set<string>();

      if (input.skillIds) {
        const uniqueIds = [...new Set(input.skillIds)];
        if (uniqueIds.length > 0) {
          const allowed = await tx<{ id: string }[]>`
            select sk.id from skills sk
            where sk.location_id = ${ctx.locationId} and sk.id = any(${uniqueIds})
              and (sk.active or sk.id = any(${[...heldIds]}))`;
          if (allowed.length !== uniqueIds.length) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'invalid_or_inactive_skill' } });
          }
          for (const id of uniqueIds) resolvedIds.add(id);
        }
      }

      for (const rawName of input.skills ?? []) {
        const wanted = rawName.trim();
        if (!wanted) continue;
        const [existingSkill] = await tx<{ id: string; active: boolean }[]>`
          select id, active from skills
          where location_id = ${ctx.locationId}
            and (key = ${wanted}
                 or lower(btrim(name->>'zh-Hans')) = ${wanted.toLowerCase()}
                 or lower(btrim(name->>'en')) = ${wanted.toLowerCase()})
          limit 1`;
        if (!existingSkill) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'unknown_skill' } });
        }
        if (!existingSkill.active && !heldIds.has(existingSkill.id)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'invalid_or_inactive_skill' } });
        }
        resolvedIds.add(existingSkill.id);
      }

      await tx`delete from staff_skills where membership_id = ${ctx.membershipId}`;
      for (const skillId of resolvedIds) {
        await tx`
          insert into staff_skills (membership_id, skill_id, proficiency)
          values (${ctx.membershipId}, ${skillId}, 1)
          on conflict do nothing`;
      }

      // 反规范化的 legacy 数组按最终集合的 zh-Hans 名重写，保持读取层顺序一致。
      const names = resolvedIds.size > 0
        ? await tx<{ name: string }[]>`
            select coalesce(name->>'zh-Hans', name->>'en', key) as name
            from skills where id = any(${[...resolvedIds]}) order by key`
        : [];
      await tx`
        update staff_profiles set skills = ${names.map((n) => n.name)}
        where membership_id = ${ctx.membershipId}`;
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
      skillIds: input.skillIds,
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

  const hashed = await hashPin(input.pin);

  /**
   * ⚠️ 必须按 **location** 收窄，不能只按 membership_id（AUD-06）。
   *
   * RLS 挡的是跨 org，挡不住同一个 org 内的跨门店：一个在 A 店有
   * `staff.manage` 的店长，能给 B 店某位技师设 PIN，而 PIN 就是那台
   * 共享 iPad 上的身份切换凭据。`staff.manage` 是**门店级**授权，
   * 不是集团级。
   */
  const [row] = await tx<{ membership_id: string }[]>`
    update staff_profiles set
      pin_hash = ${hashed}
    where membership_id = ${targetMembershipId}
      and location_id = ${ctx.locationId}
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
