/**
 * 归一化与合并的测试。
 *
 * 这一层是 AI 流水线里**唯一可复现**的部分，所以它必须被钉死：
 * 模型明天可能换个说法，但「同名不同价要标黄不要自动挑一个」这条规则
 * 不能因为换了模型就变。
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeExtraction, mergeDrafts, nameKey, toServiceDrafts, isLowConfidence,
  type DraftItem,
} from './normalize';
import { CONFIDENCE_BP, extractionZ, type Extraction } from './schema';

/** 造一行模型输出。默认是一条干净的 $45 / 45 分钟美甲。 */
function row(over: Partial<Extraction['items'][number]> = {}): Extraction['items'][number] {
  return {
    name: 'Gel Manicure',
    category: 'MANICURE',
    kind: 'service',
    duration_min: 45,
    price_cents: 4500,
    price_is_from: false,
    variants: [],
    package_sessions: 0,
    package_service_names: [],
    package_valid_days: 0,
    confidence: 'certain',
    bbox: { x1: 10, y1: 20, x2: 300, y2: 60 },
    ...over,
  };
}

const extraction = (items: Extraction['items']): Extraction => ({ items, unresolved: [] });

describe('nameKey', () => {
  it('大小写、空格、标点都不算数', () => {
    expect(nameKey('Gel Manicure')).toBe(nameKey('  GEL   MANICURE.  '));
    expect(nameKey('Gel-X Full Set')).toBe(nameKey('Gel X  Full  Set'));
  });

  it('越南语声调符归一 —— 技师名和项目名常带声调，同一个项目不该算两个', () => {
    expect(nameKey('Sơn gel tay')).toBe(nameKey('Son gel tay'));
  });

  it('中文不被标点规则吃掉', () => {
    expect(nameKey('足底按摩（60分钟）')).toBe('足底按摩 60分钟');
  });
});

describe('normalizeExtraction', () => {
  it('0 表示「价目表上没印」，落成 null 而不是 0 元 0 分钟', () => {
    const [item] = normalizeExtraction(
      extraction([row({ duration_min: 0, price_cents: 0 })]), { sourceSeq: 0 });
    expect(item!.durationMin).toBeNull();
    expect(item!.priceCents).toBeNull();
  });

  it('置信度按枚举映射成 basis point，低档的要标黄', () => {
    const items = normalizeExtraction(extraction([
      row({ confidence: 'certain' }),
      row({ name: 'Dip Powder', confidence: 'likely' }),
      row({ name: 'Pedicure', confidence: 'unsure' }),
    ]), { sourceSeq: 0 });

    expect(items.map((i) => i.confidenceBp))
      .toEqual([CONFIDENCE_BP.certain, CONFIDENCE_BP.likely, CONFIDENCE_BP.unsure]);
    expect(items.map(isLowConfidence)).toEqual([false, false, true]);
  });

  it('低于 $1 的价格标成低置信度，但【不】自动乘 100', () => {
    // 模型把 $45 写成了 45（当成分了）。自动修正会把真正的 $0.50 加价项改成 $50，
    // 所以只标黄让老板看，值原样留着。
    const [item] = normalizeExtraction(
      extraction([row({ price_cents: 45 })]), { sourceSeq: 0 });
    expect(item!.priceCents).toBe(45);
    expect(isLowConfidence(item!)).toBe(true);
  });

  it('bbox 夹进图内；角报反了就交换；退化成线就丢掉', () => {
    const [ok, flipped, degenerate] = normalizeExtraction(extraction([
      row({ bbox: { x1: -20, y1: 10, x2: 9999, y2: 60 } }),
      row({ name: 'B', bbox: { x1: 300, y1: 60, x2: 10, y2: 20 } }),
      row({ name: 'C', bbox: { x1: 10, y1: 10, x2: 11, y2: 400 } }),
    ]), { sourceSeq: 0, widthPx: 1200, heightPx: 800 });

    expect(ok!.bbox).toEqual([0, 10, 1200, 60]);
    expect(flipped!.bbox).toEqual([10, 20, 300, 60]);
    expect(degenerate!.bbox).toBeNull();
  });

  it('空分类落成 null，别让确认页显示一个空的分类标签', () => {
    const [item] = normalizeExtraction(
      extraction([row({ category: '' })]), { sourceSeq: 0 });
    expect(item!.category).toBeNull();
  });

  it('语言 key 跟着价目表走', () => {
    const [item] = normalizeExtraction(
      extraction([row({ name: '足底按摩' })]), { sourceSeq: 0, locale: 'zh-Hans' });
    expect(item!.name).toEqual({ 'zh-Hans': '足底按摩' });
  });
});

describe('mergeDrafts', () => {
  const draft = (over: Partial<DraftItem> = {}): DraftItem => ({
    kind: 'service',
    name: { en: 'Gel Manicure' },
    category: null,
    durationMin: 45,
    priceCents: 4500,
    priceIsFrom: false,
    variants: [],
    confidenceBp: CONFIDENCE_BP.certain,
    sourceSeq: 0,
    bbox: null,
    ...over,
  });

  it('同名同价合成一条，留置信度高的那张照片', () => {
    const r = mergeDrafts([
      [draft({ sourceSeq: 0, confidenceBp: CONFIDENCE_BP.unsure })],
      [draft({ sourceSeq: 1, confidenceBp: CONFIDENCE_BP.certain })],
    ]);
    expect(r.items).toHaveLength(1);
    expect(r.merged).toBe(1);
    expect(r.conflicts).toBe(0);
    expect(r.items[0]!.sourceSeq).toBe(1);
  });

  it('同名【不同价】两条都留，且都压成低置信度让老板裁决', () => {
    // 手部牌 $45、加项牌 $50 —— 多半是有个条件没读到（周末价之类）。
    // 自动挑一个 = 一半概率静默建错价格。
    const r = mergeDrafts([
      [draft({ priceCents: 4500 })],
      [draft({ priceCents: 5000 })],
    ]);
    expect(r.items).toHaveLength(2);
    expect(r.conflicts).toBe(1);
    expect(r.items.every(isLowConfidence)).toBe(true);
  });

  it('同名但一个是项目一个是说明，不算重复', () => {
    const r = mergeDrafts([[
      draft({ name: { en: 'Kids' }, kind: 'service', priceCents: 2000 }),
      draft({ name: { en: 'Kids' }, kind: 'note', priceCents: null }),
    ]]);
    expect(r.items).toHaveLength(2);
    expect(r.merged).toBe(0);
  });

  it('不同分类的同名同价项目不合并（29 §11）', () => {
    const r = mergeDrafts([
      [draft({ name: { en: 'Classic' }, category: 'MANICURE', priceCents: 3000 })],
      [draft({ name: { en: 'Classic' }, category: 'PEDICURE', priceCents: 3000 })],
    ]);
    expect(r.items).toHaveLength(2);
    expect(r.merged).toBe(0);
    expect(r.conflicts).toBe(0);
  });

  it('保持照片顺序 —— 老板核对时的行序要和他拍的顺序一致', () => {
    const r = mergeDrafts([
      [draft({ name: { en: 'A' } }), draft({ name: { en: 'B' } })],
      [draft({ name: { en: 'C' } })],
    ]);
    expect(r.items.map((i) => i.name['en'])).toEqual(['A', 'B', 'C']);
  });
});

describe('toServiceDrafts', () => {
  const base: DraftItem = {
    kind: 'service',
    name: { en: 'Gel Manicure' },
    category: 'MANICURE',
    durationMin: null,
    priceCents: 4500,
    priceIsFrom: false,
    variants: [],
    confidenceBp: CONFIDENCE_BP.certain,
    sourceSeq: 0,
    bbox: null,
  };

  it('没印时长的用兜底值 —— 逼老板给 38 个项目逐个填时长，他会放弃', () => {
    expect(toServiceDrafts(base, 45)).toEqual([
      { name: { en: 'Gel Manicure' }, durationMin: 45, basePriceCents: 4500 },
    ]);
  });

  it('变体拆成多个项目，各自的时长优先于兜底值', () => {
    const out = toServiceDrafts({
      ...base,
      variants: [
        { label: 'Short', priceCents: 4500, durationMin: null },
        { label: 'Long', priceCents: 5500, durationMin: 60 },
      ],
    }, 30);

    expect(out).toEqual([
      { name: { en: 'Gel Manicure · Short' }, durationMin: 30, basePriceCents: 4500 },
      { name: { en: 'Gel Manicure · Long' }, durationMin: 60, basePriceCents: 5500 },
    ]);
  });

  it('⭐ 有档位时每一种语言都带上后缀，不能只剩一种', () => {
    // 只留第一个语言的话，补齐上线之后会出现：有档位的项目在自助屏上
    // 显示「Gel Manicure · Long」，而隔壁没档位的项目却是越南语 ——
    // 同一屏上两种语言最让客人困惑
    const out = toServiceDrafts({
      ...base,
      name: { en: 'Gel Manicure', 'zh-Hans': '光疗美甲', vi: 'sơn gel' },
      variants: [{ label: 'Long', priceCents: 5500, durationMin: 60 }],
    }, 30);

    expect(out[0]!.name).toEqual({
      en: 'Gel Manicure · Long',
      'zh-Hans': '光疗美甲 · Long',
      vi: 'sơn gel · Long',
    });
  });

  it('开放价按起步价建，不建成 $0', () => {
    // 建成 $0 会让日程表上一排单显示成免费，前台以为系统坏了
    const [out] = toServiceDrafts({ ...base, priceIsFrom: true, priceCents: 2500 }, 45);
    expect(out!.basePriceCents).toBe(2500);
  });
});

describe('两层校验', () => {
  it('形状层过了、语义层挡下：负价格进不了草案', () => {
    // strict tool use 不支持 minimum/maximum，所以负数只能靠 Zod 挡
    expect(extractionZ.safeParse(extraction([row({ price_cents: -4500 })])).success)
      .toBe(false);
  });

  it('荒唐时长挡下 —— 一单占满两天会把日程表撑坏', () => {
    expect(extractionZ.safeParse(extraction([row({ duration_min: 99999 })])).success)
      .toBe(false);
  });

  it('$5000 以上的价格挡下 —— 几乎一定是把电话号码读成了价格', () => {
    expect(extractionZ.safeParse(extraction([row({ price_cents: 5125550142 })])).success)
      .toBe(false);
  });

  it('干净的一行两层都过', () => {
    expect(extractionZ.safeParse(extraction([row()])).success).toBe(true);
  });
});
