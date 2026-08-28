import {
  customerSaveProfile, customerSavePreferences, customerSetBlocked, customerMerge, customerSendSms,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler } from '../bus';

// ─────────────────────────────────────────────────────────── customer.saveProfile

registerHandler(customerSaveProfile, async ({ input, ctx, tx, audit }) => {
  if (input.customerId) {
    const [existing] = await tx<{ id: string; org_id: string }[]>`
      select id, org_id from customers
      where id = ${input.customerId} and org_id = ${ctx.orgId}`;
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'customer', id: input.customerId },
      });
    }

    const [before] = await tx<Record<string, unknown>[]>`
      select display_name, first_name, last_name, phone_e164, email,
             vip_level, birthday, tags, gender, notes
      from customers where id = ${input.customerId}`;

    const [updated] = await tx<{ id: string }[]>`
      update customers set
        display_name = ${input.name},
        first_name = ${input.firstName ?? null},
        last_name = ${input.lastName ?? null},
        phone_e164 = ${input.phoneE164 ?? null},
        email = ${input.email || null},
        vip_level = ${input.vipLevel},
        birthday = ${input.birthday ?? null},
        tags = ${input.tags}::text[],
        gender = ${input.gender ?? null},
        notes = ${input.notes ?? null},
        source = ${input.source}
      where id = ${input.customerId}
      returning id`;

    const [after] = await tx<Record<string, unknown>[]>`
      select display_name, first_name, last_name, phone_e164, email,
             vip_level, birthday, tags, gender, notes
      from customers where id = ${input.customerId}`;

    audit({
      entityType: 'customer',
      entityId: updated!.id,
      before: before ?? {},
      after: after ?? {},
    });

    return { customerId: updated!.id, created: false };
  }

  // 新建客户档案
  const [created] = await tx<{ id: string }[]>`
    insert into customers (
      org_id, primary_location_id, display_name, first_name, last_name,
      phone_e164, email, vip_level, birthday, tags, gender, notes, source
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${input.name}, ${input.firstName ?? null},
      ${input.lastName ?? null}, ${input.phoneE164 ?? null}, ${input.email || null},
      ${input.vipLevel}, ${input.birthday ?? null}, ${input.tags}::text[],
      ${input.gender ?? null}, ${input.notes ?? null}, ${input.source}
    )
    returning id`;

  const [after] = await tx<Record<string, unknown>[]>`
    select display_name, first_name, last_name, phone_e164, email,
           vip_level, birthday, tags, gender, notes
    from customers where id = ${created!.id}`;

  audit({
    entityType: 'customer',
    entityId: created!.id,
    before: {},
    after: after ?? {},
  });

  return { customerId: created!.id, created: true };
});

// ─────────────────────────────────────────────────────────── customer.savePreferences

registerHandler(customerSavePreferences, async ({ input, ctx, tx, audit }) => {
  const [cust] = await tx<{ id: string }[]>`
    select id from customers where id = ${input.customerId} and org_id = ${ctx.orgId}`;
  if (!cust) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.customerId },
    });
  }

  const [before] = await tx<Record<string, unknown>[]>`
    select allergies, preferred_staff_ids, avoid_staff_ids, preferred_gender, free_notes, profile
    from customer_preferences where customer_id = ${input.customerId}`;

  await tx`
    insert into customer_preferences (
      customer_id, org_id, allergies, preferred_staff_ids, avoid_staff_ids,
      preferred_gender, free_notes, profile
    ) values (
      ${input.customerId}, ${ctx.orgId}, ${jsonb(input.allergies ?? {})}::jsonb,
      ${input.preferredStaffIds}::uuid[], ${input.avoidStaffIds}::uuid[],
      ${input.preferredGender ?? null}, ${input.freeNotes ?? null},
      ${jsonb(input.profile ?? {})}::jsonb
    )
    on conflict (customer_id) do update set
      allergies = excluded.allergies,
      preferred_staff_ids = excluded.preferred_staff_ids,
      avoid_staff_ids = excluded.avoid_staff_ids,
      preferred_gender = coalesce(excluded.preferred_gender, customer_preferences.preferred_gender),
      free_notes = excluded.free_notes,
      profile = excluded.profile`;

  const [after] = await tx<Record<string, unknown>[]>`
    select allergies, preferred_staff_ids, avoid_staff_ids, preferred_gender, free_notes, profile
    from customer_preferences where customer_id = ${input.customerId}`;

  audit({
    entityType: 'customer_preferences',
    entityId: input.customerId,
    before: before ?? {},
    after: after ?? {},
  });

  return { customerId: input.customerId, saved: true };
});

// ─────────────────────────────────────────────────────────── customer.setBlocked

registerHandler(customerSetBlocked, async ({ input, ctx, tx, audit }) => {
  const [cust] = await tx<{ id: string }[]>`
    select id from customers where id = ${input.customerId} and org_id = ${ctx.orgId}`;
  if (!cust) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.customerId },
    });
  }

  const [before] = await tx<Record<string, unknown>[]>`
    select blocked_at, blocked_reason from customers where id = ${input.customerId}`;

  if (input.blocked) {
    await tx`
      update customers set
        blocked_at = now(),
        blocked_reason = ${input.reason ?? null}
      where id = ${input.customerId}`;
  } else {
    await tx`
      update customers set
        blocked_at = null,
        blocked_reason = null
      where id = ${input.customerId}`;
  }

  const [after] = await tx<Record<string, unknown>[]>`
    select blocked_at, blocked_reason from customers where id = ${input.customerId}`;

  audit({
    entityType: 'customer',
    entityId: input.customerId,
    before: before ?? {},
    after: after ?? {},
  });

  return { customerId: input.customerId, blocked: input.blocked };
});

// ─────────────────────────────────────────────────────────── customer.merge

registerHandler(customerMerge, async ({ input, ctx, tx, audit }) => {
  if (input.targetCustomerId === input.sourceCustomerId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'cannot_merge_customer_into_self' },
    });
  }

  const [target] = await tx<{ id: string; tags: string[] | null; no_show_count: number; late_cancel_count: number }[]>`
    select id, tags, no_show_count, late_cancel_count from customers
    where id = ${input.targetCustomerId} and org_id = ${ctx.orgId}`;
  if (!target) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.targetCustomerId, role: 'target' },
    });
  }

  const [source] = await tx<{ id: string; tags: string[] | null; no_show_count: number; late_cancel_count: number; merged_into_id: string | null }[]>`
    select id, tags, no_show_count, late_cancel_count, merged_into_id from customers
    where id = ${input.sourceCustomerId} and org_id = ${ctx.orgId}`;
  if (!source) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.sourceCustomerId, role: 'source' },
    });
  }

  if (source.merged_into_id) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'source_customer_already_merged', mergedIntoId: source.merged_into_id },
    });
  }

  // 1. 迁移预约
  const appts = await tx<{ count: string }[]>`
    with updated as (
      update appointments
      set customer_id = ${input.targetCustomerId}
      where customer_id = ${input.sourceCustomerId} and org_id = ${ctx.orgId}
      returning id
    ) select count(*)::text as count from updated`;

  // 2. 迁移工单
  const tkts = await tx<{ count: string }[]>`
    with updated as (
      update tickets
      set customer_id = ${input.targetCustomerId}
      where customer_id = ${input.sourceCustomerId} and org_id = ${ctx.orgId}
      returning id
    ) select count(*)::text as count from updated`;

  // 3. 迁移礼品卡
  await tx`
    update gift_cards
    set purchaser_customer_id = case when purchaser_customer_id = ${input.sourceCustomerId} then ${input.targetCustomerId} else purchaser_customer_id end,
        holder_customer_id = case when holder_customer_id = ${input.sourceCustomerId} then ${input.targetCustomerId} else holder_customer_id end
    where (purchaser_customer_id = ${input.sourceCustomerId} or holder_customer_id = ${input.sourceCustomerId})
      and org_id = ${ctx.orgId}`;

  // 4. 迁移预付资产账本
  await tx`
    update customer_credit_ledger
    set customer_id = ${input.targetCustomerId}
    where customer_id = ${input.sourceCustomerId} and org_id = ${ctx.orgId}`;

  // 5. 迁移次卡套餐
  await tx`
    update customer_packages
    set customer_id = ${input.targetCustomerId}
    where customer_id = ${input.sourceCustomerId} and org_id = ${ctx.orgId}`;

  // 6. 迁移问卷提交
  await tx`
    update form_submissions
    set customer_id = ${input.targetCustomerId}
    where customer_id = ${input.sourceCustomerId} and org_id = ${ctx.orgId}`;

  // 6.5 合并客户偏好（allergies, freeNotes, preferred/avoid staff）
  const [sourcePref] = await tx<{
    allergies: Record<string, unknown> | null;
    preferred_staff_ids: string[] | null;
    avoid_staff_ids: string[] | null;
    preferred_gender: string | null;
    free_notes: string | null;
    profile: Record<string, unknown> | null;
  }[]>`
    select allergies, preferred_staff_ids, avoid_staff_ids, preferred_gender, free_notes, profile
    from customer_preferences where customer_id = ${input.sourceCustomerId}`;

  if (sourcePref) {
    const [targetPref] = await tx<{
      allergies: Record<string, unknown> | null;
      preferred_staff_ids: string[] | null;
      avoid_staff_ids: string[] | null;
      preferred_gender: string | null;
      free_notes: string | null;
      profile: Record<string, unknown> | null;
    }[]>`
      select allergies, preferred_staff_ids, avoid_staff_ids, preferred_gender, free_notes, profile
      from customer_preferences where customer_id = ${input.targetCustomerId}`;

    const mergedAllergies = { ...(sourcePref.allergies ?? {}), ...(targetPref?.allergies ?? {}) };
    const mergedPrefStaff = [...new Set([...(targetPref?.preferred_staff_ids ?? []), ...(sourcePref.preferred_staff_ids ?? [])])];
    const mergedAvoidStaff = [...new Set([...(targetPref?.avoid_staff_ids ?? []), ...(sourcePref.avoid_staff_ids ?? [])])];
    const mergedNotes = [targetPref?.free_notes, sourcePref.free_notes].filter(Boolean).join('\n');
    const mergedProfile = { ...(sourcePref.profile ?? {}), ...(targetPref?.profile ?? {}) };

    await tx`
      insert into customer_preferences (
        customer_id, org_id, allergies, preferred_staff_ids, avoid_staff_ids,
        preferred_gender, free_notes, profile
      ) values (
        ${input.targetCustomerId}, ${ctx.orgId}, ${jsonb(mergedAllergies)}::jsonb,
        ${mergedPrefStaff}::uuid[], ${mergedAvoidStaff}::uuid[],
        ${targetPref?.preferred_gender ?? sourcePref.preferred_gender ?? null},
        ${mergedNotes || null}, ${jsonb(mergedProfile)}::jsonb
      )
      on conflict (customer_id) do update set
        allergies = excluded.allergies,
        preferred_staff_ids = excluded.preferred_staff_ids,
        avoid_staff_ids = excluded.avoid_staff_ids,
        free_notes = excluded.free_notes,
        profile = excluded.profile`;
  }

  // 7. 合并标签和爽约计数
  const mergedTags = [...new Set([...(target.tags ?? []), ...(source.tags ?? [])])];
  const mergedNoShow = (target.no_show_count || 0) + (source.no_show_count || 0);
  const mergedLateCancel = (target.late_cancel_count || 0) + (source.late_cancel_count || 0);

  await tx`
    update customers set
      tags = ${mergedTags}::text[],
      no_show_count = ${mergedNoShow},
      late_cancel_count = ${mergedLateCancel}
    where id = ${input.targetCustomerId}`;

  // 8. 标记 source 为已合并
  await tx`
    update customers set
      merged_into_id = ${input.targetCustomerId}
    where id = ${input.sourceCustomerId}`;

  const mergedCount = Number(appts[0]?.count ?? 0) + Number(tkts[0]?.count ?? 0);

  audit({
    entityType: 'customer',
    entityId: input.targetCustomerId,
    before: { targetCustomerId: input.targetCustomerId, sourceCustomerId: input.sourceCustomerId },
    after: { merged: true, mergedCount, mergedTags },
  });

  return {
    targetCustomerId: input.targetCustomerId,
    sourceCustomerId: input.sourceCustomerId,
    mergedCount,
  };
});

// ─────────────────────────────────────────────────────────── customer.sendSms

registerHandler(customerSendSms, async ({ input, ctx, tx, audit, emit }) => {
  const [cust] = await tx<{ id: string; display_name: string; phone_e164: string | null }[]>`
    select id, display_name, phone_e164 from customers
    where id = ${input.customerId} and org_id = ${ctx.orgId}`;
  if (!cust) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.customerId },
    });
  }
  if (!cust.phone_e164) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'customer_has_no_phone', customerId: input.customerId },
    });
  }

  const [loc] = await tx<{ phone: string | null }[]>`
    select phone from locations where id = ${ctx.locationId}`;
  const fromPhone = loc?.phone || '+15550000000';

  const segments = Math.max(1, Math.ceil(input.body.length / 160));

  const [row] = await tx<{ id: string }[]>`
    insert into sms_outbox (
      org_id, location_id, kind, to_e164, from_e164, body, segments,
      entity_type, entity_id, status, attempts, created_at
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, 'direct_message', ${cust.phone_e164}, ${fromPhone},
      ${input.body}, ${segments}, 'customer', ${cust.id},
      'pending', 0, now()
    )
    returning id`;

  audit({
    entityType: 'customer_sms',
    entityId: cust.id,
    after: {
      outboxId: row!.id,
      phone: cust.phone_e164,
      bodyPreview: input.body.slice(0, 50),
      segments,
    },
  });

  emit({ type: 'sms.sent', entityId: cust.id });

  return {
    outboxId: row!.id,
    customerId: cust.id,
    phone: cust.phone_e164,
    segments,
    status: 'pending' as const,
  };
});

