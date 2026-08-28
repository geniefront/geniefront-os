import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { generateBusinessSummary } from './businessSummary';

function clientWith(input: unknown): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'record_business_summary', input }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    },
  } as unknown as Anthropic;
}

describe('generateBusinessSummary', () => {
  it('只接受 Claude 的结构化经营摘要', async () => {
    const result = await generateBusinessSummary({
      apiKey: 'test', locale: 'zh-Hans', facts: { tickets: 12 },
      client: clientWith({
        highlights: ['回头客占比稳定'], risks: ['退款率需要关注'], actions: ['复核退款较多的服务'],
      }),
    });
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.content.actions).toEqual(['复核退款较多的服务']);
  });

  it('拒绝字段缺失或过长的模型输出', async () => {
    await expect(generateBusinessSummary({
      apiKey: 'test', locale: 'en', facts: {},
      client: clientWith({ highlights: [], risks: [], actions: [] }),
    })).rejects.toThrow('business_summary_invalid_output');
  });
});
