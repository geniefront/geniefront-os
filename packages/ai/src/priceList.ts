/**
 * 价目表视觉提取（05-AI-INTEGRATION §5）
 *
 * 一条流水线：
 *   图片 → Claude Vision + strict tool use → JSON Schema（形状层）
 *        → Zod（语义层） → 归一化 → 跨图合并 → 草案行
 *
 * **AI 永远不直接写数据库**（05 §0）。这个模块不认识 postgres，
 * 它只把图片变成一组待确认的候选行，落库由命令总线完成。
 *
 * 一张图一次请求，不是一次请求塞 6 张。原因（05 §5.2）：
 * 一张 A3 大价目表本身就有 80 行，多张一起给必漏行；分开发还有两个好处 ——
 * 某一张拍糊了只重跑那一张，以及系统提示的前缀缓存在第二张就开始命中。
 */

import Anthropic from '@anthropic-ai/sdk';
import { priceListToolSchema, extractionZ, type Extraction } from './schema.js';
import { PRICE_LIST_SYSTEM, priceListUserText } from './prompt.js';
import { normalizeExtraction, mergeDrafts, type DraftItem, type MergeResult } from './normalize.js';
import { sumUsage, type TokenUsage } from './cost.js';

/** Claude 视觉长边上限（05 §5.1）。超过这个尺寸 API 会自己缩，坐标就不再 1:1。 */
export const MAX_IMAGE_EDGE_PX = 2576;

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PriceListImage {
  /** 第几张。与 blueprint_sources.seq 对应 */
  seq: number;
  /** base64，不带 data: 前缀 */
  base64: string;
  mediaType: ImageMediaType;
  /** 原始像素尺寸，用来夹 bbox。不给就不夹 */
  widthPx?: number;
  heightPx?: number;
}

export interface ExtractOptions {
  apiKey: string;
  /** 价目表印的是哪种语言，默认 en */
  locale?: string;
  /** 单张图的超时。价目表密集时模型想得久，给足 */
  timeoutMs?: number;
  /** 注入用，测试里替换掉真实客户端 */
  client?: Pick<Anthropic, 'messages'>;
  log?: { warn: (o: unknown, m: string) => void };
}

export interface PerImageResult {
  seq: number;
  items: DraftItem[];
  usage: TokenUsage;
  /** 这一张失败了（超时 / 模型拒答 / 校验全挂）。其余张照常出结果 */
  error?: string;
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

/**
 * claude-sonnet-5 + effort high。
 *
 * 一次「模型 × effort」横评（Opus 5/medium、Sonnet 5/high、Sonnet 5/medium
 * 与 xAI grok-4/4-fast、DeepSeek 视觉模型）里，Sonnet 5/high 是速度赢家：
 * 单张密价目表 ~30s、方差极小，成本约 Opus 的三分之一，且强制工具调用在
 * Sonnet 5 上照常可用（schema 有保证）。Sonnet 5/medium 反而更慢、方差大，
 * 不用。grok 比 Sonnet 慢 30–70%、贵 2–3 倍且行数虚高（疑似过度拆分），
 * DeepSeek 的 pro/flash 不支持图片、唯一的视觉模型与强制工具调用冲突。
 *
 * 提取本身仍是低频高价值场景，但 ~30s 已压在 Fastify requestTimeout 上 ——
 * 所以路由改成了异步（202 + 后台任务 + 确认页轮询），换模型只是让那条
 * 后台任务更快更省。
 */
const MODEL = 'claude-sonnet-5';

const TOOL: Anthropic.Tool = {
  name: 'record_price_list',
  description:
    '把价目表照片上的每一行录进系统。只录图上真实印着的内容，' +
    '没印的字段填 0，拿不准的标 unsure。',
  // strict: true 才能保证 tool_use.input 一定符合 schema（否则模型可能少字段）。
  // 它要求 schema 全 required + additionalProperties: false —— 见 schema.ts。
  strict: true,
  // schema 用 `as const` 写死是为了让形状层的字面量不被误改；
  // SDK 的类型要的是可变对象，这里只是去掉 readonly，结构一模一样。
  input_schema: priceListToolSchema as unknown as Anthropic.Tool.InputSchema,
};

/**
 * 跑一张图。
 *
 * 两个刻意的选择：
 *
 * - **`tool_choice` 强制走工具**：不给模型「先寒暄两句再说」的余地，
 *   输出就是结构化的那一坨，没有自由文本要解析。
 * - **系统提示打 cache_control**：它逐字节稳定（含那份行业词汇表），
 *   第二张图开始就是缓存读取，0.1 倍价（05 §6.2）。
 *
 * 用 `.stream()` 而不是 `.create()`：Sonnet 5 开 adaptive 思考，密集价目表
 * 一张图可能想很久，非流式会先撞上 SDK 的 HTTP 超时。
 */
async function extractOne(
  image: PriceListImage,
  total: number,
  opts: ExtractOptions,
): Promise<{ extraction: Extraction | null; usage: TokenUsage; error?: string }> {
  const client = opts.client ?? new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 600_000,
    maxRetries: 2,
  });

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32_000,
    // 价目表提取是低频高价值场景：一次几毛钱，认错一个价格却要错一整年
    output_config: { effort: 'high' },
    system: [{
      type: 'text',
      text: PRICE_LIST_SYSTEM,
      cache_control: { type: 'ephemeral' },
    }],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
        },
        { type: 'text', text: priceListUserText(image.seq, total) },
      ],
    }],
  });

  const message = await stream.finalMessage();
  const usage: TokenUsage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
  };

  // 安全分类器拒答会返回 200 + stop_reason: refusal，content 是空的。
  // 不先看 stop_reason 就读 content[0] 会拿到 undefined 然后炸在别处。
  if (message.stop_reason === 'refusal') {
    return { extraction: null, usage, error: 'refusal' };
  }
  // 32k 还装不下 = 这张图行数多到该分块拍了，报出来让老板重拍
  if (message.stop_reason === 'max_tokens') {
    return { extraction: null, usage, error: 'too_many_rows' };
  }

  const block = message.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') {
    return { extraction: null, usage, error: 'no_tool_use' };
  }

  // 形状层已经由 strict 保证，但语义层（数值范围）只能在这里挡
  const parsed = extractionZ.safeParse(block.input);
  if (!parsed.success) {
    // 整份挂掉多半是模型把数量级搞错了（价格上限 / 行数上限）。
    // 尽量抢救：逐行过一遍，能留几行留几行。
    const salvaged = salvage(block.input);
    if (salvaged) return { extraction: salvaged, usage };
    return { extraction: null, usage, error: 'schema_rejected' };
  }
  return { extraction: parsed.data, usage };
}

/**
 * 逐行抢救。
 *
 * 38 行里有 1 行的价格是 $999,999（把电话号码读成了价格），整份丢掉
 * 意味着老板要重拍一遍整张牌 —— 而另外 37 行是好的。
 * 丢掉那一行、留下其余的，再在确认页告诉他「有 1 行没认出来」。
 */
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

  // 串行而不是并发：并发的话每一张都在写同一份系统提示的缓存，
  // 谁也读不到谁的（缓存要等第一个响应开始流式返回才可读）。
  // 串行让第 2 张开始命中缓存 —— 六张图省下的是五次全价系统提示。
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
        if (seenQuestions.has(q.question)) continue;   // 每张图都会问「时长多久」
        seenQuestions.add(q.question);
        unresolved.push(q);
      }

      perImage.push({ seq: image.seq, items, usage });
    } catch (e) {
      opts.log?.warn({ err: e, seq: image.seq }, 'price list extraction failed');
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
