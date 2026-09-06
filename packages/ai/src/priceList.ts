/**
 * 价目表视觉提取 (05-AI-INTEGRATION §5, 29 §11)
 *
 * 流水线：
 *   图片 → Luna (gpt-5.6-luna) 紧凑 Schema → decodeCompactExtraction
 *        → Zod 语义校验 → 归一化 (含 pricingUnit) → 跨图合并 → 草案行
 *
 * **AI 永远不直接写数据库**。它只把图片变成一组待确认的候选行，落库由命令总线完成。
 */

import {
  priceListToolSchema,
  compactPriceListToolSchema,
  extractionZ,
  compactExtractionZ,
  compactRowZ,
  decodeCompactExtraction,
  type Extraction,
  type CompactExtraction,
} from './schema.js';
import { PRICE_LIST_SYSTEM, priceListUserText } from './prompt.js';
import { normalizeExtraction, mergeDrafts, type DraftItem, type MergeResult } from './normalize.js';
import { sumUsage, type TokenUsage } from './cost.js';
import {
  LunaRuntime,
  getLunaRuntime,
  LunaRuntimeError,
  type LunaTool,
  type LunaResponse,
} from './runtime/luna.js';
import { LUNA_TIMEOUTS } from './runtime/config.js';

export const MAX_IMAGE_EDGE_PX = 2576;

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface PriceListImage {
  /** 第几张。与 blueprint_sources.seq 对应 */
  seq: number;
  /** base64，不带 data: 前缀 */
  base64: string;
  mediaType: ImageMediaType;
  /** 原始像素尺寸，用来夹 bbox。不给就不夹 */
  widthPx?: number | undefined;
  heightPx?: number | undefined;
}

export interface ExtractOptions {
  apiKey?: string | undefined;
  /** 价目表印的是哪种语言，默认 en */
  locale?: string | undefined;
  /** 单张图的超时 */
  timeoutMs?: number | undefined;
  /** 注入 Luna 运行时实例 */
  runtime?: LunaRuntime | undefined;
  /** 兼容测试注入 mock 客户端 */
  client?: any | undefined;
  log?: { warn: (o: unknown, m: string) => void } | undefined;
}

export interface PerImageResult {
  seq: number;
  items: DraftItem[];
  usage: TokenUsage;
  /** 这一张失败了（超时 / 模型拒答 / 校验全挂）。其余张照常出结果 */
  error?: string | undefined;
}

export interface ExtractResult {
  items: DraftItem[];
  unresolved: Array<{ field: string; question: string }>;
  usage: TokenUsage;
  merge: MergeResult;
  perImage: PerImageResult[];
  /** 过不了 Zod 被丢掉的行数。>0 时确认页提示「有 N 行没认出来，建议重拍」 */
  dropped: number;
}

const TOOL: LunaTool = {
  name: 'record_price_list',
  description:
    '把价目表照片上的每一行录进系统。只录图上真实印着的内容，' +
    '没印的字段填 0，拿不准的标 unsure。',
  parameters: compactPriceListToolSchema as unknown as Record<string, unknown>,
  strict: true,
};

/**
 * 跑一张图
 */
async function extractOne(
  image: PriceListImage,
  total: number,
  opts: ExtractOptions,
): Promise<{ extraction: Extraction | null; usage: TokenUsage; error?: string }> {
  // 如果注入了旧版测试 client，做兼容处理
  if (opts.client && typeof opts.client.messages?.stream === 'function') {
    return extractOneLegacyMock(image, total, opts);
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());

  let response: LunaResponse;
  try {
    response = await runtime.invoke({
      instructions: PRICE_LIST_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            base64: image.base64,
            mediaType: image.mediaType,
          },
          {
            type: 'text',
            text: priceListUserText(image.seq, total),
          },
        ],
      }],
      tools: [TOOL],
      toolChoice: { type: 'function', name: TOOL.name },
      effort: 'medium', // 紧凑中档 (29 §12.2)
      timeoutMs: opts.timeoutMs ?? LUNA_TIMEOUTS.VISION_MS,
    });
  } catch (err: any) {
    if (err instanceof LunaRuntimeError) {
      if (err.kind === 'refusal') {
        return { extraction: null, usage: { inputTokens: 0, outputTokens: 0 }, error: 'refusal' };
      }
      if (err.kind === 'context_length_exceeded') {
        return { extraction: null, usage: { inputTokens: 0, outputTokens: 0 }, error: 'too_many_rows' };
      }
    }
    throw err;
  }

  const usage: TokenUsage = {
    inputTokens: response.usage.uncachedInputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadInputTokens: response.usage.cachedReadInputTokens,
    cacheCreationInputTokens: 0,
  };

  if (response.status === 'refusal') {
    return { extraction: null, usage, error: 'refusal' };
  }

  const toolCall = response.toolCalls.find((t) => t.name === TOOL.name);
  if (!toolCall) {
    return { extraction: null, usage, error: 'no_tool_use' };
  }

  // 1. 紧凑模式校验与解码 (29 §11)
  const compactParsed = compactExtractionZ.safeParse(toolCall.arguments);
  if (compactParsed.success) {
    const decoded = decodeCompactExtraction(compactParsed.data);
    return { extraction: decoded, usage };
  }

  // 2. 尝试抢救紧凑输出
  const salvagedCompact = salvageCompact(toolCall.arguments);
  if (salvagedCompact) {
    const decoded = decodeCompactExtraction(salvagedCompact);
    return { extraction: decoded, usage };
  }

  // 3. 兼容直接输出传统展开格式
  const parsed = extractionZ.safeParse(toolCall.arguments);
  if (parsed.success) {
    return { extraction: parsed.data, usage };
  }
  const salvaged = salvage(toolCall.arguments);
  if (salvaged) {
    return { extraction: salvaged, usage };
  }

  return { extraction: null, usage, error: 'schema_rejected' };
}

/** 兼容旧版 Anthropic messages.stream mock 测试 */
async function extractOneLegacyMock(
  image: PriceListImage,
  total: number,
  opts: ExtractOptions,
): Promise<{ extraction: Extraction | null; usage: TokenUsage; error?: string }> {
  const stream = opts.client.messages.stream({
    model: 'claude-sonnet-5',
    max_tokens: 32_000,
    system: [{ type: 'text', text: PRICE_LIST_SYSTEM }],
    tools: [{ name: TOOL.name, input_schema: priceListToolSchema }],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: priceListUserText(image.seq, total) },
      ],
    }],
  });
  const message = await stream.finalMessage();
  const usage: TokenUsage = {
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
    cacheReadInputTokens: message.usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage?.cache_creation_input_tokens ?? 0,
  };
  const block = message.content?.find((b: any) => b.type === 'tool_use');
  if (!block) return { extraction: null, usage, error: 'no_tool_use' };
  const parsed = extractionZ.safeParse(block.input);
  if (parsed.success) return { extraction: parsed.data, usage };
  const sal = salvage(block.input);
  if (sal) return { extraction: sal, usage };
  return { extraction: null, usage, error: 'schema_rejected' };
}

function salvageCompact(input: unknown): CompactExtraction | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as { groups?: unknown; unresolved?: unknown };
  if (!Array.isArray(raw.groups)) return null;

  const validGroups: CompactExtraction['groups'] = [];
  for (const g of raw.groups) {
    if (typeof g !== 'object' || g === null) continue;
    const category = typeof (g as any).category === 'string' ? (g as any).category : '';
    const rawRows = Array.isArray((g as any).rows) ? (g as any).rows : [];
    const validRows: any[] = [];
    for (const r of rawRows) {
      const one = compactRowZ.safeParse(r);
      if (one.success) validRows.push(one.data);
    }
    if (validRows.length > 0) {
      validGroups.push({ category, rows: validRows });
    }
  }

  if (validGroups.length === 0) return null;
  const un = compactExtractionZ.shape.unresolved.safeParse(raw.unresolved);
  return { groups: validGroups, unresolved: un.success ? un.data : [] };
}

function salvage(input: unknown): Extraction | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as { items?: unknown; unresolved?: unknown };
  if (!Array.isArray(raw.items)) return null;

  const items: Extraction['items'] = [];
  for (const row of raw.items) {
    const one = extractionZ.shape.items.element.safeParse(row);
    if (one.success) items.push(one.data);
  }
  if (items.length === 0) return null;

  const un = extractionZ.shape.unresolved.safeParse(raw.unresolved);
  return { items, unresolved: un.success ? un.data : [] };
}

/**
 * 提取一组照片。
 *
 * **一张失败不影响其余张** —— 六张里有一张拍糊了，老板拿到另外五张的结果
 * 加一句「第 3 张没认出来，重拍这一张就行」，比整个流程报错重来好得多。
 */
export async function extractPriceList(
  images: readonly PriceListImage[],
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const perImage: PerImageResult[] = [];
  const unresolved: Array<{ field: string; question: string }> = [];
  const seenQuestions = new Set<string>();
  let dropped = 0;

  for (const image of images) {
    try {
      const { extraction, usage, error } = await extractOne(image, images.length, opts);
      if (!extraction) {
        perImage.push({ seq: image.seq, items: [], usage, error: error ?? 'unknown' });
        continue;
      }

      const items = normalizeExtraction(extraction, {
        sourceSeq: image.seq,
        ...(opts.locale ? { locale: opts.locale } : {}),
        ...(image.widthPx ? { widthPx: image.widthPx } : {}),
        ...(image.heightPx ? { heightPx: image.heightPx } : {}),
      });
      dropped += Math.max(0, countRawItems(extraction) - items.length);

      for (const q of extraction.unresolved) {
        if (seenQuestions.has(q.question)) continue;
        seenQuestions.add(q.question);
        unresolved.push(q);
      }

      perImage.push({ seq: image.seq, items, usage });
    } catch (e) {
      opts.log?.warn?.({ err: e, seq: image.seq }, 'price list extraction failed');
      perImage.push({
        seq: image.seq,
        items: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        error: e instanceof Error ? e.message : 'unknown',
      });
    }
  }

  const merge = mergeDrafts(perImage.map((p) => p.items));

  return {
    items: merge.items,
    unresolved,
    usage: sumUsage(perImage.map((p) => p.usage)),
    merge,
    perImage,
    dropped,
  };
}

function countRawItems(e: Extraction): number {
  return e.items.length;
}
