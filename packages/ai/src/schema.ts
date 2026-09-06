/**
 * 价目表提取的**两层校验**（05-AI-INTEGRATION §1.3）
 *
 *   形状层 = JSON Schema（strict tool use）→ 挡字段缺失、类型错、枚举瞎编
 *   语义层 = Zod（这里）                    → 挡「看起来对但算错」
 *
 * 两层不是重复。Anthropic 的 strict tool use **不支持数值约束**
 * （没有 minimum / maximum / multipleOf），也不支持字符串长度约束。
 * 也就是说形状层拦不住 `price_cents: -4500` 或 `duration_min: 99999`，
 * 而这两个值落进 services 表就是一单负四十五块、一单占满两天。
 *
 * 所以：模型的输出先过 JSON Schema（模型侧强制），再过 Zod（我们侧强制），
 * 两层都过了才成为草案的一行。过不了的**丢掉并计数**，不是抛异常 ——
 * 38 个项目里有 1 个畸形，不该让老板重拍一遍整张价目表。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 形状层：给模型的 JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 置信度用**枚举**而不是 0–1 的数。
 *
 * 模型报 0.87 是假精度 —— 它分不清 0.87 和 0.83，但分得清「认得清」
 * 和「这行被反光糊了」。而且枚举能被形状层强制，浮点不能（没有数值约束）。
 * 三档映射成 basis point 在 `CONFIDENCE_BP`，确认页据此标黄。
 */
const CONFIDENCE_LEVELS = ['certain', 'likely', 'unsure'] as const;

/** 05 §5.3 的反面清单：修饰行不是独立项目，让模型自己分类 */
const ITEM_KINDS = ['service', 'addon', 'package', 'note', 'price_modifier'] as const;

const bboxSchema = {
  type: 'object',
  description:
    '这一行在原图里的像素框。坐标与原图 1:1，左上角是 (0,0)。' +
    '找不到确切位置就给这一整行文字的外接框。',
  properties: {
    x1: { type: 'integer' }, y1: { type: 'integer' },
    x2: { type: 'integer' }, y2: { type: 'integer' },
  },
  required: ['x1', 'y1', 'x2', 'y2'],
  additionalProperties: false,
} as const;

const variantSchema = {
  type: 'object',
  description: '同一个项目的多个价格档位（按长度 / 等级 / 时长）',
  properties: {
    label: {
      type: 'string',
      description: '档位名，照抄价目表上的字，例如 "Short" / "60 min" / "Deluxe"',
    },
    price_cents: { type: 'integer', description: '整数分。$45 → 4500。没写价格填 0' },
    duration_min: { type: 'integer', description: '分钟。没写填 0' },
  },
  required: ['label', 'price_cents', 'duration_min'],
  additionalProperties: false,
} as const;

/** strict tool use 的输入 schema。`strict: true` 要求全 required + 禁止额外字段。 */
export const priceListToolSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '价目表上的每一行，从上到下、从左到右，一行都不要漏。',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '项目名，**照抄价目表上印的字**，不要翻译、不要美化、不要补全缩写。',
          },
          category: {
            type: 'string',
            description: '它所属的分类标题（如 "MANICURE" / "足疗"）。没有分类就填空字符串。',
          },
          kind: {
            type: 'string',
            enum: ITEM_KINDS,
            description:
              'service = 可以单独开单的项目；' +
              'addon = 加项（"Add-on"、"With any service"、"+$10 French"）；' +
              'note = 说明文字（"Kids under 10"、"Prices subject to change"、营业时间）；' +
              'price_modifier = 只改价不成单的规则（"Long nails +$5"）。' +
              '拿不准就选 note —— 多建一个不该建的项目，比漏掉一句说明更麻烦。',
          },
          duration_min: {
            type: 'integer',
            description: '时长，分钟。价目表上**没印**时长就填 0，不要猜。',
          },
          price_cents: {
            type: 'integer',
            description: '价格，整数分。$45 → 4500，$12.50 → 1250。没印价格就填 0。',
          },
          price_is_from: {
            type: 'boolean',
            description: '"$25 & up" / "from $40" / "$30+" 这种开放价填 true。',
          },
          variants: {
            type: 'array',
            description:
              '一个项目印了多个价格时填这里（按长度/等级/时长分档），' +
              '并把 price_cents 填成最低的那一档。只有一个价格就给空数组。',
            items: variantSchema,
          },
          package_sessions: {
            type: 'integer',
            description: '套餐/次卡包含的可核销次数；无限次填 0。非套餐也填 0。',
          },
          package_service_names: {
            type: 'array',
            description: '套餐明确包含的项目名称，逐字照抄。非套餐给空数组。',
            items: { type: 'string' },
          },
          package_valid_days: {
            type: 'integer',
            description: '套餐有效天数；没写或非套餐填 0，不要猜。',
          },
          confidence: {
            type: 'string',
            enum: CONFIDENCE_LEVELS,
            description:
              'certain = 字迹清楚、价格明确；' +
              'likely = 认得出但有一点含糊（手写、缩写、反光）；' +
              'unsure = 糊了 / 被遮住 / 你是靠上下文推出来的。' +
              '**宁可报 unsure**：标黄让老板多看一眼，代价远小于一个错价格被静默建成项目。',
          },
          bbox: bboxSchema,
        },
        required: [
          'name', 'category', 'kind', 'duration_min',
          'price_cents', 'price_is_from', 'variants', 'package_sessions',
          'package_service_names', 'package_valid_days', 'confidence', 'bbox',
        ],
        additionalProperties: false,
      },
    },
    unresolved: {
      type: 'array',
      description:
        '你**没法从这张图知道**、但开店需要的信息。' +
        '这些会变成问老板的下一个问题 —— 与其猜一个填进去，不如在这里列出来。',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: '缺什么，如 "duration" / "business_hours"' },
          question: { type: 'string', description: '直接问老板的一句话，用中文' },
        },
        required: ['field', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['items', 'unresolved'],
  additionalProperties: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 语义层：Zod
// ─────────────────────────────────────────────────────────────────────────────

/** 三档置信度 → basis point。低于 `LOW_CONFIDENCE_BP` 的在确认页标黄。 */
export const CONFIDENCE_BP: Record<(typeof CONFIDENCE_LEVELS)[number], number> = {
  certain: 9700,
  likely: 8800,
  unsure: 6000,
};

/** 05 §4.2 建议的高亮阈值 0.85 */
export const LOW_CONFIDENCE_BP = 8500;

/** 单个项目的价格上限：$5,000。超过这个数几乎一定是把电话号码当成价格读了。 */
const MAX_PRICE_CENTS = 500_000;

const variantZ = z.object({
  label: z.string().trim().min(1).max(60),
  price_cents: z.number().int().min(0).max(MAX_PRICE_CENTS),
  duration_min: z.number().int().min(0).max(600),
});

export const extractedItemZ = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(120),
  kind: z.enum(ITEM_KINDS),
  duration_min: z.number().int().min(0).max(600),
  price_cents: z.number().int().min(0).max(MAX_PRICE_CENTS),
  price_is_from: z.boolean(),
  // 变体多到 12 个以上，说明模型把整个分类塞进了一行
  variants: z.array(variantZ).max(12),
  package_sessions: z.number().int().min(0).max(10_000),
  package_service_names: z.array(z.string().trim().min(1).max(200)).max(30),
  package_valid_days: z.number().int().min(0).max(3650),
  confidence: z.enum(CONFIDENCE_LEVELS),
  bbox: z.object({
    x1: z.number().int(), y1: z.number().int(),
    x2: z.number().int(), y2: z.number().int(),
  }),
  pricingUnit: z.string().trim().nullable().optional(),
});

export const extractionZ = z.object({
  items: z.array(extractedItemZ).max(300),
  unresolved: z.array(z.object({
    field: z.string().trim().max(80),
    question: z.string().trim().max(300),
  })).max(20),
});

export type ExtractedItem = z.infer<typeof extractedItemZ>;
export type Extraction = z.infer<typeof extractionZ>;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export type ItemKind = (typeof ITEM_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Luna 紧凑格式 (29 §11, qa-evidence/luna-vision-latency-20260906)
// ─────────────────────────────────────────────────────────────────────────────

export const compactPriceListToolSchema = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                n: { type: 'string', description: '原文项目名称或说明全文' },
                k: { type: 'string', enum: ITEM_KINDS },
                p: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      l: { type: 'string', description: '价格档位原文标签；单价无标签时空串' },
                      d: { type: 'integer', description: '分钟，未印0' },
                      c: { type: 'integer', description: '整数美分，未印0' },
                    },
                    required: ['l', 'd', 'c'],
                    additionalProperties: false,
                  },
                  description: '单价也只存一项，多档全部保留；无价格说明行给空数组',
                },
                f: { type: 'boolean', description: '是否起步价' },
                q: { type: 'string', enum: CONFIDENCE_LEVELS },
                b: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: '原图像素框[x1,y1,x2,y2]，恰好4项',
                },
                pkg: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      properties: {
                        s: { type: 'integer', description: '明确印出的核销次数，未印0' },
                        names: { type: 'array', items: { type: 'string' } },
                        days: { type: 'integer', description: '明确有效天数，未印0' },
                      },
                      required: ['s', 'names', 'days'],
                      additionalProperties: false,
                    },
                  ],
                  description: '仅套餐有此对象；其余null',
                },
                unit: {
                  type: ['string', 'null'],
                  description: '原图计价单位限定如 each；没有则null',
                },
              },
              required: ['n', 'k', 'p', 'f', 'q', 'b', 'pkg', 'unit'],
              additionalProperties: false,
            },
          },
        },
        required: ['category', 'rows'],
        additionalProperties: false,
      },
    },
    unresolved: {
      type: 'array',
      description: '你没法从这张图知道、但开店需要的信息',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: '缺什么' },
          question: { type: 'string', description: '问老板的一句话' },
        },
        required: ['field', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups', 'unresolved'],
  additionalProperties: false,
} as const;

export const compactRowZ = z.object({
  n: z.string().trim().min(1).max(200),
  k: z.enum(ITEM_KINDS),
  p: z.array(z.object({
    l: z.string().trim().max(60),
    d: z.number().int().min(0).max(600),
    c: z.number().int().min(0).max(MAX_PRICE_CENTS),
  })).max(12),
  f: z.boolean(),
  q: z.enum(CONFIDENCE_LEVELS),
  b: z.array(z.number().int()).min(4).max(4),
  pkg: z.object({
    s: z.number().int().min(0).max(10_000),
    names: z.array(z.string().trim().min(1).max(200)).max(30),
    days: z.number().int().min(0).max(3650),
  }).nullable(),
  unit: z.string().trim().nullable().optional(),
});

export const compactGroupZ = z.object({
  category: z.string().trim().max(120),
  rows: z.array(compactRowZ).max(300),
});

export const compactExtractionZ = z.object({
  groups: z.array(compactGroupZ).max(100),
  unresolved: z.array(z.object({
    field: z.string().trim().max(80),
    question: z.string().trim().max(300),
  })).max(20),
});

export type CompactExtraction = z.infer<typeof compactExtractionZ>;
export type CompactRow = z.infer<typeof compactRowZ>;

export function decodeCompactExtraction(compact: CompactExtraction): Extraction {
  const items: ExtractedItem[] = [];

  for (const group of compact.groups) {
    const category = group.category || '';
    for (const row of group.rows) {
      const bbox = {
        x1: row.b[0] ?? 0,
        y1: row.b[1] ?? 0,
        x2: row.b[2] ?? 0,
        y2: row.b[3] ?? 0,
      };

      const prices = row.p || [];
      let price_cents = 0;
      let duration_min = 0;
      let variants: Array<{ label: string; price_cents: number; duration_min: number }> = [];

      if (prices.length === 1 && !prices[0]!.l) {
        price_cents = prices[0]!.c;
        duration_min = prices[0]!.d;
      } else if (prices.length >= 1) {
        variants = prices.map((pr) => ({
          label: pr.l,
          price_cents: pr.c,
          duration_min: pr.d,
        }));
        price_cents = Math.min(...prices.map((pr) => pr.c));
        duration_min = prices[0]?.d ?? 0;
      }

      items.push({
        name: row.n,
        category,
        kind: row.k,
        duration_min,
        price_cents,
        price_is_from: Boolean(row.f),
        variants,
        package_sessions: row.pkg?.s ?? 0,
        package_service_names: row.pkg?.names ?? [],
        package_valid_days: row.pkg?.days ?? 0,
        confidence: row.q,
        bbox,
        pricingUnit: row.unit ?? null,
      });
    }
  }

  return {
    items,
    unresolved: compact.unresolved || [],
  };
}

