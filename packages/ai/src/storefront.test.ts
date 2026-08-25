import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { generateStorefrontDrafts, type BriefInput } from './storefront';

/** 替身客户端的类型 —— 只要 messages 那一块 */
type FakeClient = Pick<Anthropic, 'messages'>;

const brief: BriefInput = {
  shopName: 'Lotus Spa',
  businessType: 'massage',
  voice: 'warm',
  brandPrimary: '#2E4A3D',
  brandAccent: null,
  painPoints: ['slow', 'no_booking_entry'],
  painFreeText: '现在这个手机上根本没法用',
  audience: ['seniors', 'chinese_community'],
  topQuestions: ['门口能停车吗', '收不收现金', '有会说中文的师傅吗'],
  sections: ['hero', 'services', 'faq', 'contact'],
  usp: '三十年临床经验，只做深层',
  tone: '走进来时间就慢下来',
  referenceSites: ['aesop.com'],
  services: [
    { name: 'Deep Tissue 60min', priceCents: 8000, durationMin: 60 },
    { name: 'Foot Reflexology', priceCents: 4500, durationMin: 45 },
  ],
};

/** 假客户端 —— ⚠️ 不给它的话单测会真的打 Anthropic，而 CI 上没有 key */
function fakeClient(text: string, stopReason = 'end_turn') {
  return {
    messages: {
      stream: () => ({
        finalMessage: async () => ({
          content: [{ type: 'text' as const, text }],
          stop_reason: stopReason,
          usage: {
            input_tokens: 1200, output_tokens: 900,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          },
        }),
      }),
    },
  } as unknown as FakeClient;
}

const threeDrafts = JSON.stringify({
  drafts: [1, 2, 3].map((i) => ({
    variantLabel: `v${i}`,
    hero: { headline: `H${i}`, subhead: `S${i}`, cta: '立即预约' },
    about: `about ${i}`,
    faq: [{ q: '门口能停车吗', a: '门前有免费车位' }],
    sectionCopy: { services: 'x', contact: 'y' },
  })),
});

describe('建站工单生成', () => {
  it('正常返回三版，并带回 token 用量', async () => {
    const out = await generateStorefrontDrafts(brief, { client: fakeClient(threeDrafts) });
    expect(out.drafts).toHaveLength(3);
    expect(out.drafts[0]!.variant).toBe(1);
    expect(out.drafts[2]!.content.hero.headline).toBe('H3');
    expect(out.usage.inputTokens).toBe(1200);
  });

  it('模型用 ```json 包起来也认', async () => {
    const out = await generateStorefrontDrafts(brief,
      { client: fakeClient('```json\n' + threeDrafts + '\n```') });
    expect(out.drafts).toHaveLength(3);
  });

  it('⭐ 解析失败返回空数组不抛异常 —— 抛的话老板看到 500，以为是自己填错了', async () => {
    const out = await generateStorefrontDrafts(brief, { client: fakeClient('我觉得应该这样写……') });
    expect(out.drafts).toEqual([]);
    // ⚠️ 用量还是要记 —— 那几毛钱已经花掉了
    expect(out.usage.outputTokens).toBe(900);
  });

  it('⭐ 安全分类器拒答（stop_reason: refusal）不当成解析失败', async () => {
    const out = await generateStorefrontDrafts(brief, { client: fakeClient('', 'refusal') });
    expect(out.drafts).toEqual([]);
  });

  it('多于三版只取前三 —— 界面上只摆得下三个', async () => {
    const six = JSON.stringify({ drafts: Array.from({ length: 6 }, (_, i) => ({ variantLabel: `v${i}` })) });
    const out = await generateStorefrontDrafts(brief, { client: fakeClient(six) });
    expect(out.drafts).toHaveLength(3);
  });
});

describe('prompt 里必须出现的东西', () => {
  /** 抓住真正送出去的那段文本 */
  async function capture(b: BriefInput): Promise<string> {
    let sent = '';
    const client = {
      messages: {
        stream: (req: { messages: Array<{ content: Array<{ text: string }> }> }) => {
          sent = req.messages[0]!.content[0]!.text;
          return {
            finalMessage: async () => ({
              content: [{ type: 'text' as const, text: threeDrafts }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          };
        },
      },
    } as unknown as FakeClient;
    await generateStorefrontDrafts(b, { client });
    return sent;
  }

  it('⭐ 真实项目名和价格原样进 prompt —— 不给真数据它只能编', async () => {
    const sent = await capture(brief);
    expect(sent).toContain('Deep Tissue 60min');
    expect(sent).toContain('$80.00');
    expect(sent).toContain('45 分钟');
  });

  it('⭐ 客人最常问的三件事逐条进 prompt', async () => {
    const sent = await capture(brief);
    for (const q of brief.topQuestions) expect(sent).toContain(q);
  });

  it('客群进 prompt —— 首屏说什么全靠它', async () => {
    const sent = await capture(brief);
    expect(sent).toContain('seniors');
    expect(sent).toContain('chinese_community');
  });

  it('字段为空时不留空行占位', async () => {
    const sent = await capture({ ...brief, usp: null, tone: null, referenceSites: [] });
    expect(sent).not.toContain('老板说的卖点：\n');
    expect(sent).not.toContain('他喜欢的站：\n');
  });
});
