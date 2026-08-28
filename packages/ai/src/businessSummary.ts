import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const businessSummarySchema = z.object({
  highlights: z.array(z.string().min(3).max(240)).min(1).max(5),
  risks: z.array(z.string().min(3).max(240)).max(5),
  actions: z.array(z.string().min(3).max(240)).min(1).max(5),
});

export type BusinessSummary = z.infer<typeof businessSummarySchema>;

const summaryTool: Anthropic.Tool = {
  name: 'record_business_summary',
  description: 'Record a concise, evidence-based business summary.',
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['highlights', 'risks', 'actions'],
    properties: {
      highlights: { type: 'array', maxItems: 5, items: { type: 'string' } },
      risks: { type: 'array', maxItems: 5, items: { type: 'string' } },
      actions: { type: 'array', maxItems: 5, items: { type: 'string' } },
    },
  },
};

export async function generateBusinessSummary(opts: {
  apiKey: string;
  facts: unknown;
  locale: string;
  client?: Anthropic;
}): Promise<{ content: BusinessSummary; model: string }> {
  const model = 'claude-sonnet-5';
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 1 });
  const message = await client.messages.create({
    model,
    max_tokens: 1_200,
    system: 'You are a salon operations analyst. Use only supplied aggregate facts. Never imply GenieFront processes customer payments, owns POS hardware, holds funds, or pays staff. Clearly distinguish recorded facts from estimates. Be concise and practical.',
    tools: [summaryTool],
    tool_choice: { type: 'tool', name: summaryTool.name },
    messages: [{
      role: 'user',
      content: `Write in locale ${opts.locale}. Analyze these aggregate store facts:\n${JSON.stringify(opts.facts)}`,
    }],
  });
  if (message.stop_reason === 'refusal') throw new Error('business_summary_refused');
  const block = message.content.find((item) => item.type === 'tool_use' && item.name === summaryTool.name);
  if (!block || block.type !== 'tool_use') throw new Error('business_summary_missing_tool_output');
  const parsed = businessSummarySchema.safeParse(block.input);
  if (!parsed.success) throw new Error('business_summary_invalid_output');
  return { content: parsed.data, model };
}
