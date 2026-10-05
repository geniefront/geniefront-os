/**
 * 开店配置的实现。
 *
 * 一条原则：**下架不是删除**。项目下架后历史单据照常显示 ——
 * 开单时项目名和价格已经快照进 ticket_items，改价改名都不会污染历史（02 §8）。
 */

import { randomUUID } from 'node:crypto';
import {
  SaveService, FillServiceShortNames, BulkUpdateServices, SaveServiceCategory, ArchiveService, SavePublicBookingProfile,
  SetRotationParticipation, SaveBusinessHours,
  ClaimLocation, SaveLocationProfile, FinishSetup,
  SaveSetupFeatures,
  SaveOnlineBooking, SaveOffHours, AddWebOrigin, RemoveWebOrigin, CreateLocation,
  SaveCheckoutSettings, Apply10Dlc, SaveIntakeWaiver, SaveWebhooks, SetEmailLocale,
  ROLE_PRESETS,
  AppError, ERROR_CODES, pickText,
  parseShopSlug, shopSlugFromName,
  healthFormTemplateKeyForBusinessType,
  LEGACY_SETUP_MISSING_BY_CODE,
} from '@gf/contracts';
import { normalizeOrigin } from '../public/origin';
import { jsonb,readOnlineBooking } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { registerHandler, type HandlerArgs } from '../bus';
import { loadSetupReadiness } from '../queries/setupReadiness';
import { lockSetupResources } from '../setupResources';
import {
  ensureIndustryHealthFormPublished,
  lockFormTemplateKey,
} from '../forms/templates';
import { loadHealthFormsFeatureState } from '../forms/features';

registerHandler(SaveService, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveService.input._type>) => {
  if (input.categoryId) {
    const [category] = await tx<{ id: string }[]>`
      select id from service_categories
      where id = ${input.categoryId} and location_id = ${ctx.locationId}`;
    if (!category) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service_category' } });
  }
  const syncPresentation=async(serviceId:string)=>{
    if(!input.presentation)return;
    const [row]=await tx`select settings from locations where id=${ctx.locationId} for update`;
    if(!row)throw new AppError(ERROR_CODES.NOT_FOUND);
    const profile=row.settings.public_booking_profile??{};
    const services={...profile.services,[serviceId]:{...profile.services?.[serviceId],...input.presentation}};
    await tx`update locations set settings=jsonb_set(settings,'{public_booking_profile}',${jsonb({...profile,services})}::jsonb,true) where id=${ctx.locationId}`;
    audit({entityType:'service_presentation',entityId:serviceId,after:input.presentation});
  };
  const syncRequiredSkills = async (serviceId: string) => {
    if (input.requiredSkillIds === undefined) return;
    const unique = [...new Set(input.requiredSkillIds)];
    const valid = unique.length === 0 ? [] : await tx<{ id: string }[]>`
      select id from skills where location_id = ${ctx.locationId} and id = any(${unique})`;
    if (valid.length !== unique.length) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'skill' } });
    }
    await tx`delete from service_skill_requirements
      where location_id = ${ctx.locationId} and service_id = ${serviceId}`;
    for (const skillId of unique) {
      await tx`insert into service_skill_requirements
        (org_id, location_id, service_id, skill_id)
        values (${ctx.orgId}, ${ctx.locationId}, ${serviceId}, ${skillId})`;
    }
  };
  if (input.serviceId) {
    const [exists] = await tx<{ id: string; is_addon: boolean; online_bookable: boolean }[]>`
      select id, is_addon, online_bookable from services
      where id = ${input.serviceId} and location_id = ${ctx.locationId}`;
    if (!exists) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });

    // 加项不进网约目录：按「本次生效后」的 isAddon / onlineBookable 组合判定
    const effAddon = input.isAddon ?? exists.is_addon;
    const effOnline = input.onlineBookable ?? exists.online_bookable;
    if (effAddon && effOnline) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'addon_not_online_bookable' } });
    }

    await tx`update services set
        category_id = ${input.categoryId === undefined ? tx`category_id` : input.categoryId},
        name = ${jsonb(input.name)}::jsonb,
        short_names = ${input.shortNames === undefined ? tx`short_names` : tx`${jsonb(input.shortNames)}::jsonb`},
        duration_min = ${input.durationMin},
        base_price_cents = ${input.basePriceCents},
        taxable = ${input.taxable === undefined ? tx`taxable` : input.taxable},
        online_bookable = ${input.onlineBookable === undefined ? tx`online_bookable` : input.onlineBookable},
        is_addon = ${input.isAddon === undefined ? tx`is_addon` : input.isAddon},
        staff_count = coalesce(${input.staffCount ?? null}, staff_count),
        active = ${input.active === undefined ? tx`active` : input.active}
      where id = ${input.serviceId}`;

    await syncRequiredSkills(input.serviceId);
    await syncPresentation(input.serviceId);

    audit({ entityType: 'service', entityId: input.serviceId,
            after: { name: pickText(input.name, ctx.locale), durationMin: input.durationMin } });
    return { serviceId: input.serviceId, created: false };
  }

  const isAddon = input.isAddon ?? false;
  // 普通项目新建默认「支持网上预约」；加项默认不进网约目录（§7.2）
  const onlineBookable = input.onlineBookable ?? !isAddon;
  if (isAddon && onlineBookable) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'addon_not_online_bookable' } });
  }

  const [row] = await tx<{ id: string }[]>`
    insert into services
      (org_id, location_id, category_id, name, short_names, duration_min, base_price_cents,
       taxable, online_bookable, is_addon, staff_count, active)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.categoryId ?? null}, ${jsonb(input.name)}::jsonb, ${jsonb(input.shortNames ?? {})}::jsonb,
            ${input.durationMin}, ${input.basePriceCents},
            ${input.taxable ?? false}, ${onlineBookable}, ${isAddon}, ${input.staffCount ?? 1}, ${input.active ?? true})
    returning id`;

  await syncRequiredSkills(row!.id);
  await syncPresentation(row!.id);

  audit({ entityType: 'service', entityId: row!.id,
          after: { name: pickText(input.name, ctx.locale), created: true } });
  return { serviceId: row!.id, created: true };
});

registerHandler(FillServiceShortNames, async ({input,ctx,tx,audit}) => {
  let updated=0, skipped=0;
  for (const item of [...input.items].sort((a,b)=>a.serviceId.localeCompare(b.serviceId))) {
    const [row] = await tx<{short_names:Record<string,string>;updated_at:string}[]>`
      select short_names,updated_at::text from services where id=${item.serviceId} and location_id=${ctx.locationId} for update`;
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'service'}});
    if (row.updated_at !== item.expectedUpdatedAt) { skipped++; continue; }
    const names={...row.short_names};
    for(const [locale,value] of Object.entries(item.shortNames)) if(!names[locale]?.trim() && value) names[locale]=value;
    if(JSON.stringify(names)===JSON.stringify(row.short_names))continue;
    await tx`update services set short_names=${jsonb(names)}::jsonb,updated_at=now() where id=${item.serviceId} and location_id=${ctx.locationId}`;
    audit({entityType:'service',entityId:item.serviceId,before:{shortNames:row.short_names},after:{shortNames:names}});
    updated++;
  }
  if(!updated)audit({entityType:'location',entityId:ctx.locationId,after:{shortNamesUpdated:updated,shortNamesSkipped:skipped}});
  return {updated,skipped};
});

registerHandler(SaveServiceCategory, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveServiceCategory.input._type>) => {
  if (input.categoryId) {
    const [before] = await tx<{ id: string; name: unknown; sort: number }[]>`
      select id, name, sort from service_categories
      where id = ${input.categoryId} and location_id = ${ctx.locationId}`;
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service_category' } });
    await tx`update service_categories
      set name = ${jsonb(input.name)}::jsonb, sort = ${input.sort}
      where id = ${input.categoryId}`;
    audit({ entityType: 'service_category', entityId: input.categoryId,
      before: { name: pickText(before.name, ctx.locale), sort: before.sort },
      after: { name: pickText(input.name, ctx.locale), sort: input.sort } });
    return { categoryId: input.categoryId, created: false };
  }
  const [row] = await tx<{ id: string }[]>`
    insert into service_categories (org_id, location_id, name, sort)
    values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(input.name)}::jsonb, ${input.sort})
    returning id`;
  audit({ entityType: 'service_category', entityId: row!.id,
    after: { name: pickText(input.name, ctx.locale), sort: input.sort, created: true } });
  return { categoryId: row!.id, created: true };
});

registerHandler(ArchiveService, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ArchiveService.input._type>) => {
  // 下架而不是删除：历史 ticket_items 里存的是名字快照，但 service_id 外键还在
  const rows = await tx<{ id: string }[]>`
    update services set active = false, updated_at = now()
    where id = ${input.serviceId} and location_id = ${ctx.locationId}
    returning id`;
  if (rows.length === 0) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });

  audit({ entityType: 'service', entityId: input.serviceId, after: { active: false } });
  return { serviceId: input.serviceId };
});

registerHandler(BulkUpdateServices, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof BulkUpdateServices.input._type>) => {
  const { set } = input;
  const ids = [...new Set(input.serviceIds)];

  // 1. 目标项目必须全部属于本店；缺一即整批失败
  const targets = await tx<{
    id: string; is_addon: boolean; online_bookable: boolean; updated_at: Date;
  }[]>`
    select id, is_addon, online_bookable, updated_at from services
    where location_id = ${ctx.locationId} and id = any(${ids})
    for update`;
  if (targets.length !== ids.length) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });
  }

  // 1b. 乐观锁：确认页取到的版本与当前不一致 = 期间被人改过，整批拒绝（§7.2）。
  if (input.expectedVersions) {
    const expected = input.expectedVersions;
    const stale = targets
      .filter((s) => {
        const want = expected[s.id];
        return want !== undefined && new Date(want).getTime() !== new Date(s.updated_at).getTime();
      })
      .map((s) => s.id);
    if (stale.length > 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'stale_services', serviceIds: stale },
      });
    }
  }

  // 2. 加项不进网约目录
  if (set.onlineBookable === true) {
    const addons = targets.filter((s) => s.is_addon).map((s) => s.id);
    if (addons.length > 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'addon_not_online_bookable', serviceIds: addons },
      });
    }
  }

  // 3. 分类归属校验
  if (set.categoryId) {
    const [category] = await tx<{ id: string }[]>`
      select id from service_categories where id = ${set.categoryId} and location_id = ${ctx.locationId}`;
    if (!category) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service_category' } });
  }

  // 4. 技能归属校验（add / remove / replace 用到的 ID 全部要是本店技能）
  const skillIds = [...new Set([
    ...(set.skillsAdd ?? []), ...(set.skillsRemove ?? []), ...(set.skillsReplace ?? []),
  ])];
  if (skillIds.length > 0) {
    const valid = await tx<{ id: string }[]>`
      select id from skills where location_id = ${ctx.locationId} and id = any(${skillIds})`;
    if (valid.length !== skillIds.length) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'skill' } });
    }
  }

  // 5. 标量字段一条 UPDATE 打完（不传即不改）
  if (set.onlineBookable !== undefined || set.staffCount !== undefined || set.categoryId !== undefined) {
    await tx`update services set
        online_bookable = ${set.onlineBookable === undefined ? tx`online_bookable` : set.onlineBookable},
        staff_count = ${set.staffCount === undefined ? tx`staff_count` : set.staffCount},
        category_id = ${set.categoryId === undefined ? tx`category_id` : set.categoryId}
      where location_id = ${ctx.locationId} and id = any(${ids})`;
  }

  // 6. 技能：replace 整组覆盖；add / remove 增量
  if (set.skillsReplace !== undefined) {
    const want = [...new Set(set.skillsReplace)];
    await tx`delete from service_skill_requirements
      where location_id = ${ctx.locationId} and service_id = any(${ids})`;
    for (const serviceId of ids) {
      for (const skillId of want) {
        await tx`insert into service_skill_requirements (org_id, location_id, service_id, skill_id)
          values (${ctx.orgId}, ${ctx.locationId}, ${serviceId}, ${skillId})`;
      }
    }
  } else {
    if (set.skillsRemove && set.skillsRemove.length > 0) {
      await tx`delete from service_skill_requirements
        where location_id = ${ctx.locationId} and service_id = any(${ids})
          and skill_id = any(${[...new Set(set.skillsRemove)]})`;
    }
    if (set.skillsAdd && set.skillsAdd.length > 0) {
      for (const serviceId of ids) {
        for (const skillId of [...new Set(set.skillsAdd)]) {
          await tx`insert into service_skill_requirements (org_id, location_id, service_id, skill_id)
            values (${ctx.orgId}, ${ctx.locationId}, ${serviceId}, ${skillId})
            on conflict do nothing`;
        }
      }
    }
  }

  audit({
    entityType: 'service', entityId: ctx.locationId,
    after: { bulk: true, serviceIds: ids, fields: Object.keys(set).filter((k) => set[k as keyof typeof set] !== undefined) },
  });
  return { updated: ids.length };
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

  let slug: string | null = null;
  if (input.slug !== undefined) {
    const parsed = parseShopSlug(input.slug);
    if (!parsed.ok) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: parsed.reason, got: input.slug },
      });
    }
    const [hit] = await tx<{ taken: boolean }[]>`
      select gf_shop_slug_taken(${parsed.slug}, ${ctx.locationId}) as taken`;
    if (hit?.taken) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'slug_unavailable', slug: parsed.slug },
      });
    }
    slug = parsed.slug;
  }

  const nameJson = typeof input.name === 'string'
    ? jsonb({ en: input.name, 'zh-Hans': input.name })
    : (input.name ? jsonb(input.name) : null);

  try {
    await tx`update locations set
        name = coalesce(${nameJson}::jsonb, name),
        business_hours = case when ${input.hours !== undefined} then ${input.hours ? jsonb(input.hours) : null}::jsonb else business_hours end,
        slug = coalesce(${slug}, slug),
        timezone = coalesce(${input.timezone ?? null}, timezone),
        business_type = coalesce(${input.businessType ?? null}, business_type),
        phone = coalesce(${input.phone ?? null}, phone),
        email = coalesce(${input.email ?? null}, email),
        address_street = coalesce(${input.addressStreet ?? null}, address_street),
        address_city = coalesce(${input.addressCity ?? null}, address_city),
        address_state = coalesce(${input.addressState ?? null}, address_state),
        address_zip = coalesce(${input.addressZip ?? null}, address_zip),
        business_day_cutoff = coalesce(${input.businessDayCutoff ?? null}::time, business_day_cutoff),
        appointment_email_copy_to_shop = coalesce(
          ${input.appointmentEmailCopyToShop ?? null}, appointment_email_copy_to_shop),
        /**
         * ⭐ 记一句「老板亲眼确认过这几项」。
         */
        settings = jsonb_set(settings, '{profile_confirmed_at}', to_jsonb(now()::text)),
        updated_at = now()
      where id = ${ctx.locationId}`;
  } catch (e) {
    if (slug && (e as { code?: string }).code === '23505') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'slug_unavailable', slug },
      });
    }
    throw e;
  }

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { timezone: cur.timezone, businessType: cur.business_type },
    after: {
      timezone: input.timezone ?? cur.timezone,
      businessType: input.businessType ?? cur.business_type,
      ...(input.name ? { name: typeof input.name === 'string' ? input.name : pickText(input.name, ctx.locale) } : {}),
      ...(slug ? { slug } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.appointmentEmailCopyToShop !== undefined
        ? { appointmentEmailCopyToShop: input.appointmentEmailCopyToShop } : {}),
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
  await lockSetupResources(tx, ctx.locationId);
  const readiness = await loadSetupReadiness(tx, ctx);

  if (!readiness.canLaunch) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'setup_incomplete',
        missing: readiness.missing.map(({ code }) => LEGACY_SETUP_MISSING_BY_CODE[code]),
        repairs: readiness.missing,
      },
    });
  }

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

registerHandler(SaveSetupFeatures, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveSetupFeatures.input._type>) => {
  await tx`select pg_advisory_xact_lock(hashtext(${`setup-features:${ctx.locationId}`}))`;

  // Keep the global order aligned with manual form publication: template key -> location row.
  // Otherwise manual publication can hold the template lock while its FK waits on locations,
  // as this command holds locations and waits on the template lock.
  if (input.healthFormsEnabled === true) {
    const [identity] = await tx<{ business_type: string }[]>`
      select business_type from locations where id = ${ctx.locationId}`;
    if (!identity) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    await lockFormTemplateKey(
      tx,
      ctx.locationId,
      healthFormTemplateKeyForBusinessType(identity.business_type),
    );
  }

  const [location] = await tx<{
    settings: Record<string, unknown>;
    business_type: string;
  }[]>`select settings, business_type from locations
      where id = ${ctx.locationId} for update`;
  if (!location) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const before = (location.settings['features'] ?? {}) as Record<string, unknown>;
  const next = { ...before };
  if (input.healthFormsEnabled !== undefined) {
    next['health_forms_enabled'] = input.healthFormsEnabled;
  }
  if (input.aiVoiceRequested !== undefined) {
    next['ai_voice_requested'] = input.aiVoiceRequested;
  }
  if (input.confirmSetup) next['confirmed_at'] = new Date().toISOString();

  let published: { templateId: string; version: number } | null = null;
  if (input.healthFormsEnabled === true) {
    published = await ensureIndustryHealthFormPublished(tx, ctx, location.business_type);
  }

  await tx`update locations
    set settings = jsonb_set(settings, '{features}', ${jsonb(next)}::jsonb, true),
        updated_at = now()
    where id = ${ctx.locationId}`;

  // 关掉「要 AI 电话」的意愿时，把当前线路的今日接听也一并关掉 —— 否则
  // 界面显示「已关闭」而电话还在接。开启意愿不自动开接听：绑号 / 就绪 /
  // 显式打开是三件独立的事（S1 §5）。
  if (input.aiVoiceRequested === false) {
    await tx`update phone_lines set ai_answer = false
      where location_id = ${ctx.locationId} and purpose = 'ai_voice' and active
        and ai_answer = true`;
  }

  const state = await loadHealthFormsFeatureState(tx, ctx.locationId);

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { features: before },
    after: {
      features: next,
      healthFormTemplateId: published?.templateId ?? state.publishedTemplateId,
      healthFormTemplateVersion: published?.version ?? state.publishedTemplateVersion,
    },
  });
  return {
    locationId: ctx.locationId,
    healthFormsEnabled: state.enabled,
    effectiveHealthFormsEnabled: state.effectiveEnabled,
    aiVoiceRequested: typeof next['ai_voice_requested'] === 'boolean'
      ? next['ai_voice_requested'] : null,
    confirmedAt: state.confirmedAt,
    healthFormTemplateId: published?.templateId ?? state.publishedTemplateId,
    healthFormTemplateVersion: published?.version ?? state.publishedTemplateVersion,
  };
});

// ──────────────────────────────────────────────── 官网对接（docs/13）

registerHandler(SaveOnlineBooking, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveOnlineBooking.input._type>) => {
  const [cur] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const before = (cur.settings['online_booking'] ?? {}) as Record<string, unknown>;
  const previous=readOnlineBooking(cur.settings),depositMethod=input.depositMethod??previous.depositMethod??'fixed';
  const depositPercentBps=depositMethod==='percentage'?(input.depositPercentBps??previous.depositPercentBps??null):null;
  const depositAmountCents=depositMethod==='fixed'?(input.depositAmountCents??previous.depositAmountCents??2000):0;
  if((depositMethod==='fixed'&&input.depositPercentBps!==undefined)
    ||(depositMethod==='percentage'&&input.depositAmountCents!==undefined&&input.depositAmountCents!==0)
    ||(depositMethod==='percentage'&&(!depositPercentBps||!Number.isInteger(depositPercentBps)||depositPercentBps<1||depositPercentBps>10000))
    ||(input.depositRequired&&depositMethod==='fixed'&&depositAmountCents<=0)){
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'invalid_deposit_policy'}});
  }
  const retainDepositAfterCutoff=input.retainDepositAfterCutoff??previous.retainDepositAfterCutoff??false;

  /**
   * ⚠️ 打开在线预约前先看一眼**有没有可订的项目**。
   *
   * 一个项目都没勾 `online_bookable` 就把开关打开，官网上是一个空列表 ——
   * 客人看到的是「这家店什么都不能订」，而老板以为自己开通了。
   * 这比报个错难查得多，所以当场拦下并说清楚该去哪勾。
   */
  if (input.enabled) {
    const [n] = await tx<{ n: number }[]>`
      select count(*)::int as n from services
      where location_id = ${ctx.locationId} and active = true and online_bookable = true`;
    if ((n?.n ?? 0) === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'no_online_bookable_services' },
      });
    }
  }

  // 不传就跟着取消截止走 —— 两个数字对老板来说是同一件事的两面，
  // 让他填两遍只会填出一个自相矛盾的组合（能改不能取消，或者反过来）
  const rescheduleCutoff = input.rescheduleCutoffHours ?? input.cancelCutoffHours;

  const next = {
    enabled: input.enabled,
    max_days_ahead: input.maxDaysAhead,
    min_minutes_ahead: input.minMinutesAhead,
    require_phone_verification: input.requirePhoneVerification,
    cancel_cutoff_hours: input.cancelCutoffHours,
    reschedule_enabled: input.rescheduleEnabled,
    reschedule_cutoff_hours: rescheduleCutoff,
    self_reschedule_max: input.selfRescheduleMax,
    slot_interval_minutes: input.slotIntervalMinutes ?? 30,
    deposit_required: input.depositRequired ?? false,
    deposit_amount_cents:depositAmountCents,
    deposit_method:depositMethod,deposit_percent_bps:depositPercentBps,retain_deposit_after_cutoff:retainDepositAfterCutoff,
    allow_client_pick_staff: input.allowClientPickStaff ?? true,
    require_card_on_file: input.requireCardOnFile ?? false,
    cancellation_policy_notice: input.cancellationPolicyNotice ?? previous.cancellationPolicyNotice ?? '',
  };

  await tx`update locations set
      settings = jsonb_set(settings, '{online_booking}', ${jsonb(next)}::jsonb, true),
      updated_at = now()
    where id = ${ctx.locationId}`;

  await tx`
    insert into location_scheduling_rules (
      location_id, slot_interval_minutes, cancel_cutoff_hours,
      deposit_required, deposit_amount_cents,deposit_method,deposit_percent_bps,retain_deposit_after_cutoff,allow_client_pick_staff,
      require_card_on_file, cancellation_policy_notice, updated_at
    ) values (
      ${ctx.locationId}, ${input.slotIntervalMinutes ?? 30}, ${input.cancelCutoffHours ?? 4},
      ${input.depositRequired ?? false},${depositAmountCents},${depositMethod},${depositPercentBps},${retainDepositAfterCutoff},${input.allowClientPickStaff ?? true},
      ${input.requireCardOnFile ?? false},${input.cancellationPolicyNotice??previous.cancellationPolicyNotice??''},now()
    )
    on conflict (location_id) do update set
      slot_interval_minutes = excluded.slot_interval_minutes,
      cancel_cutoff_hours = excluded.cancel_cutoff_hours,
      deposit_required = excluded.deposit_required,
      deposit_amount_cents = excluded.deposit_amount_cents,
      deposit_method=excluded.deposit_method,deposit_percent_bps=excluded.deposit_percent_bps,retain_deposit_after_cutoff=excluded.retain_deposit_after_cutoff,
      allow_client_pick_staff = excluded.allow_client_pick_staff,
      require_card_on_file = excluded.require_card_on_file,
      cancellation_policy_notice = excluded.cancellation_policy_notice,
      updated_at = now()`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { onlineBooking: before },
    after: { onlineBooking: next },
  });
  return { locationId: ctx.locationId, enabled: input.enabled };
});

registerHandler(SaveOffHours, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveOffHours.input._type>) => {
  const [cur] = await tx<{ settings: Record<string, unknown>; hours: Record<string, unknown> }[]>`
    select settings, business_hours as hours from locations where id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  /**
   * ⚠️ 营业时间都还没配就打开闸门 —— 那不是「拦住非营业时间」，
   * 是「拦住一切」。空的 `business_hours` 在引擎里被当成「还没配」
   * 而直接放行（见 `@gf/scheduling/business-hours` 文件头 ②），
   * 所以打开开关会是一个**什么都不发生**的操作，老板会以为自己设好了。
   * 当场拦下并说清楚该先去哪一页。
   */
  if (input.enforce && Object.keys(cur.hours ?? {}).length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'business_hours_not_configured' },
    });
  }

  const before = (cur.settings['off_hours'] ?? {}) as Record<string, unknown>;

  const next = {
    enforce: input.enforce,
    before_open_minutes: input.beforeOpenMinutes,
    after_close_minutes: input.afterCloseMinutes,
    beyond: input.beyond,
  };

  await tx`update locations set
      settings = jsonb_set(settings, '{off_hours}', ${jsonb(next)}::jsonb, true),
      updated_at = now()
    where id = ${ctx.locationId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { offHours: before },
    after: { offHours: next },
  });
  return { locationId: ctx.locationId, enforce: input.enforce };
});

registerHandler(AddWebOrigin, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AddWebOrigin.input._type>) => {
  // 老板会粘各种东西进来（带路径的、带 www 的、不带协议的）。
  // 让他自己弄对是不现实的 —— 全部收敛掉（04 §2）
  const origin = normalizeOrigin(input.origin);
  if (!origin) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'bad_origin', got: input.origin },
    });
  }

  const [row] = await tx<{ id: string }[]>`
    insert into location_allowed_origins (org_id, location_id, origin, label)
    values (${ctx.orgId}, ${ctx.locationId}, ${origin}, ${input.label ?? null})
    on conflict (location_id, origin) do update set label = excluded.label
    returning id`;

  audit({
    entityType: 'location_allowed_origin', entityId: row!.id,
    after: { origin },
  });
  return { id: row!.id, origin };
});

registerHandler(RemoveWebOrigin, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RemoveWebOrigin.input._type>) => {
  const [row] = await tx<{ id: string; origin: string }[]>`
    delete from location_allowed_origins
    where id = ${input.id} and location_id = ${ctx.locationId}
    returning id, origin`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'origin' } });

  audit({
    entityType: 'location_allowed_origin', entityId: row.id,
    before: { origin: row.origin }, after: null,
  });
  return { id: row.id };
});

// ─────────────────────────────────────────── 同一个 org 下再开一家店（批 4）

/**
 * `location.create` —— 已登录的老板自助开第二家店。
 *
 * ## 和 `gf_provision_tenant()` 的分工
 *
 * 那个函数管**第一家店**：付款 → webhook → 建 org + 建店 + 发激活邮件。
 * 这一条管**第二家起**：org 已经有了、老板已经登录了、卡已经绑了 ——
 * 三样都不用再来一遍。
 *
 * ## ⚠️ org id 不接受入参
 *
 * 新店建在**调用方当前门店的同一个 org 下**（`ctx.orgId`）。
 * 接受 org id 入参的话，「知道别人的 org id 就能往他家里塞一家店」——
 * 而 org id 会出现在日志、支持工单、URL 里。
 *
 * ## 计费不在这里
 *
 * 这条命令**不碰 Stripe** —— 调外部 IO 会把一个数据库事务占住几秒
 * （同 blueprint/extract 躲开的坑）。它只建出 `billing_accounts` 的
 * 空壳，Stripe 那一步在 `POST /v1/billing/add-store` 里做。
 * 于是「建了店但 Stripe 挂了」的结果是**一家能用但没计费的店**，
 * 而不是「扣了钱但没店」—— 前者可以补，后者是投诉。
 */
registerHandler(CreateLocation, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof CreateLocation.input._type>) => {
  const userId = ctx.userId;
  if (!userId) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'requires_platform_account' },
    });
  }

  const [cur] = await tx<{ locale: string }[]>`
    select default_locale as locale from organizations where id = ${ctx.orgId}`;
  const locale = input.locale ?? cur?.locale ?? 'en';

  /*
   * slug 和建第一家店时同一套：可读的前缀 + 六位随机。
   *
   * ⚠️ 随机后缀不能省。两家「Lotus Spa」是这行的常态（同一个老板
   * 在两条街上各开一家，名字一模一样），纯按名字生成必然撞。
   */
  const slug = shopSlugFromName(input.name, randomUUID().replace(/-/g, '').slice(0, 6));

  const [loc] = await tx<{ id: string }[]>`
    insert into locations (org_id, name, slug, timezone, business_type, status, settings)
    values (${ctx.orgId}, ${jsonb({ en: input.name })}::jsonb, ${slug},
            ${input.timezone}, ${input.businessType}, 'setup', '{}'::jsonb)
    returning id`;
  const locationId = loc!.id;

  // 角色预设。事实源是 ROLE_PRESETS，和认领第一家店走同一条路 ——
  // 抄第二遍就会有一天两边不一致，而不一致的那一半是权限
  const roleIds: Record<string, string> = {};
  for (const [key, perms] of Object.entries(ROLE_PRESETS)) {
    const [r] = await tx<{ id: string }[]>`
      insert into roles (org_id, location_id, key, name, is_preset)
      values (${ctx.orgId}, ${locationId}, ${key}, ${jsonb({ en: key })}::jsonb, true)
      returning id`;
    roleIds[key] = r!.id;
    for (const p of perms) {
      await tx`insert into role_permissions (role_id, permission) values (${r!.id}, ${p})`;
    }
  }

  const [m] = await tx<{ id: string }[]>`
    insert into memberships (org_id, location_id, user_id, status)
    values (${ctx.orgId}, ${locationId}, ${userId}, 'active')
    returning id`;
  await tx`insert into membership_roles (membership_id, role_id)
           values (${m!.id}, ${roleIds['owner']!})`;

  // 老板的 staff_profile：`is_bookable = false`，理由同认领那一处 ——
  // 默认打开的话他一进来轮牌板上就多了一个不该在的人
  const [u] = await tx<{ full_name: string | null; email: string | null }[]>`
    select full_name, email from users where id = ${userId}`;
  const displayName = u?.full_name?.trim() || (u?.email ?? 'owner').split('@')[0]!;
  await tx`
    insert into staff_profiles
      (membership_id, org_id, location_id, display_name, is_bookable, max_concurrent_appointments)
    values (${m!.id}, ${ctx.orgId}, ${locationId}, ${jsonb({ en: displayName })}::jsonb, false, 1)`;

  /*
   * 计费壳子。
   *
   * ⭐ **沿用同一个 Stripe 客户** —— 一个老板一张卡一张账单。
   * 每家店各建一个 customer 的话，他会收到三封独立的账单、
   * 换卡要换三次，而 Stripe 后台上看不出这三家是一个人的。
   *
   * subscription id 先留空：这一刻还没往订阅上加 item。
   * 补上它是 `/v1/billing/add-store` 的事。
   */
  const [sibling] = await tx<{ cust: string | null }[]>`
    select stripe_customer_id as cust from billing_accounts
    where org_id = ${ctx.orgId} and stripe_customer_id is not null limit 1`;
  await tx`
    insert into billing_accounts (org_id, location_id, stripe_customer_id, subscription_status)
    values (${ctx.orgId}, ${locationId}, ${sibling?.cust ?? null}, 'trialing')
    on conflict (location_id) do nothing`;

  audit({
    entityType: 'location', entityId: locationId,
    after: {
      name: input.name, slug, timezone: input.timezone,
      businessType: input.businessType, createdBy: userId, membershipId: m!.id,
    },
  });

  return { locationId, orgId: ctx.orgId, membershipId: m!.id, slug };
});

// ───────────────────────────────────────────── 收银偏好与小费税率配置
registerHandler(SaveCheckoutSettings, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveCheckoutSettings.input._type>) => {
  const taxRate = input.salesTaxRatePercent !== undefined ? input.salesTaxRatePercent : 0;
  const taxMode = input.taxCalculationMode ?? 'exclusive';
  const tips = input.suggestedTipPercentages ?? [15, 18, 20, 25];
  const allowCustom = input.allowCustomTip !== undefined ? input.allowCustomTip : true;
  const cashFloat = input.defaultCashFloatCents !== undefined ? input.defaultCashFloatCents : 20000;
  const footer = input.receiptFooterMessage ?? null;
  const autoPrint = input.autoPrintReceipt !== undefined ? input.autoPrintReceipt : true;
  const autoSms = input.autoSendSmsReceipt !== undefined ? input.autoSendSmsReceipt : true;
  const checkoutTiming = input.checkoutTiming ?? 'after_service_combined';
  const packageCoverageMode = input.packageCoverageMode ?? 'bundle';
  const packageCommissionBasis = input.packageCommissionBasis ?? 'allocated_sale_price';
  const allowTipSplitOverride = input.allowTipSplitOverride ?? true;
  const tipDistributionBasis = input.tipDistributionBasis ?? 'active_minutes';
  const assistantTipWeightPercent = input.assistantTipWeightPercent ?? 30;
  const tipRemainderTo = input.tipRemainderTo ?? 'longest_service';

  await tx`
    insert into location_checkout_settings (
      location_id, sales_tax_rate_percent, tax_calculation_mode,
      suggested_tip_percentages, allow_custom_tip, default_cash_float_cents,
      receipt_footer_message, auto_print_receipt, auto_send_sms_receipt, checkout_timing, updated_at
    ) values (
      ${ctx.locationId}, ${taxRate}, ${taxMode},
      ${tips}, ${allowCustom}, ${cashFloat},
      ${footer}, ${autoPrint}, ${autoSms}, ${checkoutTiming}, now()
    )
    on conflict (location_id) do update set
      sales_tax_rate_percent = excluded.sales_tax_rate_percent,
      tax_calculation_mode = excluded.tax_calculation_mode,
      suggested_tip_percentages = excluded.suggested_tip_percentages,
      allow_custom_tip = excluded.allow_custom_tip,
      default_cash_float_cents = excluded.default_cash_float_cents,
      receipt_footer_message = excluded.receipt_footer_message,
      auto_print_receipt = excluded.auto_print_receipt,
      auto_send_sms_receipt = excluded.auto_send_sms_receipt,
      checkout_timing = excluded.checkout_timing,
      updated_at = now()`;

  // 也冗余到 locations.settings['checkout'] 方便轻量读取
  const checkoutPayload = {
    salesTaxRatePercent: taxRate,
    taxCalculationMode: taxMode,
    suggestedTipPercentages: tips,
    allowCustomTip: allowCustom,
    defaultCashFloatCents: cashFloat,
    receiptFooterMessage: footer,
    autoPrintReceipt: autoPrint,
    autoSendSmsReceipt: autoSms,
    checkoutTiming,
    packageCoverageMode,
    packageCommissionBasis,
    allowTipSplitOverride,
  };

  // 小费规则单独版本化；历史工单继续引用结账当时的 policy_version。
  const [currentTip] = await tx<{ version: number; config: Record<string, unknown> }[]>`
    select version, config from tip_policies
    where location_id = ${ctx.locationId}
    order by effective_from desc, version desc limit 1`;
  const currentConfig = currentTip?.config ?? {};
  const tipConfig = {
    ...currentConfig,
    basis: tipDistributionBasis,
    role_weights_bp: { primary: 10000, assistant: assistantTipWeightPercent * 100 },
    remainder_to: tipRemainderTo,
    house_cut_bp: 0,
  };
  const tipChanged = JSON.stringify(currentConfig) !== JSON.stringify(tipConfig);
  if (tipChanged) {
    await tx`insert into tip_policies (org_id, location_id, version, config, effective_from)
      values (${ctx.orgId}, ${ctx.locationId}, ${(currentTip?.version ?? 0) + 1},
              ${jsonb(tipConfig)}::jsonb, now())`;
  }

  await tx`update locations set
      settings = jsonb_set(settings, '{checkout}', ${jsonb(checkoutPayload)}::jsonb, true),
      updated_at = now()
    where id = ${ctx.locationId}`;

  audit({
    entityType: 'location_checkout_settings', entityId: ctx.locationId,
    after: { ...checkoutPayload, tipPolicy: tipConfig },
  });

  return { locationId: ctx.locationId };
});

// ───────────────────────────────────────────── 10DLC 内部审核申请
// 只把资料落在本店。不调用 Telnyx / TCR / 运营商。pending_review = GenieFront 内部待审。
registerHandler(Apply10Dlc, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof Apply10Dlc.input._type>) => {
  const messages = input.sampleMessages && input.sampleMessages.length > 0
    ? input.sampleMessages
    : [input.sampleMessage1, input.sampleMessage2].filter(Boolean) as string[];
  const submittedByMembershipId = ctx.membershipId;

  const [row] = await tx<{ submitted_at: string }[]>`
    insert into location_10dlc_registrations (
      location_id, status, legal_business_name, ein, business_structure,
      registered_address, rep_name, rep_title, rep_email, rep_phone,
      opt_in_method, sample_message_1, sample_message_2, sample_messages,
      submitted_at, submitted_by_membership_id, updated_at
    ) values (
      ${ctx.locationId}, 'pending_review', ${input.legalBusinessName}, ${input.ein},
      ${input.businessStructure}, ${input.registeredAddress}, ${input.repName},
      ${input.repTitle}, ${input.repEmail}, ${input.repPhone},
      ${input.optInMethod ?? null}, ${input.sampleMessage1 ?? messages[0] ?? null},
      ${input.sampleMessage2 ?? messages[1] ?? null}, ${messages},
      now(), ${submittedByMembershipId}, now()
    )
    on conflict (location_id) do update set
      status = 'pending_review',
      legal_business_name = excluded.legal_business_name,
      ein = excluded.ein,
      business_structure = excluded.business_structure,
      registered_address = excluded.registered_address,
      rep_name = excluded.rep_name,
      rep_title = excluded.rep_title,
      rep_email = excluded.rep_email,
      rep_phone = excluded.rep_phone,
      opt_in_method = excluded.opt_in_method,
      sample_message_1 = excluded.sample_message_1,
      sample_message_2 = excluded.sample_message_2,
      sample_messages = excluded.sample_messages,
      submitted_at = now(),
      submitted_by_membership_id = excluded.submitted_by_membership_id,
      updated_at = now()
    returning submitted_at::text`;

  audit({
    entityType: 'location_10dlc', entityId: ctx.locationId,
    after: {
      status: 'pending_review',
      reviewKind: 'internal_geniefront',
      ein: input.ein,
      legalBusinessName: input.legalBusinessName,
      submittedByMembershipId,
    },
  });

  return {
    locationId: ctx.locationId,
    status: 'pending_review' as const,
    submittedAt: row?.submitted_at ?? new Date().toISOString(),
  };
});

// ───────────────────────────────────────────── 大堂 iPad 免责声明模板
registerHandler(SaveIntakeWaiver, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveIntakeWaiver.input._type>) => {
  await tx`
    insert into location_intake_templates (
      location_id, waiver_title, waiver_content, require_signature,
      require_health_allergies, require_pressure_preference, auto_sync_to_profile,
      updated_at, require_body_soreness_map, auto_create_crm_profile,
      auto_prompt_tip_percentages
    ) values (
      ${ctx.locationId}, ${input.waiverTitle}, ${input.waiverContent ?? null},
      ${input.requireSignature}, ${input.requireHealthAllergies},
      ${input.requirePressurePreference}, ${input.autoSyncToProfile}, now(),
      ${input.requireBodySorenessMap}, ${input.autoCreateCrmProfile},
      ${input.autoPromptTipPercentages}
    )
    on conflict (location_id) do update set
      waiver_title = excluded.waiver_title,
      waiver_content = excluded.waiver_content,
      require_signature = excluded.require_signature,
      require_health_allergies = excluded.require_health_allergies,
      require_pressure_preference = excluded.require_pressure_preference,
      auto_sync_to_profile = excluded.auto_sync_to_profile,
      require_body_soreness_map = excluded.require_body_soreness_map,
      auto_create_crm_profile = excluded.auto_create_crm_profile,
      auto_prompt_tip_percentages = excluded.auto_prompt_tip_percentages,
      updated_at = now()`;

  audit({
    entityType: 'location_intake_template', entityId: ctx.locationId,
    after: input,
  });

  return { locationId: ctx.locationId };
});

// ───────────────────────────────────────────── Webhook 回调配置
registerHandler(SaveWebhooks, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveWebhooks.input._type>) => {
  const [row] = await tx<{ id: string }[]>`
    insert into location_webhooks (
      location_id, url, events, secret, active, updated_at
    ) values (
      ${ctx.locationId}, ${input.url}, ${input.events},
      ${input.secret ?? null}, ${input.active}, now()
    )
    returning id`;

  audit({
    entityType: 'location_webhook', entityId: row!.id,
    after: { url: input.url, events: input.events, active: input.active },
  });

  return { locationId: ctx.locationId, webhookId: row!.id };
});

// ─────────────────────────────────────────────────────── 店主邮件语言

/**
 * `org.setEmailLocale` —— 改 `organizations.default_locale`。
 *
 * ⚠️ 该列是**店主计费类邮件语言**的唯一事实源（`email/locale.ts`），
 * 与 `users.locale`（界面语言，按人存）是两件事，禁止合并。
 *
 * ⚠️ 顾客侧邮件与短信恒为英语，不受本设置影响。
 */
registerHandler(SetEmailLocale, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetEmailLocale.input._type>) => {
  const [before] = await tx<{ locale: string | null }[]>`
    select default_locale as locale from organizations where id = ${ctx.orgId}`;

  await tx`
    update organizations set default_locale = ${input.locale} where id = ${ctx.orgId}`;

  audit({
    entityType: 'organization', entityId: ctx.orgId,
    before: { emailLocale: before?.locale ?? null },
    after: { emailLocale: input.locale },
  });

  return { locale: input.locale };
});

registerHandler(SavePublicBookingProfile, async ({input,ctx,tx,audit}) => {
  const types=[...new Set(Object.values(input.services).map(s=>s.resourceTypeId).filter((id):id is string=>!!id))];
  if(types.length){const owned=await tx`select id from resource_types where location_id=${ctx.locationId} and id=any(${types})`;
    if(owned.length!==types.length)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'resource_type'}});}
  const ids=Object.keys(input.services);
  if(ids.length){
    const owned=await tx`select id from services where location_id=${ctx.locationId} and id=any(${ids})`;
    if(owned.length!==ids.length) throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'service'}});
  }
  await tx`update locations set settings=jsonb_set(settings,'{public_booking_profile}',${jsonb(input)}::jsonb,true),updated_at=now()
    where id=${ctx.locationId}`;
  audit({entityType:'location',entityId:ctx.locationId,after:{publicBookingProfile:input}});
  return {locationId:ctx.locationId};
});
