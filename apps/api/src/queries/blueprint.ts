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

/**
 * `pickText` 用了哪个键。回退顺序必须和它**逐字一致** ——
 * 两处分开写迟早会漂，而漂出来的症状是「改了名字但界面没变」。
 */
function pickLocale(v: unknown, locale: string): string {
  const o = (v ?? {}) as Record<string, string>;
  for (const k of [locale, 'zh-Hans', 'en']) {
    if (typeof o[k] === 'string' && o[k] !== '') return k;
  }
  return Object.keys(o)[0] ?? locale;
}

export interface BlueprintItemView {
  itemId: string;
  /** 行号。对齐翻译结果用（05 §4.4）—— **不是数组下标** */
  seq: number;
  kind: string;
  name: Record<string, string>;
  /** 哪几个语言格是机器补的。界面上要用淡色显示，让老板一眼看出哪些还没人核过 */
  nameAuto: string[];
  /**
   * `displayName` 实际取自哪个语言键（05 §4.4）。
   *
   * ⚠️ 没有这个字段的话，确认页改名字时不知道该往哪一格写 ——
   * 原来的写法是 `{ 'zh-Hans': 新名字, en: 新名字 }` **两格一起盖**，
   * 有了真翻译之后，老板改一次英文名就会把补好的中文覆盖掉。
   */
  displayLocale: string;
  displayName: string;
  category: string | null;
  durationMin: number | null;
  staffCount: number | null;
  priceCents: number | null;
  priceIsFrom: boolean;
  variants: Array<{ label: string; priceCents: number; durationMin: number | null }>;
  packageSessions: number;
  packageServiceNames: string[];
  packageValidDays: number | null;
  confidenceBp: number;
  /** 服务端算好，前端不要自己拿阈值比 —— 阈值只该有一份 */
  lowConfidence: boolean;
  sourceSeq: number | null;
  bbox: [number, number, number, number] | null;
  decision: string;
  edited: boolean;
}

/**
 * running 状态活多久之后当它「进程重启把后台任务丢了」（sql/0094）。
 * 单张 Sonnet 5 / high ~30s，六张串行连缓存命中也就两三分钟；给到 5 分钟
 * 是留足余量，超过基本就是那个游离 Promise 没了。
 */
const EXTRACTION_STALE_MS = 5 * 60 * 1000;

export interface BlueprintView {
  blueprintId: string;
  status: string;
  label: string | null;
  extractedAt: string | null;
  appliedAt: string | null;
  /** 后台提取任务状态：idle | running | done | failed（sql/0094）。 */
  extractionStatus: 'idle' | 'running' | 'done' | 'failed';
  /** failed 时的原因；stale 的 running 会被折成 failed + 'timeout'。 */
  extractionError: string | null;
  unresolved: Array<{ field: string; question: string }>;
  locationProposal: Record<string, unknown>;
  sources: Array<{
    seq: number; kind: string; storagePath: string | null; sourceUrl: string | null;
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
    id: string; status: string; label: string | null; location_proposal: unknown;
    extracted_at: string | Date | null; applied_at: string | Date | null; unresolved: unknown;
    extraction_status: string; extraction_error: string | null;
    extraction_started_at: string | Date | null;
  }[]>`
    select id, status, label, extracted_at, applied_at, unresolved, location_proposal,
           extraction_status, extraction_error, extraction_started_at
    from shop_blueprints
    where id = ${blueprintId} and location_id = ${ctx.locationId}`;
  if (!bp) return null;

  // 进程在提取途中重启会把游离的后台任务丢掉，草案停在 running。
  // 读到 running 且开始时刻早于阈值，就当它 timeout —— 前端据此显示「重试」。
  let extractionStatus = bp.extraction_status as BlueprintView['extractionStatus'];
  let extractionError = bp.extraction_error;
  if (extractionStatus === 'running' && bp.extraction_started_at
      && Date.now() - parseTs(bp.extraction_started_at).getTime() > EXTRACTION_STALE_MS) {
    extractionStatus = 'failed';
    extractionError = 'timeout';
  }

  const sources = await tx<{
    seq: number; kind: string; storage_path: string | null; source_url: string | null;
    width_px: number | null; height_px: number | null;
  }[]>`
    select seq, kind, storage_path, source_url, width_px, height_px
    from blueprint_sources where blueprint_id = ${blueprintId} order by seq`;

  const rows = await tx<{
    id: string; kind: string; name: unknown; category: string | null;
    duration_min: number | null; staff_count: number | null;
    price_cents: number | null; price_is_from: boolean;
    seq: number; name_auto: unknown;
    variants: unknown; confidence_bp: number; source_seq: number | null;
    package_sessions: number; package_service_names: unknown; package_valid_days: number | null;
    bbox: unknown; decision: string; edited_at: Date | null;
  }[]>`
    select id, seq, kind, name, name_auto, category, duration_min, staff_count, price_cents,
           price_is_from, variants, package_sessions, package_service_names, package_valid_days,
           confidence_bp, source_seq, bbox, decision, edited_at
    from blueprint_items where blueprint_id = ${blueprintId} order by seq`;

  const items: BlueprintItemView[] = rows.map((r) => ({
    itemId: r.id,
    kind: r.kind,
    name: r.name as Record<string, string>,
    displayName: pickText(r.name, ctx.locale),
    category: r.category,
    durationMin: r.duration_min,
    staffCount: r.staff_count,
    priceCents: r.price_cents,
    priceIsFrom: r.price_is_from,
    variants: (r.variants as BlueprintItemView['variants']) ?? [],
    packageSessions: r.package_sessions,
    packageServiceNames: Array.isArray(r.package_service_names) ? r.package_service_names as string[] : [],
    packageValidDays: r.package_valid_days,
    confidenceBp: r.confidence_bp,
    lowConfidence: r.confidence_bp < LOW_CONFIDENCE_BP,
    seq: r.seq,
    nameAuto: Array.isArray(r.name_auto) ? (r.name_auto as string[]) : [],
    displayLocale: pickLocale(r.name, ctx.locale),
    sourceSeq: r.source_seq,
    bbox: (r.bbox as BlueprintItemView['bbox']) ?? null,
    decision: r.decision,
    edited: r.edited_at !== null,
  }));

  return {
    blueprintId: bp.id,
    status: bp.status,
    label: bp.label,
    extractionStatus,
    extractionError,
    // ⚠️ 走 parseTs 而不是直接 .toISOString()：vitest 把依赖放在 Node 原生 realm、
    // 测试代码放在 vite-node 的 VM realm，postgres.js 在那儿会把 timestamptz
    // 原样交回字符串。直接当 Date 用，测试里炸、生产里好 —— 最难查的那一类。
    extractedAt: bp.extracted_at ? parseTs(bp.extracted_at).toISOString() : null,
    appliedAt: bp.applied_at ? parseTs(bp.applied_at).toISOString() : null,
    unresolved: (bp.unresolved as BlueprintView['unresolved']) ?? [],
    locationProposal: (bp.location_proposal as Record<string, unknown>) ?? {},
    sources: sources.map((s) => ({
      seq: s.seq, kind: s.kind, storagePath: s.storage_path, sourceUrl: s.source_url,
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
