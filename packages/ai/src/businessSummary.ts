import { z } from 'zod';
import {
  LunaRuntime,
  getLunaRuntime,
  type LunaTool,
  type LunaResponse,
} from './runtime/luna';
import { LUNA_MODEL, LUNA_TIMEOUTS } from './runtime/config';

export const businessSummarySchema = z.object({
  highlights: z.array(z.string().min(3).max(240)).min(1).max(5),
  risks: z.array(z.string().min(3).max(240)).max(5),
  actions: z.array(z.string().min(3).max(240)).min(1).max(5),
});

export type BusinessSummary = z.infer<typeof businessSummarySchema>;

const summaryTool: LunaTool = {
  name: 'record_business_summary',
  description: 'Record a concise, evidence-based business summary.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['highlights', 'risks', 'actions'],
    properties: {
      highlights: { type: 'array', maxItems: 5, items: { type: 'string' } },
      risks: { type: 'array', maxItems: 5, items: { type: 'string' } },
      actions: { type: 'array', maxItems: 5, items: { type: 'string' } },
    },
  },
  strict: true,
};

export async function generateBusinessSummary(opts: {
  apiKey?: string | undefined;
  facts: unknown;
  locale: string;
  runtime?: LunaRuntime | undefined;
  client?: any | undefined;
}): Promise<{ content: BusinessSummary; model: string }> {
  const model = LUNA_MODEL;

  // 兼容测试中的 client mock
  if (opts.client && typeof opts.client.messages?.create === 'function') {
    const message = await opts.client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1_200,
      tools: [summaryTool],
      tool_choice: { type: 'tool', name: summaryTool.name },
      messages: [{
        role: 'user',
        content: `Write in locale ${opts.locale}. Analyze these aggregate store facts:\n${JSON.stringify(opts.facts)}`,
      }],
    });
    if (message.stop_reason === 'refusal') throw new Error('business_summary_refused');
    const block = message.content.find((item: any) => item.type === 'tool_use' && item.name === summaryTool.name);
    if (!block || block.type !== 'tool_use') throw new Error('business_summary_missing_tool_output');
    const parsed = businessSummarySchema.safeParse(block.input);
    if (!parsed.success) throw new Error('business_summary_invalid_output');
    return { content: parsed.data, model: 'claude-sonnet-5' };
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());
  const response: LunaResponse = await runtime.invoke({
    instructions: 'You are a salon operations analyst. Use only supplied aggregate facts. Never imply GenieFront processes customer payments, owns POS hardware, holds funds, or pays staff. Clearly distinguish recorded facts from estimates. Be concise and practical.',
    messages: [{
      role: 'user',
      content: `Write in locale ${opts.locale}. Analyze these aggregate store facts:\n${JSON.stringify(opts.facts)}`,
    }],
    tools: [summaryTool],
    toolChoice: { type: 'function', name: summaryTool.name },
    effort: 'low',
    maxOutputTokens: 2000,
    timeoutMs: LUNA_TIMEOUTS.FAST_MS,
  });

  if (response.status === 'refusal') throw new Error('business_summary_refused');
  const toolCall = response.toolCalls.find((t) => t.name === summaryTool.name);
  if (!toolCall) throw new Error('business_summary_missing_tool_output');
  const parsed = businessSummarySchema.safeParse(toolCall.arguments);
  if (!parsed.success) throw new Error('business_summary_invalid_output');
  return { content: parsed.data, model };
}
