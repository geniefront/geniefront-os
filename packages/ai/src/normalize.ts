/**
 * 提取结果的归一化、去重与合并 —— **纯函数，有测试**（宪法第 2 条的同一条纪律）。
 *
 * 模型那一侧不可复现，所以能确定的部分必须全部落在这一侧：
 * 什么算重复、冲突怎么表达、可疑价格怎么标记，都不能藏在 prompt 里靠模型自觉。
 *
 * 一家店常拍 3–6 张（手部一块牌、足部一块牌、加项一小张），
 * 边角必然重叠 —— 同一个项目在两张照片上各出现一次是常态，不是异常。
 */

import { CONFIDENCE_BP, LOW_CONFIDENCE_BP, type Extraction, type ItemKind } from './schema.js';

export interface DraftVariant {
  label: string;
  priceCents: number;
  durationMin: number | null;
}

/** 落库前的一行草案。字段与 `blueprint_items` 一一对应。 */
export interface DraftItem {
  kind: ItemKind;
  /** i18n。价目表是什么语言就存哪个 key，其余语言由 §4.4 的翻译步骤补 */
  name: Record<string, string>;
  category: string | null;
  durationMin: number | null;
  priceCents: number | null;
  priceIsFrom: boolean;
  variants: DraftVariant[];
  confidenceBp: number;
  sourceSeq: number;
  bbox: [number, number, number, number] | null;
}

export interface NormalizeOptions {
  /** 第几张照片。bbox 要靠它回到具体哪张图 */
  sourceSeq: number;
  /** 价目表印的是哪种语言。美国的店压倒性是英文，所以默认 en */
  locale?: string;
  /** 原图像素尺寸。用来把越界的 bbox 夹回图内 */
  widthPx?: number;
  heightPx?: number;
}

/**
 * 低于 $1 的价格几乎一定是模型把美元当成了分（45 → $0.45 而不是 $45）。
 *
 * **不自动乘 100 修正** —— 那是拿一个猜测覆盖另一个猜测。
 * 标成低置信度，确认页把 `$0.45` 标黄摆给老板看，他一眼就知道该改成多少。
 * 自动修正反而会把真正的 $0.50 加价项改成 $50。
 */
const SUSPICIOUS_PRICE_CENTS = 100;

/** 去重键：大小写、空白、标点都不算数。`Gel Manicure` 与 `GEL MANICURE.` 是同一个。 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // 去声调符：NFKD 之后 Sơn 与 Son 同键
    .replace(/[^\p{L}\p{N}]+/gu, ' ')    // 标点一律折成空格（\p{L} 覆盖中文与越南文）
    .trim();
}

function clampBox(
  b: { x1: number; y1: number; x2: number; y2: number },
  w?: number, h?: number,
): [number, number, number, number] | null {
  // 模型偶尔把两个角报反，交换比丢掉划算 —— 框还是对的
  let [x1, x2] = b.x1 <= b.x2 ? [b.x1, b.x2] : [b.x2, b.x1];
  let [y1, y2] = b.y1 <= b.y2 ? [b.y1, b.y2] : [b.y2, b.y1];

  x1 = Math.max(0, x1); y1 = Math.max(0, y1);
  if (w && w > 0) x2 = Math.min(w, x2);
  if (h && h > 0) y2 = Math.min(h, y2);

  // 退化成一条线或一个点的框点不中，不如没有 —— 有框却点不到比没框更让人困惑
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return [x1, y1, x2, y2];
}

/** 把一张照片的模型输出变成草案行。已经过 Zod，这里只做取值与标记。 */
export function normalizeExtraction(
  extraction: Extraction,
  opts: NormalizeOptions,
): DraftItem[] {
  const locale = opts.locale ?? 'en';

  return extraction.items.map((raw) => {
    const priceCents = raw.price_cents > 0 ? raw.price_cents : null;
    const durationMin = raw.duration_min > 0 ? raw.duration_min : null;

    let confidenceBp = CONFIDENCE_BP[raw.confidence];
    if (priceCents !== null && priceCents < SUSPICIOUS_PRICE_CENTS) {
      confidenceBp = Math.min(confidenceBp, CONFIDENCE_BP.unsure);
    }

    return {
      kind: raw.kind,
      name: { [locale]: raw.name },
      category: raw.category.length > 0 ? raw.category : null,
      durationMin,
      priceCents,
      priceIsFrom: raw.price_is_from,
      variants: raw.variants.map((v) => ({
        label: v.label,
        priceCents: v.price_cents,
        durationMin: v.duration_min > 0 ? v.duration_min : null,
      })),
      confidenceBp,
      sourceSeq: opts.sourceSeq,
      bbox: clampBox(raw.bbox, opts.widthPx, opts.heightPx),
    };
  });
}

export interface MergeResult {
  items: DraftItem[];
  /** 同名同价被合掉的行数 */
  merged: number;
  /** 同名**不同价**的组数 —— 这些全部保留并标低置信度，等老板裁决 */
  conflicts: number;
}

/**
 * 跨照片合并。
 *
 * 两条规则，区别很重要：
 *
 *   同名同价 → **合并**。照片边角重叠拍到同一行，留一条就够，
 *              留下置信度高的那条（拍得清楚的那张照片）。
 *
 *   同名不同价 → **两条都留**，并把两条都压到低置信度。
 *              「Gel Manicure 在手部牌上是 $45、在加项牌上是 $50」在真店里
 *              通常意味着有个条件我们没读到（比如「周末价」）。
 *              自动挑一个 = 有一半的概率给老板建了个错价格，而且他不会发现。
 *              两条都标黄摆出来，他三秒就能说清是怎么回事。
 */
export function mergeDrafts(batches: DraftItem[][]): MergeResult {
  const groups = new Map<string, DraftItem[]>();
  const order: string[] = [];

  for (const batch of batches) {
    for (const item of batch) {
      // note / price_modifier 只按名字归组：说明文字本来就没有价格可比
      const key = `${item.kind}::${nameKey(item.name[Object.keys(item.name)[0]!] ?? '')}`;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push(item);
    }
  }

  const items: DraftItem[] = [];
  let merged = 0;
  let conflicts = 0;

  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) { items.push(group[0]!); continue; }

    // 按价格再分一层。同价的合成一条，不同价的各留一条。
    const byPrice = new Map<number | null, DraftItem[]>();
    for (const it of group) {
      if (!byPrice.has(it.priceCents)) byPrice.set(it.priceCents, []);
      byPrice.get(it.priceCents)!.push(it);
    }

    const isConflict = byPrice.size > 1;
    if (isConflict) conflicts++;

    for (const same of byPrice.values()) {
      merged += same.length - 1;
      // 留置信度最高的那一条（并列时留先出现的，也就是照片顺序靠前的）
      const best = same.reduce((a, b) => (b.confidenceBp > a.confidenceBp ? b : a));
      items.push(isConflict
        ? { ...best, confidenceBp: Math.min(best.confidenceBp, CONFIDENCE_BP.unsure) }
        : best);
    }
  }

  return { items, merged, conflicts };
}

/** 确认页要标黄的行 */
export function isLowConfidence(item: { confidenceBp: number }): boolean {
  return item.confidenceBp < LOW_CONFIDENCE_BP;
}

// ─────────────────────────────────────────────────────────────────────────────
// 落地：草案行 → catalog.saveService 的入参
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceDraft {
  name: Record<string, string>;
  durationMin: number;
  basePriceCents: number;
}

/**
 * 一行草案展开成要建的项目。
 *
 * 三件在这里而不是在 UI 里做的事：
 *
 * 1. **变体拆成多个项目**。「Gel Manicure: Short $45 / Long $55」在开单时
 *    是两个不同的选择，硬塞成一个项目就等于让前台每次手改价格。
 * 2. **没印时长的用兜底值**。价目表印时长的是少数 —— 逼老板给 38 个项目
 *    逐个填时长，他会在第 5 个的时候放弃整个功能。给一个能一键改的默认值。
 * 3. **开放价（"$25 & up"）按起步价建**。前台开单时本来就要改价，
 *    起步价是对的锚点；建成 $0 会让日程表上一排单显示成免费。
 */
export function toServiceDrafts(
  item: DraftItem,
  fallbackDurationMin: number,
): ServiceDraft[] {
  const locale = Object.keys(item.name)[0] ?? 'en';
  const base = item.name[locale] ?? '';
  const dur = (d: number | null) => d ?? item.durationMin ?? fallbackDurationMin;

  if (item.variants.length > 0) {
    return item.variants.map((v) => ({
      name: { [locale]: `${base} · ${v.label}` },
      durationMin: dur(v.durationMin),
      basePriceCents: v.priceCents,
    }));
  }

  return [{
    name: { ...item.name },
    durationMin: dur(null),
    basePriceCents: item.priceCents ?? 0,
  }];
}
