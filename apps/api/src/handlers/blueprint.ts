/**
 * AI 拍照开店的命令实现。
 *
 * 贯穿这一份的一条线：**草案是草案，项目是项目**。
 * 草案里怎么改都行、整份丢掉也行；一旦落地成 services，草案就封板，
 * 之后要改价格改的是项目那边。这条界线模糊掉的话，
 * 老板改完价格发现前台还在按老价开单，而两边都显示「已保存」。
 */

import {
  CreateBlueprintDraft, SaveBlueprintExtraction, SetBlueprintExtractionState,
  SaveBlueprintTranslations,
  ReviewBlueprintItem,
  ReviewAllBlueprintItems, ReviewBlueprintItems, ApplyBlueprint, DiscardBlueprint,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import {
  toServiceDrafts, mergeTranslations, clearAutoFlag, nameKey,
  type DraftItem, type TranslatableItem,
} from '@gf/ai';
import { registerHandler, type HandlerArgs } from '../bus';
import { chargeQuota } from '../billing/usage';
import { creditsFor } from '@gf/payroll';
import { businessDateOf } from '@gf/scheduling';
import type postgres from 'postgres';

/**
 * 取一份草案并确认它还能改。
 *
 * sql/0014 的触发器是最终防线，但错误信息是 SQL 层的 `restrict_violation`，
 * 前台看到的会是「保存失败（INTERNAL）」。在这里先拦一次，
 * 是为了给出一句人能看懂的话。
 */
async function loadDraft(
  tx: postgres.TransactionSql, locationId: string, blueprintId: string,
  opts: { mustBeDraft?: boolean } = {},
) {
  const [bp] = await tx<{ id: string; status: string }[]>`
    select id, status from shop_blueprints
    where id = ${blueprintId} and location_id = ${locationId}`;
  if (!bp) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
  if (opts.mustBeDraft !== false && bp.status !== 'draft') {
    throw new AppError(ERROR_CODES.BLUEPRINT_FROZEN, { details: { status: bp.status } });
  }
  return bp;
}

registerHandler(CreateBlueprintDraft, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof CreateBlueprintDraft.input._type>) => {
  const [bp] = await tx<{ id: string }[]>`
    insert into shop_blueprints (org_id, location_id, label, created_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.label ?? null}, ${ctx.membershipId})
    returning id`;

  for (const s of input.sources) {
    await tx`
      insert into blueprint_sources
        (org_id, location_id, blueprint_id, seq, kind, storage_path, source_url,
         raw_snapshot, width_px, height_px)
      values (${ctx.orgId}, ${ctx.locationId}, ${bp!.id}, ${s.seq},
              ${s.kind}, ${s.storagePath}, ${s.sourceUrl ?? null},
              ${s.rawSnapshot ? jsonb(s.rawSnapshot) : null}::jsonb, ${s.widthPx}, ${s.heightPx})`;
  }

  audit({
    entityType: 'blueprint', entityId: bp!.id,
    after: { sources: input.sources.length, label: input.label ?? null },
  });
  return { blueprintId: bp!.id };
});

registerHandler(SaveBlueprintExtraction, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveBlueprintExtraction.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);

  // 重跑提取要把上一次的结果清掉，否则老板会看到两份重复的 38 行。
  // 草案行不是财务数据，删得（宪法第 9 条管的是钱和健康表）。
  await tx`delete from blueprint_items where blueprint_id = ${input.blueprintId}`;

  let seq = 0;
  for (const it of input.items) {
    await tx`
      insert into blueprint_items
        (org_id, location_id, blueprint_id, seq, kind, name, category,
         duration_min, staff_count, price_cents, price_is_from, variants,
         package_sessions, package_service_names, package_valid_days,
         confidence_bp, source_seq, bbox)
      values (${ctx.orgId}, ${ctx.locationId}, ${input.blueprintId}, ${seq++},
              ${it.kind}, ${jsonb(it.name)}::jsonb, ${it.category},
              ${it.durationMin}, ${it.staffCount ?? null}, ${it.priceCents}, ${it.priceIsFrom},
              ${jsonb(it.variants)}::jsonb, ${it.packageSessions},
              ${jsonb(it.packageServiceNames)}::jsonb, ${it.packageValidDays},
              ${it.confidenceBp}, ${it.sourceSeq},
              ${it.bbox === null ? null : jsonb(it.bbox)}::jsonb)`;
  }

  await tx`
    update shop_blueprints
    set extracted_at = now(), unresolved = ${jsonb(input.unresolved)}::jsonb,
        extraction_status = 'done', extraction_error = null,
        location_proposal = coalesce(${input.locationProposal ? jsonb(input.locationProposal) : null}::jsonb, location_proposal)
    where id = ${input.blueprintId}`;

  // ── 用量计量（05 §7.3）────────────────────────────────────────────────
  //
  // 在这里而不是在调模型的地方记：调模型那一步不在事务里，
  // 记在那儿的话「提取成功但落库回滚」会留下一条收了钱却没结果的账。
  //
  // cost_cents 存整数分（表结构如此），精确的毫分存进 meta ——
  // 一次提取两三分钱，四舍五入到分之后按月加总会漂出百分之几，
  // 而这是副驾额度包定价的计算基础（决策 8）。
  const [usageRow] = await tx<{ id: string }[]>`
    insert into usage_events (org_id, location_id, kind, qty, cost_cents, meta)
    values (${ctx.orgId}, ${ctx.locationId}, 'ai_assist',
            ${input.usage.tokens},
            ${Math.round(input.usage.costMillicents / 1000)},
            ${jsonb({
              feature: input.usage.feature ?? 'price_list_vision',
              model: input.usage.model ?? 'claude-opus-5',
              costMillicents: input.usage.costMillicents,
              imagesOk: input.usage.imagesOk,
              imagesFailed: input.usage.imagesFailed,
              blueprintId: input.blueprintId,
            })}::jsonb)
    returning id`;

  // ── 扣余额（Phase 2 计费接线）──────────────────────────────────────────
  //
  // 和上面那条 usage_events **在同一个事务里**：分开的话中间挂掉就会留下
  // 「用量记了但没扣钱」或者反过来，而两种漂移都要到月底对账才发现。
  // 传的是**毫分**不是分（差 10 倍的那个坑，见 billing/usage.ts）。
  // 拍照开店走 Sonnet 5 / effort high，一张 ~$0.05 → 自然扣 5 积分。
  // 用和副驾同一把尺子量，就不需要为它单独定一套规则（`@gf/payroll`）
  const credits = creditsFor(input.usage.costMillicents);
  const charge = await chargeQuota(tx, ctx, {
    unit: 'credit',
    amount: credits,
    usageEventId: usageRow!.id,
    source: 'price_list_vision',
  });

  audit({
    entityType: 'blueprint', entityId: input.blueprintId,
    after: {
      itemCount: input.items.length,
      imagesOk: input.usage.imagesOk,
      imagesFailed: input.usage.imagesFailed,
      credits,
      fromBalance: charge?.fromBalance ?? 0,
    },
  });
  return {
    blueprintId: input.blueprintId,
    itemCount: input.items.length,
    credits,
    fromIncluded: charge?.fromIncluded ?? 0,
    fromBalance: charge?.fromBalance ?? 0,
  };
});

/**
 * 后台提取任务的状态转移（sql/0094）。
 *
 * `running` 只该发生在草案还是 draft 时；`failed` 宽松一点 —— 提取跑的时候
 * 老板可能已经把草案丢了（discard），这时把状态写成 failed 没有意义也没有
 * 坏处，不必因为 `mustBeDraft` 抛错污染日志。`done` 不经过这里。
 */
registerHandler(SetBlueprintExtractionState, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetBlueprintExtractionState.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId, { mustBeDraft: input.state === 'running' });

  if (input.state === 'running') {
    await tx`
      update shop_blueprints
      set extraction_status = 'running', extraction_error = null,
          extraction_started_at = now()
      where id = ${input.blueprintId}`;
  } else {
    await tx`
      update shop_blueprints
      set extraction_status = 'failed', extraction_error = ${input.error ?? 'unknown'}
      where id = ${input.blueprintId}`;
  }

  audit({
    entityType: 'blueprint', entityId: input.blueprintId,
    after: { extractionStatus: input.state, extractionError: input.error ?? null },
  });
  return { blueprintId: input.blueprintId, state: input.state };
});

registerHandler(ReviewBlueprintItem, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ReviewBlueprintItem.input._type>) => {
  const [cur] = await tx<{
    id: string; blueprint_id: string; name: unknown; name_auto: unknown;
    price_cents: number | null; duration_min: number | null; decision: string;
  }[]>`
    select id, blueprint_id, name, name_auto, price_cents, duration_min, decision
    from blueprint_items
    where id = ${input.itemId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint_item' } });
  await loadDraft(tx, ctx.locationId, cur.blueprint_id);

  // 老板动过内容（不只是勾选）就打上 editedAt —— 之后它不再算 AI 的产物，
  // 落地时 source 标记不同（宪法第 6 条）。
  const edited = input.name !== undefined
    || input.priceCents !== undefined
    || input.durationMin !== undefined || input.staffCount !== undefined
    || input.category !== undefined
    || input.packageSessions !== undefined || input.packageServiceNames !== undefined
    || input.packageValidDays !== undefined;

  /**
   * ⭐ 老板**改动过**的语言格，从 `name_auto` 里去掉 —— 那一格不再是机器产物。
   *
   * 只清「值真的变了」的那几格，不是清掉提交上来的全部：
   * 确认页会把整个 i18n map 一起提交（包括他没动过的自动翻译），
   * 一律清掉的话，界面下一秒就不再把那些机器补的名字标成淡色，
   * 老板便无从分辨哪些还是机器猜的。
   */
  const curName = (cur.name ?? {}) as Record<string, string>;
  let nextAuto = Array.isArray(cur.name_auto) ? (cur.name_auto as string[]) : [];
  if (input.name) {
    for (const [locale, text] of Object.entries(input.name)) {
      if (text !== curName[locale]) nextAuto = clearAutoFlag(nextAuto, locale);
    }
  }

  await tx`
    update blueprint_items set
      decision = coalesce(${input.decision ?? null}, decision),
      name = coalesce(${input.name ? jsonb(input.name) : null}::jsonb, name),
      name_auto = ${input.name ? jsonb(nextAuto) : jsonb(nextAuto)}::jsonb,
      price_cents = ${input.priceCents === undefined ? tx`price_cents` : input.priceCents},
      duration_min = ${input.durationMin === undefined ? tx`duration_min` : input.durationMin},
      staff_count = ${input.staffCount === undefined ? tx`staff_count` : input.staffCount},
      category = ${input.category === undefined ? tx`category` : input.category},
      package_sessions = ${input.packageSessions === undefined ? tx`package_sessions` : input.packageSessions},
      package_service_names = ${input.packageServiceNames === undefined ? tx`package_service_names` : jsonb(input.packageServiceNames)}::jsonb,
      package_valid_days = ${input.packageValidDays === undefined ? tx`package_valid_days` : input.packageValidDays},
      edited_at = ${edited ? tx`now()` : tx`edited_at`}
    where id = ${input.itemId}`;

  // 宪法第 17 条只管 ticket / payment 的金额；项目定价是配置不是交易，
  // 老板要能查「这个价格是谁改的、什么时候改的」，所以照常留痕。
  audit({
    entityType: 'blueprint_item', entityId: input.itemId,
    before: {
      name: pickText(cur.name, ctx.locale),
      priceCents: cur.price_cents, durationMin: cur.duration_min,
      decision: cur.decision,
    },
    after: {
      name: input.name ? pickText(input.name, ctx.locale) : pickText(cur.name, ctx.locale),
      priceCents: input.priceCents === undefined ? cur.price_cents : input.priceCents,
      durationMin: input.durationMin === undefined ? cur.duration_min : input.durationMin,
      decision: input.decision ?? cur.decision,
    },
  });
  return { itemId: input.itemId };
});

/**
 * 把补齐的多语言写进草案（05 §4.4）。
 *
 * ⭐ **合并对着事务内的当前行做**，不是对着路由读到的那一份。
 * 路由调模型要几秒，这几秒里老板完全可能在确认页改了某一行的名字 ——
 * 拿旧快照合并会把他刚写的名字覆盖掉。`mergeTranslations` 的
 * 「已有的不覆盖」只有在读到最新数据时才成立。
 */
registerHandler(SaveBlueprintTranslations, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveBlueprintTranslations.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);

  const rows = await tx<{
    id: string; seq: number; name: unknown; name_auto: unknown; kind: string;
  }[]>`
    select id, seq, name, name_auto, kind from blueprint_items
    where blueprint_id = ${input.blueprintId} and location_id = ${ctx.locationId}
    order by seq`;

  const current: TranslatableItem[] = rows.map((r) => ({
    seq: r.seq,
    name: (r.name ?? {}) as Record<string, string>,
    nameAuto: Array.isArray(r.name_auto) ? (r.name_auto as string[]) : [],
    kind: r.kind,
  }));

  const merged = mergeTranslations(current, input.translations);

  // 计量照记：**钱已经花掉了**，哪怕整批因为 seq 对不上而作废。
  // 不记的话账本会和 Anthropic 的账单对不上，而那是查不出原因的那种对不上。
  const [usageRow] = await tx<{ id: string }[]>`
    insert into usage_events (org_id, location_id, kind, qty, cost_cents, meta)
    values (${ctx.orgId}, ${ctx.locationId}, 'ai_assist', ${input.usage.tokens},
            ${Math.round(input.usage.costMillicents / 1000)},
            ${jsonb({
              feature: 'name_translation',
              model: 'claude-sonnet-5',  // TRANSLATE_MODEL
              costMillicents: input.usage.costMillicents,
              blueprintId: input.blueprintId,
              filledCells: merged.filledCells,
              ...(merged.rejected ? { rejected: merged.rejected } : {}),
            })}::jsonb)
    returning id`;

  const credits = creditsFor(input.usage.costMillicents);
  await chargeQuota(tx, ctx, {
    unit: 'credit',
    amount: credits,
    usageEventId: usageRow!.id,
    source: 'ai_assist',
  });

  if (!merged.rejected) {
    const bySeq = new Map(merged.items.map((it) => [it.seq, it]));
    for (const r of rows) {
      const next = bySeq.get(r.seq);
      if (!next) continue;
      await tx`
        update blueprint_items
        set name = ${jsonb(next.name)}::jsonb, name_auto = ${jsonb(next.nameAuto)}::jsonb
        where id = ${r.id}`;
    }
  }

  audit({
    entityType: 'blueprint', entityId: input.blueprintId,
    after: {
      filledItems: merged.filledItems,
      filledCells: merged.filledCells,
      rejected: merged.rejected ?? null,
    },
  });

  return {
    blueprintId: input.blueprintId,
    filledItems: merged.filledItems,
    filledCells: merged.filledCells,
    rejected: merged.rejected ?? null,
    credits,
  };
});

registerHandler(ReviewAllBlueprintItems, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ReviewAllBlueprintItems.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);

  // 默认只动 service。说明文字（note）被一键建成项目的话，
  // 前台开单页面会多出一行「Prices subject to change」，谁看了都以为系统坏了。
  const kinds = input.kinds ?? ['service'];
  const minBp = input.minConfidenceBp ?? 0;

  const rows = await tx<{ id: string }[]>`
    update blueprint_items set decision = ${input.decision}
    where blueprint_id = ${input.blueprintId}
      and kind = any(${kinds}::text[])
      and confidence_bp >= ${minBp}
    returning id`;

  audit({
    entityType: 'blueprint', entityId: input.blueprintId,
    after: { decision: input.decision, minConfidenceBp: minBp, kinds, affected: rows.length },
  });
  return { blueprintId: input.blueprintId, affected: rows.length };
});

registerHandler(ReviewBlueprintItems, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ReviewBlueprintItems.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);
  let affected = 0;
  for (const item of input.items) {
    const rows = await tx`
      update blueprint_items set
        decision = ${item.decision},
        name = coalesce(${item.name ? jsonb(item.name) : null}::jsonb, name),
        duration_min = case when ${item.durationMin !== undefined} then ${item.durationMin ?? null} else duration_min end,
        staff_count = case when ${item.staffCount !== undefined} then ${item.staffCount ?? null} else staff_count end,
        price_cents = case when ${item.priceCents !== undefined} then ${item.priceCents ?? null} else price_cents end,
        category = case when ${item.category !== undefined} then ${item.category ?? null} else category end,
        package_sessions = case when ${item.packageSessions !== undefined} then ${item.packageSessions ?? 0} else package_sessions end,
        package_service_names = case when ${item.packageServiceNames !== undefined} then ${item.packageServiceNames ? jsonb(item.packageServiceNames) : jsonb([])}::jsonb else package_service_names end,
        package_valid_days = case when ${item.packageValidDays !== undefined} then ${item.packageValidDays ?? null} else package_valid_days end,
        edited_at = case when ${Boolean(item.name || item.durationMin !== undefined || item.staffCount !== undefined || item.priceCents !== undefined || item.category !== undefined || item.packageSessions !== undefined || item.packageServiceNames !== undefined || item.packageValidDays !== undefined)} then now() else edited_at end
      where id = ${item.itemId} and blueprint_id = ${input.blueprintId}
        and location_id = ${ctx.locationId}
      returning id`;
    affected += rows.length;
  }
  audit({ entityType: 'blueprint', entityId: input.blueprintId, after: { reviewed: affected } });
  return { blueprintId: input.blueprintId, affected };
});

registerHandler(ApplyBlueprint, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ApplyBlueprint.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);

  if (input.applyLocationProposal && !ctx.permissions.has('settings.manage')) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
  }
  if (input.staffProposalIndexes.length > 0 && !ctx.permissions.has('staff.manage')) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'staff.manage' } });
  }

  const rows = await tx<{
    id: string; kind: string; name: unknown; category: string | null;
    duration_min: number | null; staff_count: number | null;
    price_cents: number | null; price_is_from: boolean; variants: unknown;
    package_sessions: number; package_service_names: unknown; package_valid_days: number | null;
    confidence_bp: number; source_seq: number | null; edited_at: Date | null;
  }[]>`
    select id, kind, name, category, duration_min, staff_count, price_cents, price_is_from, variants,
           package_sessions, package_service_names, package_valid_days,
           confidence_bp, source_seq, edited_at
    from blueprint_items
    where blueprint_id = ${input.blueprintId} and decision = 'accepted'
    order by seq`;

  // 说明文字和改价规则不建成项目 —— 它们本来就不是能开单的东西。
  // 一键勾选默认也不碰它们，这里再兜一次：老板可能手动勾了一行 note。
  const buildable = rows.filter((r) => r.kind === 'service' || r.kind === 'addon');
  const packageRows = rows.filter((r) => r.kind === 'package');
  const skipped = rows.length - buildable.length - packageRows.length;

  if (buildable.length === 0 && packageRows.length === 0 && !input.allowNoServices) {
    throw new AppError(ERROR_CODES.BLUEPRINT_NOTHING_ACCEPTED, {
      details: { skipped },
    });
  }

  const createdServiceIds: string[] = [];
  const createdPackageIds: string[] = [];
  const createdStaffIds: string[] = [];

  const [blueprint] = await tx<{ location_proposal: unknown }[]>`
    select location_proposal from shop_blueprints
    where id = ${input.blueprintId} and location_id = ${ctx.locationId}`;
  const proposal = blueprint?.location_proposal && typeof blueprint.location_proposal === 'object'
    ? blueprint.location_proposal as Record<string, unknown>
    : {};
  const textValue = (key: string, max: number): string | null => {
    const value = proposal[key];
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  };
  let locationApplied = false;
  if (input.applyLocationProposal) {
    const name = textValue('name', 200);
    const phoneRaw = textValue('phone', 32);
    const phone = phoneRaw && /^\+\d{8,15}$/.test(phoneRaw) ? phoneRaw : null;
    const emailRaw = textValue('email', 320);
    const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null;
    const businessTypeRaw = textValue('businessType', 40);
    const businessType = businessTypeRaw && ['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed'].includes(businessTypeRaw)
      ? businessTypeRaw : null;
    const addressStreet = textValue('addressStreet', 200);
    const addressCity = textValue('addressCity', 120);
    const addressState = textValue('addressState', 40);
    const addressZip = textValue('addressZip', 20);
    const hoursRaw = proposal['businessHours'];
    const hours = hoursRaw && typeof hoursRaw === 'object'
      ? Object.fromEntries(Object.entries(hoursRaw as Record<string, unknown>).filter(([day, value]) => {
          if (!['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(day)) return false;
          if (value === null) return true;
          if (!value || typeof value !== 'object') return false;
          const row = value as Record<string, unknown>;
          return typeof row['open'] === 'string' && typeof row['close'] === 'string'
            && /^([01]\d|2[0-3]):[0-5]\d$/.test(row['open'])
            && /^([01]\d|2[0-3]):[0-5]\d$/.test(row['close']);
        }))
      : {};
    const hasLocationValues = Boolean(name || phone || email || businessType || addressStreet
      || addressCity || addressState || addressZip || Object.keys(hours).length > 0);
    if (hasLocationValues) {
      await tx`update locations set
        name = coalesce(${name ? jsonb({ [ctx.locale]: name }) : null}::jsonb, name),
        phone = coalesce(${phone}, phone), email = coalesce(${email}, email),
        address_street = coalesce(${addressStreet}, address_street),
        address_city = coalesce(${addressCity}, address_city),
        address_state = coalesce(${addressState}, address_state),
        address_zip = coalesce(${addressZip}, address_zip),
        business_type = coalesce(${businessType}, business_type),
        business_hours = case when ${Object.keys(hours).length > 0}
          then ${jsonb(hours)}::jsonb else business_hours end,
        settings = jsonb_set(settings, '{profile_confirmed_at}', to_jsonb(now()::text)),
        updated_at = now()
        where id = ${ctx.locationId}`;
      locationApplied = true;
    }
  }

  const staffRaw = Array.isArray(proposal['staff']) ? proposal['staff'] : [];
  const uniqueStaffIndexes = [...new Set(input.staffProposalIndexes)];
  if (uniqueStaffIndexes.length > 0) {
    const [techRole] = await tx<{ id: string }[]>`
      select id from roles where location_id = ${ctx.locationId} and key = 'tech' limit 1`;
    const [loc] = await tx<{ tz: string; cutoff: string }[]>`
      select timezone as tz, business_day_cutoff::text as cutoff from locations where id = ${ctx.locationId}`;
    const date = businessDateOf(new Date(), loc!.tz, loc!.cutoff);
    for (const index of uniqueStaffIndexes) {
      const raw = staffRaw[index];
      if (!raw || typeof raw !== 'object') continue;
      const staff = raw as Record<string, unknown>;
      const staffName = typeof staff['name'] === 'string' ? staff['name'].trim().slice(0, 100) : '';
      if (!staffName) continue;
      const role = typeof staff['role'] === 'string' ? staff['role'].trim().slice(0, 50) : null;
      const [membership] = await tx<{ id: string }[]>`
        insert into memberships (org_id, location_id, user_id, status)
        values (${ctx.orgId}, ${ctx.locationId}, null, 'active') returning id`;
      if (techRole) await tx`insert into membership_roles (membership_id, role_id)
        values (${membership!.id}, ${techRole.id}) on conflict do nothing`;
      await tx`insert into staff_profiles
        (membership_id, org_id, location_id, display_name, job_title, is_bookable, max_concurrent_appointments)
        values (${membership!.id}, ${ctx.orgId}, ${ctx.locationId},
          ${jsonb({ [ctx.locale]: staffName })}::jsonb, ${role}, true, 1)`;
      await tx`insert into rotation_participants
        (org_id, location_id, business_date, membership_id, in_rotation)
        values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${membership!.id}, true)
        on conflict (location_id, business_date, membership_id) do nothing`;
      createdStaffIds.push(membership!.id);
    }
  }

  /**
   * 价目表上的分类标题（「MANICURE」「足疗」）落成 `service_categories`。
   *
   * 之前这里写死 `category: null` —— 分类只在确认页显示，一落地就丢了。
   * 结果是开单页面上三十几个项目排成一长条，前台要滚半天才找到「Pedicure」。
   *
   * 三条规矩：
   *   · **同名复用**，不重复建。老板可能已经手工建过「Manicure」了，
   *     再建一个同名的，开单页面上会出现两个一模一样的分组
   *   · 分类名存在**和项目名同一个语言键**下。分类是从同一张价目表上读的，
   *     语言必然一致；存错键的话 pickText 会回退到别的语言，
   *     显示成一半中文一半英文
   *   · `sort` 按**在价目表上出现的先后**，不是字母序 ——
   *     老板认的是墙上那张表的顺序
   */
  const categoryIds = new Map<string, string>();
  const serviceIdsByName = new Map<string, string>();
  const existingServices = await tx<{ id: string; name: unknown }[]>`
    select id, name from services where location_id = ${ctx.locationId} and active = true`;
  for (const service of existingServices) {
    for (const text of Object.values((service.name ?? {}) as Record<string, string>)) {
      if (text) serviceIdsByName.set(nameKey(text), service.id);
    }
  }
  let categorySort = 0;

  async function ensureCategory(text: string, locale: string): Promise<string> {
    const hit = categoryIds.get(text);
    if (hit) return hit;

    const [found] = await tx<{ id: string }[]>`
      select id from service_categories
      where location_id = ${ctx.locationId} and name->>${locale} = ${text}
      limit 1`;
    if (found) {
      categoryIds.set(text, found.id);
      return found.id;
    }

    const [made] = await tx<{ id: string }[]>`
      insert into service_categories (org_id, location_id, name, sort)
      values (${ctx.orgId}, ${ctx.locationId},
              ${jsonb({ [locale]: text })}::jsonb, ${categorySort++})
      returning id`;
    categoryIds.set(text, made!.id);
    return made!.id;
  }

  for (const r of buildable) {
    const nameMap = r.name as Record<string, string>;
    const categoryId = r.category
      ? await ensureCategory(r.category, Object.keys(nameMap)[0] ?? 'en')
      : null;

    const item: DraftItem = {
      kind: r.kind as DraftItem['kind'],
      name: nameMap,
      category: r.category,
      durationMin: r.duration_min,
      staffCount: r.staff_count,
      priceCents: r.price_cents,
      priceIsFrom: r.price_is_from,
      variants: (r.variants as DraftItem['variants']) ?? [],
      confidenceBp: r.confidence_bp,
      sourceSeq: r.source_seq ?? 0,
      bbox: null,
    };

    for (const draft of toServiceDrafts(item, input.fallbackDurationMin)) {
      const [svc] = await tx<{ id: string }[]>`
        insert into services
          (org_id, location_id, category_id, name, duration_min, staff_count, base_price_cents,
           taxable, online_bookable, is_addon, active)
        values (${ctx.orgId}, ${ctx.locationId}, ${categoryId},
                ${jsonb(draft.name)}::jsonb,
                ${draft.durationMin},
                -- 确认页设过的技师人数透传；没设过按 1（与 services.staff_count 默认一致，U04）。
                ${draft.staffCount ?? 1},
                ${draft.basePriceCents},
                -- ⭐ 模型判断出来的「这是加项」（05 §5.3）一直到这里才有地方存。
                -- 丢掉它，电话 AI 就会把「热石 +$15」当成一个完整项目报给客人。
                -- 普通导入项默认「支持网上预约」，加项不进独立网约目录（U04 / §7.2）。
                false, ${r.kind !== 'addon'}, ${r.kind === 'addon'}, true)
        returning id`;
      createdServiceIds.push(svc!.id);
      for (const text of Object.values(draft.name)) serviceIdsByName.set(nameKey(text), svc!.id);

      // ⚠️ 顺序要紧：先写 items 再改草案状态。
      // sql/0014 的触发器禁止改非 draft 草案的行，反过来做的话
      // 这一句会被自己刚设的 applied 状态挡住。
      await tx`
        update blueprint_items set applied_service_id = ${svc!.id} where id = ${r.id}`;
    }
  }

  // 套餐最后落地：先让同一张价目表里的普通项目建好，再按原文名称绑定。
  for (const r of packageRows) {
    const requestedNames = Array.isArray(r.package_service_names)
      ? r.package_service_names.filter((name): name is string => typeof name === 'string') : [];
    const serviceIds = [...new Set(requestedNames
      .map((name) => serviceIdsByName.get(nameKey(name)))
      .filter((id): id is string => Boolean(id)))];
    const unmatchedServiceNames = requestedNames.filter((name) => !serviceIdsByName.has(nameKey(name)));
    if (unmatchedServiceNames.length > 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'blueprint_package_services_unmatched', unmatchedServiceNames },
      });
    }
    const [pkg] = await tx<{ id: string }[]>`
      insert into package_templates
        (org_id, location_id, name, price_cents, sessions, service_ids,
         valid_days, scope, online_sale, active, sort)
      values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(r.name)}::jsonb,
              ${r.price_cents ?? 0}, ${r.package_sessions}, ${serviceIds}::uuid[],
              ${r.package_valid_days}, 'location', false, true, 0)
      returning id`;
    createdPackageIds.push(pkg!.id);
  }

  await tx`
    update shop_blueprints set status = 'applied', applied_at = now()
    where id = ${input.blueprintId}`;

  audit({
    entityType: 'blueprint', entityId: input.blueprintId,
    after: {
      created: createdServiceIds.length,
      skipped,
      // 老板改过多少行 —— 这是「AI 提取到底准不准」唯一诚实的度量，
      // Phase 3 的自我改进（05 §9）要靠它
      editedByHuman: buildable.filter((r) => r.edited_at !== null).length,
      fallbackDurationMin: input.fallbackDurationMin,
      locationApplied,
      createdStaff: createdStaffIds.length,
    },
  });
  return { blueprintId: input.blueprintId, createdServiceIds, createdPackageIds, createdStaffIds, locationApplied, skipped };
});

registerHandler(DiscardBlueprint, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof DiscardBlueprint.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);
  await tx`update shop_blueprints set status = 'discarded' where id = ${input.blueprintId}`;

  audit({ entityType: 'blueprint', entityId: input.blueprintId, after: { status: 'discarded' } });
  return { blueprintId: input.blueprintId };
});
