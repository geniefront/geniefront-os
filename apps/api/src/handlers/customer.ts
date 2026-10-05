import {customerAssetIds} from '../customerIdentity';
import {
  customerSaveProfile, customerSavePreferences, customerSetBlocked, customerMerge, customerSendSms,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler } from '../bus';
import { enqueueDirectSms } from '../sms/direct';
import { flushSms } from '../sms/flush';

// ─────────────────────────────────────────────────────────── customer.saveProfile

registerHandler(customerSaveProfile, async ({ input, ctx, tx, audit }) => {
  if (input.customerId) {
    const [existing] = await tx<{ id: string; org_id: string; version: string }[]>`
      select id, org_id, xmin::text as version from customers
      where id = ${input.customerId} and org_id = ${ctx.orgId} for update`;
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'customer', id: input.customerId },
      });
    }

    if (input.expectedVersion && input.expectedVersion !== existing.version) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'customer_changed_reload' } });
    }

    const [before] = await tx<Record<string, unknown>[]>`
      select display_name, first_name, last_name, phone_e164, email,
             vip_level, birthday, tags, gender, notes
      from customers where id = ${input.customerId}`;

    const [updated] = await tx<{ id: string }[]>`
      update customers set
        display_name = ${input.name},
        first_name = case when ${input.firstName !== undefined} then ${input.firstName ?? null} else first_name end,
        last_name = case when ${input.lastName !== undefined} then ${input.lastName ?? null} else last_name end,
        phone_e164 = case when ${input.phoneE164 !== undefined} then ${input.phoneE164 ?? null} else phone_e164 end,
        email = case when ${input.email !== undefined} then ${input.email || null} else email end,
        vip_level = case when ${input.vipLevel !== undefined} then ${input.vipLevel ?? 0} else vip_level end,
        birthday = case when ${input.birthday !== undefined} then ${input.birthday ?? null}::date else birthday end,
        tags = case when ${input.tags !== undefined} then ${input.tags ?? []}::text[] else tags end,
        gender = case when ${input.gender !== undefined} then ${input.gender ?? null} else gender end,
        notes = case when ${input.notes !== undefined} then ${input.notes ?? null} else notes end,
        source = case when ${input.source !== undefined} then ${input.source ?? 'desk'} else source end
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
      ${input.vipLevel ?? 0}, ${input.birthday ?? null}, ${input.tags ?? []}::text[],
      ${input.gender ?? null}, ${input.notes ?? null}, ${input.source ?? 'desk'}
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

  // Serialize merges in one organization and lock both roots before moving ownership.
  await tx`select pg_advisory_xact_lock(hashtext(${ctx.orgId}), hashtext('customer.merge'))`;
  await tx`select id from customers where org_id = ${ctx.orgId}
    and id = any(${[input.sourceCustomerId, input.targetCustomerId]}) order by id for update`;
  const [target] = await tx<{ id: string; tags: string[] | null; no_show_count: number; late_cancel_count: number; merged_into_id: string | null }[]>`
    select id, tags, no_show_count, late_cancel_count, merged_into_id from customers
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

  if (target.merged_into_id) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'target_customer_already_merged' } });
  }

  if (source.merged_into_id) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'source_customer_already_merged', mergedIntoId: source.merged_into_id },
    });
  }

  // Keep original bookings, closed tickets, asset ownership and signed form identities.
  // Their read/write paths resolve this explicitly approved alias family instead.
  const [history]=await tx<{appointments:number;tickets:number}[]>`select
   (select count(*)::int from appointments where customer_id in ${customerAssetIds(tx,input.sourceCustomerId)} and org_id=${ctx.orgId}) as appointments,
   (select count(*)::int from tickets where customer_id in ${customerAssetIds(tx,input.sourceCustomerId)} and org_id=${ctx.orgId}) as tickets`;

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
    where id = ${input.sourceCustomerId} or merged_into_id = ${input.sourceCustomerId}`;

  const mergedCount = history!.appointments+history!.tickets;

  audit({
    entityType: 'customer',
    entityId: input.targetCustomerId,
    before: { targetCustomerId: input.targetCustomerId, sourceCustomerId: input.sourceCustomerId },
    after: { merged: true, mergedCount, mergedTags,ownershipMode:'aliases_preserve_original_records' },
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

  /*
   * ⚠️ 入队一律走 `enqueueDirectSms`。
   *
   * 此前本处自行实现，与 `sms.sendDirect` 存在三项不一致，且三项均有确定
   * 后果：发件号取门店座机（未在 10DLC 注册）、不检查退订、分段计数用
   * `Math.ceil(len/160)`（对 UCS-2 内容低估一倍以上，而计费按段记录）。
   * 详见 `sms/direct.ts` 文件头。
   */
  const res = await enqueueDirectSms(tx, {
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    toE164: cust.phone_e164,
    body: input.body,
    entityType: 'customer',
    entityId: cust.id,
  });

  audit({
    entityType: 'customer_sms',
    entityId: cust.id,
    after: {
      outboxId: res.outboxId,
      phone: cust.phone_e164,
      bodyPreview: res.body.slice(0, 50),
      segments: res.segments,
      status: res.status,
    },
  });

  emit({ type: 'sms.sent', entityId: cust.id });

  if (res.status === 'pending') {
    void flushSms({
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      membershipId: ctx.membershipId,
    });
  }

  return {
    outboxId: res.outboxId,
    customerId: cust.id,
    phone: cust.phone_e164,
    segments: res.segments,
    status: res.status,
  };
});

