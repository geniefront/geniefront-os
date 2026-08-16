/**
 * AI 拍照开店的命令实现。
 *
 * 贯穿这一份的一条线：**草案是草案，项目是项目**。
 * 草案里怎么改都行、整份丢掉也行；一旦落地成 services，草案就封板，
 * 之后要改价格改的是项目那边。这条界线模糊掉的话，
 * 老板改完价格发现前台还在按老价开单，而两边都显示「已保存」。
 */

import {
  CreateBlueprintDraft, SaveBlueprintExtraction, ReviewBlueprintItem,
  ReviewAllBlueprintItems, ApplyBlueprint, DiscardBlueprint,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { toServiceDrafts, type DraftItem } from '@gf/ai';
import { registerHandler, type HandlerArgs } from '../bus';
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
  await tx`
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
            })}::jsonb)`;

  audit({
    entityType: 'blueprint', entityId: input.blueprintId,
    after: {
      itemCount: input.items.length,
      imagesOk: input.usage.imagesOk,
      imagesFailed: input.usage.imagesFailed,
    },
  });
  return { blueprintId: input.blueprintId, itemCount: input.items.length };
});

registerHandler(ReviewBlueprintItem, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ReviewBlueprintItem.input._type>) => {
  const [cur] = await tx<{
    id: string; blueprint_id: string; name: unknown;
    price_cents: number | null; duration_min: number | null; decision: string;
  }[]>`
    select id, blueprint_id, name, price_cents, duration_min, decision
    from blueprint_items
    where id = ${input.itemId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint_item' } });
  await loadDraft(tx, ctx.locationId, cur.blueprint_id);

  // 老板动过内容（不只是勾选）就打上 editedAt —— 之后它不再算 AI 的产物，
  // 落地时 source 标记不同（宪法第 6 条）。
  const edited = input.name !== undefined
    || input.priceCents !== undefined
    || input.durationMin !== undefined;

  await tx`
    update blueprint_items set
      decision = coalesce(${input.decision ?? null}, decision),
      name = coalesce(${input.name ? jsonb(input.name) : null}::jsonb, name),
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
    id: string; kind: string; name: unknown; duration_min: number | null;
    price_cents: number | null; price_is_from: boolean; variants: unknown;
    confidence_bp: number; source_seq: number | null; edited_at: Date | null;
  }[]>`
    select id, kind, name, duration_min, price_cents, price_is_from, variants,
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

  for (const r of buildable) {
    const item: DraftItem = {
      kind: r.kind as DraftItem['kind'],
      name: r.name as Record<string, string>,
      category: null,
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
          (org_id, location_id, name, duration_min, base_price_cents,
           taxable, online_bookable, active)
        values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(draft.name)}::jsonb,
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
