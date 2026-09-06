/**
 * 建站工单 → 三版官网文案（批 8 收尾，docs/17, 29 §12.2）。
 *
 * ## ⭐ 工单本身就是 prompt
 * voice + sections + 老板的自述拼起来直接能喂给模型。
 *
 * ## 三版，不是一版
 * 给三版风格拉开，共用同一个 system prompt 和同一份工单。
 */

import type { TokenUsage } from './cost';
import {
  LunaRuntime,
  getLunaRuntime,
  type LunaResponse,
} from './runtime/luna';
import { LUNA_MODEL, LUNA_TIMEOUTS } from './runtime/config';

const MODEL = LUNA_MODEL;

export interface BriefInput {
  shopName: string;
  businessType: string;
  voice: string | null;
  brandPrimary: string | null;
  brandAccent: string | null;
  painPoints: readonly string[];
  painFreeText: string | null;
  audience: readonly string[];
  topQuestions: readonly string[];
  sections: readonly string[];
  usp: string | null;
  tone: string | null;
  referenceSites: readonly string[];
  /** 门店真实项目（名称 + 价格 + 时长），文案里要写真的不能编 */
  services: ReadonlyArray<{ name: string; priceCents: number; durationMin: number }>;
}

export interface DraftContent {
  variantLabel: string;
  hero: { headline: string; subhead: string; cta: string };
  about: string;
  faq: Array<{ q: string; a: string }>;
  sectionCopy: Record<string, string>;
}

const SYSTEM = `你在给一家美国的亚裔服务业门店（美甲/按摩/足疗/头疗/美睫）写官网文案。

硬规则：
1. **项目名称和价格必须原样使用给定的数据，一个字都不许改、不许编。**
   编一个店里没有的项目，客人会照着它上门。
2. 首屏必须有一个明确的行动：预约、打电话、或者两者。不要写「欢迎光临」这种什么都没说的话。
3. **不承诺疗效。** 「缓解疲劳」可以，「治疗颈椎病」不行 —— 那是医疗宣称。
4. 如果客群里有老年人，句子要短、电话号要显眼。
   如果客群里有华人社区，首屏给中英双语。
   如果客群里有保险客人，明确写出接受哪几种支付。
5. FAQ 直接回答给定的那几个问题。**那几个问题是从这家店真实的来电里挖出来的**，
   不要替换成你觉得更常见的。

输出严格的 JSON，格式形如：
{
  "drafts": [
    {
      "variantLabel": "稳妥版",
      "hero": { "headline": "...", "subhead": "...", "cta": "..." },
      "about": "...",
      "faq": [{ "q": "...", "a": "..." }],
      "sectionCopy": { "services": "...", "contact": "..." }
    }
  ]
}
不要有任何解释文字。`;

export interface GenerateResult {
  drafts: Array<{ variant: number; content: DraftContent }>;
  usage: TokenUsage;
  model: string;
}

export async function generateStorefrontDrafts(
  brief: BriefInput,
  opts: { apiKey?: string; client?: any; runtime?: LunaRuntime; timeoutMs?: number } = {},
): Promise<GenerateResult> {
  // 兼容旧版测试 client
  if (opts.client && typeof opts.client.messages?.stream === 'function') {
    const stream = opts.client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 16_000,
      system: [{ type: 'text', text: SYSTEM }],
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt(brief) }] }],
    });
    const message = await stream.finalMessage();
    const usage: TokenUsage = {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      cacheReadInputTokens: message.usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage?.cache_creation_input_tokens ?? 0,
    };
    if (message.stop_reason === 'refusal') {
      return { drafts: [], usage, model: 'claude-sonnet-5' };
    }
    const text = message.content.find((c: any) => c.type === 'text');
    const drafts = text?.type === 'text' ? parseDrafts(text.text) : [];
    return { drafts, usage, model: 'claude-sonnet-5' };
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());
  const response: LunaResponse = await runtime.invoke({
    instructions: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(brief) }],
    effort: 'low',
    maxOutputTokens: 8_000,
    timeoutMs: opts.timeoutMs ?? LUNA_TIMEOUTS.DEFAULT_MS,
  });

  const usage: TokenUsage = {
    inputTokens: response.usage.uncachedInputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadInputTokens: response.usage.cachedReadInputTokens,
    cacheCreationInputTokens: 0,
  };

  if (response.status === 'refusal') {
    return { drafts: [], usage, model: MODEL };
  }

  const drafts = parseDrafts(response.text);
  return { drafts, usage, model: MODEL };
}

/**
 * 解析模型返回的 JSON。
 */
function parseDrafts(raw: string): Array<{ variant: number; content: DraftContent }> {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as { drafts?: unknown };
    const list = Array.isArray(parsed.drafts) ? parsed.drafts : [];
    return list.slice(0, 3).map((c, i) => ({ variant: i + 1, content: c as DraftContent }));
  } catch {
    return [];
  }
}

function userPrompt(b: BriefInput): string {
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  return [
    `店名：${b.shopName}`,
    `业态：${b.businessType}`,
    b.voice ? `调性：${b.voice}` : '',
    b.brandPrimary ? `主色：${b.brandPrimary}${b.brandAccent ? ` / 辅色：${b.brandAccent}` : ''}` : '',
    '',
    b.usp ? `老板说的卖点：${b.usp}` : '',
    b.tone ? `想传达的感觉：${b.tone}` : '',
    '',
    b.audience.length ? `客群：${b.audience.join('、')}` : '',
    b.topQuestions.length
      ? `⭐ 客人打电话最常问（FAQ 必须逐条回答这些）：\n${b.topQuestions.map((q) => `  · ${q}`).join('\n')}`
      : '',
    '',
    b.painPoints.length ? `现在这个网站的毛病：${b.painPoints.join('、')}` : '',
    b.painFreeText ? `老板的原话：${b.painFreeText}` : '',
    '',
    b.sections.length ? `老板勾选要放的板块：${b.sections.join('、')}` : '',
    b.referenceSites.length ? `老板喜欢的参考站：${b.referenceSites.join('、')}` : '',
    '',
    '门店真实项目（照这些写，别编新的）：',
    ...b.services.map((s) => `  · ${s.name}：${money(s.priceCents)}（${s.durationMin} 分钟）`),
  ].filter(Boolean).join('\n');
}
