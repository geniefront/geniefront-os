/**
 * AI 拍照开店的命令实现。
 *
 * 贯穿这一份的一条线：**草案是草案，项目是项目**。
 * 草案里怎么改都行、整份丢掉也行；一旦落地成 services，草案就封板，
 * 之后要改价格改的是项目那边。这条界线模糊掉的话，
 * 老板改完价格发现前台还在按老价开单，而两边都显示「已保存」。
 */

import {
  CreateBlueprintDraft, SaveBlueprintExtraction, SaveBlueprintTranslations,
  ReviewBlueprintItem,
  ReviewAllBlueprintItems, ApplyBlueprint, DiscardBlueprint,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import {
  toServiceDrafts, mergeTranslations, clearAutoFlag,
  type DraftItem, type TranslatableItem,
} from '@gf/ai';
import { registerHandler, type HandlerArgs } from '../bus';
import { chargeQuota } from '../billing/usage';
import { creditsFor } from '@gf/payroll';
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
        (org_id, location_id, blueprint_id, seq, storage_path, width_px, height_px)
      values (${ctx.orgId}, ${ctx.locationId}, ${bp!.id}, ${s.seq},
              ${s.storagePath}, ${s.widthPx}, ${s.heightPx})`;
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
         duration_min, price_cents, price_is_from, variants,
         confidence_bp, source_seq, bbox)
      values (${ctx.orgId}, ${ctx.locationId}, ${input.blueprintId}, ${seq++},
              ${it.kind}, ${jsonb(it.name)}::jsonb, ${it.category},
              ${it.durationMin}, ${it.priceCents}, ${it.priceIsFrom},
              ${jsonb(it.variants)}::jsonb, ${it.confidenceBp}, ${it.sourceSeq},
              ${it.bbox === null ? null : jsonb(it.bbox)}::jsonb)`;
  }

  await tx`
    update shop_blueprints
    set extracted_at = now(), unresolved = ${jsonb(input.unresolved)}::jsonb
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
              feature: 'price_list_vision',
              model: 'claude-opus-5',
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
  // 拍照开店走 Opus，一张 ~$0.08 → 自然扣 8 积分。
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
    || input.durationMin !== undefined;

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

registerHandler(ApplyBlueprint, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ApplyBlueprint.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);

  const rows = await tx<{
    id: string; kind: string; name: unknown; category: string | null;
    duration_min: number | null;
    price_cents: number | null; price_is_from: boolean; variants: unknown;
    confidence_bp: number; source_seq: number | null; edited_at: Date | null;
  }[]>`
    select id, kind, name, category, duration_min, price_cents, price_is_from, variants,
           confidence_bp, source_seq, edited_at
    from blueprint_items
    where blueprint_id = ${input.blueprintId} and decision = 'accepted'
    order by seq`;

  // 说明文字和改价规则不建成项目 —— 它们本来就不是能开单的东西。
  // 一键勾选默认也不碰它们，这里再兜一次：老板可能手动勾了一行 note。
  const buildable = rows.filter((r) => r.kind === 'service' || r.kind === 'addon');
  const skipped = rows.length - buildable.length;

  if (buildable.length === 0) {
    throw new AppError(ERROR_CODES.BLUEPRINT_NOTHING_ACCEPTED, {
      details: { skipped },
    });
  }

  const createdServiceIds: string[] = [];

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
          (org_id, location_id, category_id, name, duration_min, base_price_cents,
           taxable, online_bookable, active)
        values (${ctx.orgId}, ${ctx.locationId}, ${categoryId},
                ${jsonb(draft.name)}::jsonb,
                ${draft.durationMin}, ${draft.basePriceCents},
                false, false, true)
        returning id`;
      createdServiceIds.push(svc!.id);

      // ⚠️ 顺序要紧：先写 items 再改草案状态。
      // sql/0014 的触发器禁止改非 draft 草案的行，反过来做的话
      // 这一句会被自己刚设的 applied 状态挡住。
      await tx`
        update blueprint_items set applied_service_id = ${svc!.id} where id = ${r.id}`;
    }
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
    },
  });
  return { blueprintId: input.blueprintId, createdServiceIds, skipped };
});

registerHandler(DiscardBlueprint, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof DiscardBlueprint.input._type>) => {
  await loadDraft(tx, ctx.locationId, input.blueprintId);
  await tx`update shop_blueprints set status = 'discarded' where id = ${input.blueprintId}`;

  audit({ entityType: 'blueprint', entityId: input.blueprintId, after: { status: 'discarded' } });
  return { blueprintId: input.blueprintId };
});
