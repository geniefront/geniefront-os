/**
 * 开店配置的实现。
 *
 * 一条原则：**下架不是删除**。项目下架后历史单据照常显示 ——
 * 开单时项目名和价格已经快照进 ticket_items，改价改名都不会污染历史（02 §8）。
 */

import {
  SaveService, ArchiveService, SaveStaffProfile,
  SetRotationParticipation, SaveBusinessHours,
  ClaimLocation, SaveLocationProfile, FinishSetup,
  ROLE_PRESETS,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SaveService, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveService.input._type>) => {
  if (input.serviceId) {
    const [exists] = await tx<{ id: string }[]>`
      select id from services where id = ${input.serviceId} and location_id = ${ctx.locationId}`;
    if (!exists) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });

    await tx`update services set
        name = ${jsonb(input.name)}::jsonb,
        duration_min = ${input.durationMin},
        base_price_cents = ${input.basePriceCents},
        taxable = ${input.taxable},
        online_bookable = ${input.onlineBookable},
        active = ${input.active}
      where id = ${input.serviceId}`;

    audit({ entityType: 'service', entityId: input.serviceId,
            after: { name: pickText(input.name, ctx.locale), durationMin: input.durationMin } });
    return { serviceId: input.serviceId, created: false };
  }

  const [row] = await tx<{ id: string }[]>`
    insert into services
      (org_id, location_id, name, duration_min, base_price_cents,
       taxable, online_bookable, active)
    values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(input.name)}::jsonb,
            ${input.durationMin}, ${input.basePriceCents},
            ${input.taxable}, ${input.onlineBookable}, ${input.active})
    returning id`;

  audit({ entityType: 'service', entityId: row!.id,
          after: { name: pickText(input.name, ctx.locale), created: true } });
  return { serviceId: row!.id, created: true };
});

registerHandler(ArchiveService, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ArchiveService.input._type>) => {
  // 下架而不是删除：历史 ticket_items 里存的是名字快照，但 service_id 外键还在
  const rows = await tx<{ id: string }[]>`
    update services set active = false
    where id = ${input.serviceId} and location_id = ${ctx.locationId}
    returning id`;
  if (rows.length === 0) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });

  audit({ entityType: 'service', entityId: input.serviceId, after: { active: false } });
  return { serviceId: input.serviceId };
});

registerHandler(SaveStaffProfile, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveStaffProfile.input._type>) => {
  const [cur] = await tx<{
    membership_id: string; is_bookable: boolean; max_concurrent: number;
  }[]>`
    select membership_id, is_bookable, max_concurrent_appointments as max_concurrent
    from staff_profiles
    where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

  await tx`update staff_profiles set
      display_name = coalesce(${input.displayName ? jsonb(input.displayName) : null}::jsonb, display_name),
      is_bookable = coalesce(${input.isBookable ?? null}, is_bookable),
      max_concurrent_appointments = coalesce(${input.maxConcurrentAppointments ?? null}, max_concurrent_appointments),
      level_id = ${input.levelId === undefined ? tx`level_id` : input.levelId}
    where membership_id = ${input.membershipId}`;

  audit({
    entityType: 'staff', entityId: input.membershipId,
    before: { isBookable: cur.is_bookable, maxConcurrent: cur.max_concurrent },
    after: {
      isBookable: input.isBookable ?? cur.is_bookable,
      maxConcurrent: input.maxConcurrentAppointments ?? cur.max_concurrent,
    },
  });
  return { membershipId: input.membershipId };
});

registerHandler(SetRotationParticipation, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetRotationParticipation.input._type>) => {
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${ctx.locationId}`;
  const date = input.businessDate ?? businessDateOf(new Date(), loc!.tz, loc!.cutoff);

  await tx`
    insert into rotation_participants (org_id, location_id, business_date, membership_id, in_rotation)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${input.membershipId}, ${input.inRotation})
    on conflict (location_id, business_date, membership_id)
      do update set in_rotation = excluded.in_rotation`;

  audit({ entityType: 'rotation_participant', entityId: input.membershipId,
          after: { businessDate: date, inRotation: input.inRotation } });
  return { membershipId: input.membershipId, inRotation: input.inRotation, businessDate: date };
});

registerHandler(SaveBusinessHours, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveBusinessHours.input._type>) => {
  // 跨午夜是合法的（足疗店开到凌晨 1 点），不做 open < close 的校验 ——
  // 营业日边界由 business_day_cutoff 负责，不是这里
  await tx`update locations set business_hours = ${jsonb(input.hours)}::jsonb
           where id = ${ctx.locationId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    after: { days: Object.entries(input.hours)
      .filter(([, v]) => v !== null).map(([k]) => k) },
  });
  return { locationId: ctx.locationId };
});

// ─────────────────────────────────────────────────────────────────────────────
// 自助开户：认领门店 + 开店向导（docs/12 §3 B、C）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 认领：把当前登录用户绑成这家店的老板。
 *
 * 这条命令跑在一个**没有 membership 的上下文**里（路由现组的），
 * 因为执行它的人这一刻在系统里还什么都不是。但它仍然是一条完整的命令 ——
 * 有 Zod schema、有权限、有审计、在事务里、受 RLS 约束。
 * 「建租户」那一段绕不开数据库函数（那时候连租户都没有），
 * 而**认领这一段绕得开，所以就不绕**。
 *
 * 事务里的五件事，顺序有讲究：
 *   1. 先抢 intent（一次性的判定），抢不到就整条回滚 —— 后面四件都别做
 *   2. 镜像 auth.users → public.users（users 的 RLS 要求先有 membership，
 *      而 membership 外键指向 users，只能由 sql/0030 那个函数破这个环）
 *   3. 建角色预设（权限的事实源是 ROLE_PRESETS，不在 SQL 里抄第二遍）
 *   4. 建 membership 并挂 owner 角色
 *   5. 把 organizations.owner_user_id 从占位改成真人
 */
registerHandler(ClaimLocation, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ClaimLocation.input._type>) => {
  /**
   * ⭐ 一次性：`claimed_at is null` 写在 where 里，抢到的人才继续。
   *
   * 并发两个请求时数据库只会让一个 update 命中 —— 判定和写入是同一条语句，
   * 中间没有「查一下再写」的缝隙。抢不到就**明确报错**：静默成功的话，
   * 第二个点进来的人会以为自己也是这家店的老板。
   */
  const claimed = await tx<{ id: string; owner_email: string }[]>`
    update signup_intents
    set claimed_at = now(), claimed_user_id = ${ctx.userId}
    where id = ${input.intentId}
      and location_id = ${ctx.locationId}
      and claimed_at is null
    returning id, owner_email`;

  if (claimed.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'signup_already_claimed', intentId: input.intentId },
    });
  }

  // auth.users 那一行镜像进 public.users（sql/0030 §5 解释了为什么非它不可）
  await tx`select gf_sync_user_from_auth(${ctx.userId})`;

  /**
   * 角色预设。权限的事实源是 `ROLE_PRESETS`（packages/contracts）——
   * 种子脚本也是从那里读的，SQL 里不抄第二遍。
   *
   * ⚠️ 这也是为什么「加一条权限要写数据迁移」（docs/12 §4.3）：
   * 权限存在 role_permissions 表里，不是每次从预设实时算的。
   * 新店在这里一次性铺好，老店靠迁移补。
   */
  const roleIds: Record<string, string> = {};
  for (const [key, perms] of Object.entries(ROLE_PRESETS)) {
    const [r] = await tx<{ id: string }[]>`
      insert into roles (org_id, location_id, key, name, is_preset)
      values (${ctx.orgId}, ${ctx.locationId}, ${key}, ${jsonb({ en: key })}::jsonb, true)
      returning id`;
    roleIds[key] = r!.id;
    for (const p of perms) {
      await tx`insert into role_permissions (role_id, permission) values (${r!.id}, ${p})`;
    }
  }

  const [m] = await tx<{ id: string }[]>`
    insert into memberships (org_id, location_id, user_id, status)
    values (${ctx.orgId}, ${ctx.locationId}, ${ctx.userId}, 'active')
    returning id`;
  await tx`insert into membership_roles (membership_id, role_id)
           values (${m!.id}, ${roleIds['owner']!})`;

  /**
   * 老板也建一份 staff_profile，但 `is_bookable = false`。
   *
   * 很多店老板自己也接客 —— 但那是他自己去打开的开关，不是我们替他假设的。
   * 默认打开的话，他一进来轮牌板上就多了一个不该在的人，
   * 而「为什么客人被派给我」这种问题，他不会想到来这里关。
   */
  const [u] = await tx<{ full_name: string | null; email: string | null }[]>`
    select full_name, email from users where id = ${ctx.userId}`;
  const displayName = u?.full_name?.trim()
    || (u?.email ?? claimed[0]!.owner_email).split('@')[0]!;
  await tx`
    insert into staff_profiles
      (membership_id, org_id, location_id, display_name, is_bookable, max_concurrent_appointments)
    values (${m!.id}, ${ctx.orgId}, ${ctx.locationId}, ${jsonb({ en: displayName })}::jsonb,
            false, 1)`;

  // 建店时那个占位的 owner_user_id 换成真人
  await tx`update organizations set owner_user_id = ${ctx.userId}, updated_at = now()
           where id = ${ctx.orgId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    after: { claimedBy: ctx.userId, membershipId: m!.id, intentId: input.intentId },
  });

  return { membershipId: m!.id, locationId: ctx.locationId, orgId: ctx.orgId };
});

/**
 * 店名 / 时区 / 业态 / 营业日边界。
 *
 * ⚠️ **改时区是一件大事**：日程、日结、提成、营业日全部按它算。
 * 这里不做「悄悄换算历史数据」那种事 —— 那会让已经封账的日子对不上。
 * 改的是从此刻起怎么算。
 */
registerHandler(SaveLocationProfile, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveLocationProfile.input._type>) => {
  const [cur] = await tx<{ timezone: string; business_type: string }[]>`
    select timezone, business_type from locations where id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  if (input.timezone) {
    // 认不出的时区宁可当场拒绝：写进去的话，日程表会整个错开一天，
    // 而错的地方在数据库里看起来毫无异常
    const [ok] = await tx<{ ok: boolean }[]>`
      select exists (select 1 from pg_timezone_names where name = ${input.timezone}) as ok`;
    if (!ok?.ok) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'unknown_timezone', got: input.timezone },
      });
    }
  }

  await tx`update locations set
      name = coalesce(${input.name ? jsonb(input.name) : null}::jsonb, name),
      timezone = coalesce(${input.timezone ?? null}, timezone),
      business_type = coalesce(${input.businessType ?? null}, business_type),
      business_day_cutoff = coalesce(${input.businessDayCutoff ?? null}::time, business_day_cutoff),
      /**
       * ⭐ 记一句「老板亲眼确认过这几项」。
       *
       * 这**不是**「向导走到第几步」（那种东西换台设备就成了假进度，
       * docs/12 §3 C 规矩 2）—— 它是一条关于这家店的事实：
       * 官网传来的时区是浏览器猜的，用 VPN 的人拿到的是错的，
       * 所以「有没有人真的看过一眼」必须留下痕迹。
       */
      settings = jsonb_set(settings, '{profile_confirmed_at}', to_jsonb(now()::text)),
      updated_at = now()
    where id = ${ctx.locationId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { timezone: cur.timezone, businessType: cur.business_type },
    after: {
      timezone: input.timezone ?? cur.timezone,
      businessType: input.businessType ?? cur.business_type,
      ...(input.name ? { name: pickText(input.name, ctx.locale) } : {}),
    },
  });
  return { locationId: ctx.locationId };
});

/**
 * 向导走完。`setup` → `active`。
 *
 * 幂等：已经是 active 就直接返回。老板在两台设备上各点一次「完成」
 * 不该看到一个错误 —— 他做的事已经成立了。
 */
registerHandler(FinishSetup, async ({ ctx, tx, audit }: HandlerArgs<
  typeof FinishSetup.input._type>) => {
  const [row] = await tx<{ status: string }[]>`
    update locations set status = 'active', updated_at = now()
    where id = ${ctx.locationId} and status = 'setup'
    returning status`;

  if (!row) {
    const [cur] = await tx<{ status: string }[]>`
      select status from locations where id = ${ctx.locationId}`;
    if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    // 审计要留一条（总线要求），但记的是「本来就不是 setup」这个事实
    audit({ entityType: 'location', entityId: ctx.locationId, after: { status: cur.status, noop: true } });
    return { locationId: ctx.locationId, status: cur.status };
  }

  audit({ entityType: 'location', entityId: ctx.locationId,
          before: { status: 'setup' }, after: { status: 'active' } });
  return { locationId: ctx.locationId, status: row.status };
});
