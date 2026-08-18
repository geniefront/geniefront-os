/**
 * 开店草案的只读视图 —— 确认页要的那一份。
 *
 * 一次给全：草案状态 + 每张照片的存储路径与尺寸 + 全部候选行。
 * 分成三个接口拉的话，确认页要等三个往返才能画出第一行 ——
 * 而老板刚拍完照片，正盯着屏幕等结果。
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';
import { parseTs } from '@gf/db';
import { LOW_CONFIDENCE_BP } from '@gf/ai';

export interface BlueprintItemView {
  itemId: string;
  /** 行号。对齐翻译结果用（05 §4.4）—— **不是数组下标** */
  seq: number;
  kind: string;
  name: Record<string, string>;
  /** 哪几个语言格是机器补的。界面上要用淡色显示，让老板一眼看出哪些还没人核过 */
  nameAuto: string[];
  displayName: string;
  category: string | null;
  durationMin: number | null;
  priceCents: number | null;
  priceIsFrom: boolean;
  variants: Array<{ label: string; priceCents: number; durationMin: number | null }>;
  confidenceBp: number;
  /** 服务端算好，前端不要自己拿阈值比 —— 阈值只该有一份 */
  lowConfidence: boolean;
  sourceSeq: number | null;
  bbox: [number, number, number, number] | null;
  decision: string;
  edited: boolean;
}

export interface BlueprintView {
  blueprintId: string;
  status: string;
  label: string | null;
  extractedAt: string | null;
  appliedAt: string | null;
  unresolved: Array<{ field: string; question: string }>;
  sources: Array<{
    seq: number; storagePath: string | null;
    widthPx: number | null; heightPx: number | null;
  }>;
  items: BlueprintItemView[];
  /** 确认页顶部那一行汇总。前端算会和服务端的口径漂开 */
  summary: {
    total: number; accepted: number; rejected: number;
    lowConfidence: number; services: number; notes: number;
  };
}

export async function loadBlueprint(
  tx: postgres.TransactionSql, ctx: CommandContext, blueprintId: string,
): Promise<BlueprintView | null> {
  const [bp] = await tx<{
    id: string; status: string; label: string | null;
    extracted_at: string | Date | null; applied_at: string | Date | null; unresolved: unknown;
  }[]>`
    select id, status, label, extracted_at, applied_at, unresolved
    from shop_blueprints
    where id = ${blueprintId} and location_id = ${ctx.locationId}`;
  if (!bp) return null;

  const sources = await tx<{
    seq: number; storage_path: string | null;
    width_px: number | null; height_px: number | null;
  }[]>`
    select seq, storage_path, width_px, height_px
    from blueprint_sources where blueprint_id = ${blueprintId} order by seq`;

  const rows = await tx<{
    id: string; kind: string; name: unknown; category: string | null;
    duration_min: number | null; price_cents: number | null; price_is_from: boolean;
    seq: number; name_auto: unknown;
    variants: unknown; confidence_bp: number; source_seq: number | null;
    bbox: unknown; decision: string; edited_at: Date | null;
  }[]>`
    select id, seq, kind, name, name_auto, category, duration_min, price_cents,
           price_is_from, variants, confidence_bp, source_seq, bbox, decision, edited_at
    from blueprint_items where blueprint_id = ${blueprintId} order by seq`;

  const items: BlueprintItemView[] = rows.map((r) => ({
    itemId: r.id,
    kind: r.kind,
    name: r.name as Record<string, string>,
    displayName: pickText(r.name, ctx.locale),
    category: r.category,
    durationMin: r.duration_min,
    priceCents: r.price_cents,
    priceIsFrom: r.price_is_from,
    variants: (r.variants as BlueprintItemView['variants']) ?? [],
    confidenceBp: r.confidence_bp,
    lowConfidence: r.confidence_bp < LOW_CONFIDENCE_BP,
    seq: r.seq,
    nameAuto: Array.isArray(r.name_auto) ? (r.name_auto as string[]) : [],
    sourceSeq: r.source_seq,
    bbox: (r.bbox as BlueprintItemView['bbox']) ?? null,
    decision: r.decision,
    edited: r.edited_at !== null,
  }));

  return {
    blueprintId: bp.id,
    status: bp.status,
    label: bp.label,
    // ⚠️ 走 parseTs 而不是直接 .toISOString()：vitest 把依赖放在 Node 原生 realm、
    // 测试代码放在 vite-node 的 VM realm，postgres.js 在那儿会把 timestamptz
    // 原样交回字符串。直接当 Date 用，测试里炸、生产里好 —— 最难查的那一类。
    extractedAt: bp.extracted_at ? parseTs(bp.extracted_at).toISOString() : null,
    appliedAt: bp.applied_at ? parseTs(bp.applied_at).toISOString() : null,
    unresolved: (bp.unresolved as BlueprintView['unresolved']) ?? [],
    sources: sources.map((s) => ({
      seq: s.seq, storagePath: s.storage_path,
      widthPx: s.width_px, heightPx: s.height_px,
    })),
    items,
    summary: {
      total: items.length,
      accepted: items.filter((i) => i.decision === 'accepted').length,
      rejected: items.filter((i) => i.decision === 'rejected').length,
      lowConfidence: items.filter((i) => i.lowConfidence).length,
      services: items.filter((i) => i.kind === 'service').length,
      notes: items.filter((i) => i.kind === 'note' || i.kind === 'price_modifier').length,
    },
  };
}

/** 开店配置页的「以前拍过的」列表。只给最近 20 份，草案不是要长期翻的东西。 */
export async function listBlueprints(
  tx: postgres.TransactionSql, ctx: CommandContext,
): Promise<Array<{
  blueprintId: string; status: string; label: string | null;
  createdAt: string; itemCount: number;
}>> {
  const rows = await tx<{
    id: string; status: string; label: string | null;
    created_at: string | Date; item_count: string;
  }[]>`
    select b.id, b.status, b.label, b.created_at,
           (select count(*) from blueprint_items i where i.blueprint_id = b.id) as item_count
    from shop_blueprints b
    where b.location_id = ${ctx.locationId}
    order by b.created_at desc
    limit 20`;

  return rows.map((r) => ({
    blueprintId: r.id,
    status: r.status,
    label: r.label,
    createdAt: parseTs(r.created_at).toISOString(),
    itemCount: Number(r.item_count),
  }));
}
