/**
 * 建站工单 → 三版官网文案（批 8 收尾，docs/17）。
 *
 * ## ⭐ 工单本身就是 prompt
 *
 * 这是不做网站编辑器的全部理由：voice + sections + 老板的自述
 * 拼起来直接能喂给模型。竞品靠人做要 7 天，我们出初稿只要一次调用。
 *
 * ## 三版，不是一版
 *
 * 给一版的话，老板只能说「不喜欢」而说不出哪里不喜欢 —— 然后我们
 * 只能猜。给三版**风格拉开**，他一定选得出一个，而他的选择本身
 * 就是最精确的反馈。三版共用同一个 system prompt 和同一份工单，
 * 差别只在温度和一句风格指令。
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from './cost';

const MODEL = 'claude-sonnet-5';

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

输出严格的 JSON，不要有任何解释文字。`;

const VARIANT_HINTS = [
  '稳妥版：贴着老板给的调性写，不发挥。',
  '锐利版：把最强的那一条卖点顶到首屏第一句，其余全部让路。',
  '温度版：多用第二人称和具体场景（下班后、逛完街），少用形容词。',
] as const;

export interface GenerateResult {
  drafts: Array<{ variant: number; content: DraftContent }>;
  usage: TokenUsage;
  model: string;
}

/**
 * @param opts.client 测试用的替身。⚠️ 有它就**不建真客户端** ——
 *   忘了这个参数的话单测会真的打 Anthropic，而 CI 上没有 key。
 */
export async function generateStorefrontDrafts(
  brief: BriefInput,
  opts: { apiKey?: string; client?: Pick<Anthropic, 'messages'>; timeoutMs?: number } = {},
): Promise<GenerateResult> {
  const client = opts.client ?? new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 300_000,
    maxRetries: 2,
  });

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16_000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt(brief) }] }],
  });

  const message = await stream.finalMessage();
  const usage: TokenUsage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
  };

  // 安全分类器拒答返回 200 + stop_reason: refusal，content 是空的
  if (message.stop_reason === 'refusal') {
    return { drafts: [], usage, model: MODEL };
  }

  const text = message.content.find((c) => c.type === 'text');
  const drafts = text?.type === 'text' ? parseDrafts(text.text) : [];
  return { drafts, usage, model: MODEL };
}

/**
 * 解析模型返回的 JSON。
 *
 * ⚠️ **解析失败返回空数组，不抛异常。** 调用方看到 0 版会落一条
 * 「生成失败，人工接手」的记录 —— 而抛异常会让老板看到一个 500，
 * 他以为是自己的工单填错了。
 */
function parseDrafts(raw: string): Array<{ variant: number; content: DraftContent }> {
  try {
    // 模型偶尔会用 ```json 包起来 —— 剥掉再解析
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
    b.referenceSites.length ? `他喜欢的站：${b.referenceSites.join('、')}` : '',
    '',
    `要出的区块：${b.sections.join('、')}`,
    '',
    '⚠️ 真实项目（名称和价格原样用，不许改不许编）：',
    ...b.services.map((s) => `  · ${s.name} — ${money(s.priceCents)} / ${s.durationMin} 分钟`),
    '',
    '出三版，风格分别是：',
    ...VARIANT_HINTS.map((h, i) => `  ${i + 1}. ${h}`),
    '',
    '输出 JSON：',
    '{"drafts":[{"variantLabel":"…","hero":{"headline":"…","subhead":"…","cta":"…"},',
    '"about":"…","faq":[{"q":"…","a":"…"}],"sectionCopy":{"services":"…","contact":"…"}}]}',
  ].filter(Boolean).join('\n');
}
