import { z } from 'zod';
import type { TokenUsage } from './cost';
import {
  LunaRuntime,
  getLunaRuntime,
  type LunaTool,
  type LunaResponse,
} from './runtime/luna';
import { LUNA_MODEL, LUNA_TIMEOUTS } from './runtime/config';

const text5 = z.object({
  'zh-Hans': z.string().min(1).max(500),
  en: z.string().min(1).max(500),
  ko: z.string().min(1).max(500),
  es: z.string().min(1).max(500),
  vi: z.string().min(1).max(500),
});

export const generatedHealthQuestionSchema = z.object({
  id: z.string().regex(/^q_[a-z0-9_]+$/).max(40),
  type: z.enum(['bool', 'text', 'choice', 'multi']),
  label: text5,
  options: z.array(z.object({ value: z.string().min(1).max(40), label: text5 })).max(12).optional(),
  required: z.boolean(),
  hidden: z.literal(false).default(false),
  sync: z.enum(['avoid_areas', 'health_flag']).optional(),
}).superRefine((question, ctx) => {
  if ((question.type === 'choice' || question.type === 'multi') && !question.options?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'selection_options_required' });
  }
});

const outputSchema = z.object({ questions: z.array(generatedHealthQuestionSchema).min(1).max(8) });
export type GeneratedHealthQuestion = z.infer<typeof generatedHealthQuestionSchema>;

const tool: LunaTool = {
  name: 'return_health_form_questions',
  description: 'Return safe, concise, multilingual client intake questions.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 8,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'type', 'label', 'required', 'hidden'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['bool', 'text', 'choice', 'multi'] },
            label: multilingualSchema(),
            options: {
              type: 'array', maxItems: 12,
              items: {
                type: 'object', additionalProperties: false, required: ['value', 'label'],
                properties: { value: { type: 'string' }, label: multilingualSchema() },
              },
            },
            required: { type: 'boolean' },
            hidden: { type: 'boolean', enum: [false] },
            sync: { type: 'string', enum: ['avoid_areas', 'health_flag'] },
          },
        },
      },
    },
  },
  strict: true,
};

function multilingualSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    required: ['zh-Hans', 'en', 'ko', 'es', 'vi'],
    properties: {
      'zh-Hans': { type: 'string' }, en: { type: 'string' }, ko: { type: 'string' },
      es: { type: 'string' }, vi: { type: 'string' },
    },
  };
}

export async function generateHealthFormQuestions(input: {
  prompt: string;
  actionType: string;
  templateTitle: unknown;
  existingQuestions: unknown[];
}, opts: { apiKey?: string; runtime?: LunaRuntime; client?: any } = {}): Promise<{
  questions: GeneratedHealthQuestion[];
  usage: TokenUsage;
  model: string;
}> {
  const model = LUNA_MODEL;

  // 兼容旧版测试 client mock
  if (opts.client && typeof opts.client.messages?.create === 'function') {
    const message = await opts.client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4_000,
      system: [
        { type: 'text', text: 'You design health intake forms for US salon, spa, massage, nail, facial, lash, and scalp-care businesses. Use plain non-diagnostic language. Do not claim legal validity, medical diagnosis, or treatment. Ask only information needed for service safety, contraindications, allergies, consent, or preferences. Produce complete Simplified Chinese, English, Korean, Spanish, and Vietnamese text. IDs and option values must be lowercase ASCII snake_case. For a positive yes/no contraindication use sync=health_flag. Never include customer answers or personal data.' },
      ],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{
        role: 'user',
        content: `Action: ${input.actionType}\nRequest: ${input.prompt}\nTemplate title: ${JSON.stringify(input.templateTitle)}\nExisting questions (avoid duplicates): ${JSON.stringify(input.existingQuestions).slice(0, 20_000)}`,
      }],
    });
    if (message.stop_reason === 'refusal') throw new Error('health_form_generation_refused');
    const block = message.content.find((item: any) => item.type === 'tool_use' && item.name === tool.name);
    if (!block || block.type !== 'tool_use') throw new Error('health_form_generation_missing_output');
    const parsed = outputSchema.safeParse(block.input);
    if (!parsed.success) throw new Error('health_form_generation_invalid_output');
    return {
      questions: parsed.data.questions,
      model: 'claude-sonnet-5',
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        cacheReadInputTokens: message.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());
  const response: LunaResponse = await runtime.invoke({
    instructions: 'You design health intake forms for US salon, spa, massage, nail, facial, lash, and scalp-care businesses. Use plain non-diagnostic language. Do not claim legal validity, medical diagnosis, or treatment. Ask only information needed for service safety, contraindications, allergies, consent, or preferences. Produce complete Simplified Chinese, English, Korean, Spanish, and Vietnamese text. IDs and option values must be lowercase ASCII snake_case. For a positive yes/no contraindication use sync=health_flag. Never include customer answers or personal data.',
    messages: [{
      role: 'user',
      content: `Action: ${input.actionType}\nRequest: ${input.prompt}\nTemplate title: ${JSON.stringify(input.templateTitle)}\nExisting questions (avoid duplicates): ${JSON.stringify(input.existingQuestions).slice(0, 20_000)}`,
    }],
    tools: [tool],
    toolChoice: { type: 'function', name: tool.name },
    effort: 'low',
    maxOutputTokens: 4_000,
    timeoutMs: LUNA_TIMEOUTS.FAST_MS,
  });

  if (response.status === 'refusal') throw new Error('health_form_generation_refused');
  const toolCall = response.toolCalls.find((item) => item.name === tool.name);
  if (!toolCall) throw new Error('health_form_generation_missing_output');
  const parsed = outputSchema.safeParse(toolCall.arguments);
  if (!parsed.success) throw new Error('health_form_generation_invalid_output');

  return {
    questions: parsed.data.questions,
    model,
    usage: {
      inputTokens: response.usage.uncachedInputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadInputTokens: response.usage.cachedReadInputTokens,
      cacheCreationInputTokens: 0,
    },
  };
}
