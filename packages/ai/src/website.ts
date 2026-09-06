import { z } from 'zod';
import type { DraftItem } from './normalize.js';
import type { TokenUsage } from './cost.js';
import {
  LunaRuntime,
  getLunaRuntime,
  type LunaTool,
  type LunaResponse,
} from './runtime/luna.js';
import { LUNA_MODEL, LUNA_TIMEOUTS } from './runtime/config.js';

const websiteZ = z.object({
  location: z.object({
    name: z.string(), phone: z.string(), email: z.string(),
    addressStreet: z.string(), addressCity: z.string(), addressState: z.string(), addressZip: z.string(),
    businessType: z.enum(['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed']),
    businessHours: z.record(z.object({ open: z.string(), close: z.string() }).nullable()),
    socialLinks: z.array(z.string()),
  }),
  services: z.array(z.object({
    name: z.string(), category: z.string(), durationMin: z.number().int(),
    priceCents: z.number().int(), isAddon: z.boolean(), confidenceBp: z.number().int(),
  })).max(300),
  staff: z.array(z.object({ name: z.string(), role: z.string() })).max(80),
  unresolved: z.array(z.object({ field: z.string(), question: z.string() })).max(30),
});

const inputSchema = {
  type: 'object', additionalProperties: false, required: ['location', 'services', 'staff', 'unresolved'],
  properties: {
    location: { type: 'object', additionalProperties: false,
      required: ['name', 'phone', 'email', 'addressStreet', 'addressCity', 'addressState', 'addressZip', 'businessType', 'businessHours', 'socialLinks'],
      properties: {
        name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, addressStreet: { type: 'string' },
        addressCity: { type: 'string' }, addressState: { type: 'string' }, addressZip: { type: 'string' },
        businessType: { type: 'string', enum: ['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed'] },
        businessHours: { type: 'object', additionalProperties: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['open', 'close'], properties: { open: { type: 'string' }, close: { type: 'string' } } }] } },
        socialLinks: { type: 'array', items: { type: 'string' } },
      } },
    services: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'category', 'durationMin', 'priceCents', 'isAddon', 'confidenceBp'], properties: { name: { type: 'string' }, category: { type: 'string' }, durationMin: { type: 'integer' }, priceCents: { type: 'integer' }, isAddon: { type: 'boolean' }, confidenceBp: { type: 'integer' } } } },
    staff: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'role'], properties: { name: { type: 'string' }, role: { type: 'string' } } } },
    unresolved: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'question'], properties: { field: { type: 'string' }, question: { type: 'string' } } } },
  },
} as const;

const tool: LunaTool = {
  name: 'record_business_website',
  description: 'Record business identity, services, staff and unresolved questions.',
  parameters: inputSchema as unknown as Record<string, unknown>,
  strict: true,
};

export interface WebsitePage { url: string; text: string }
export interface WebsiteExtractionResult {
  locationProposal: z.infer<typeof websiteZ>['location'] & { staff: Array<{ name: string; role: string }> };
  items: DraftItem[]; unresolved: Array<{ field: string; question: string }>;
  usage: TokenUsage; model: string;
}

export async function extractWebsite(
  pages: WebsitePage[],
  opts: { apiKey?: string; locale?: string; runtime?: LunaRuntime; client?: any },
): Promise<WebsiteExtractionResult> {
  const model = LUNA_MODEL;
  const content = pages.map((p) => `\n--- PAGE ${p.url} ---\n${p.text}`).join('').slice(0, 180_000);

  if (opts.client && typeof opts.client.messages?.create === 'function') {
    const response = await opts.client.messages.create({
      model: 'claude-sonnet-5', max_tokens: 24_000,
      system: 'Extract only facts explicitly present on this business website. Never invent prices, durations, staff, hours, or contact information. Use empty strings or arrays for missing values. Prices are integer cents; unknown prices or durations are 0. confidenceBp is 0-10000. Normalize weekly hour keys to mon,tue,wed,thu,fri,sat,sun and HH:MM. Record uncertainties as questions.',
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_business_website' },
      messages: [{ role: 'user', content: `Preferred language: ${opts.locale ?? 'en'}\n${content}` }],
    });
    const block = response.content.find((part: any) => part.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('website_no_tool_use');
    const parsed = websiteZ.parse(block.input);
    const items: DraftItem[] = parsed.services.filter((s) => s.name.trim()).map((s) => ({
      kind: s.isAddon ? 'addon' : 'service', name: { [opts.locale ?? 'en']: s.name.trim() }, category: s.category.trim() || null,
      durationMin: s.durationMin > 0 ? Math.min(s.durationMin, 600) : null,
      priceCents: s.priceCents > 0 ? Math.min(s.priceCents, 500_000) : null, priceIsFrom: false, variants: [],
      confidenceBp: Math.max(0, Math.min(s.confidenceBp, 10000)), sourceSeq: 0, bbox: null,
    }));
    return {
      locationProposal: { ...parsed.location, staff: parsed.staff }, items, unresolved: parsed.unresolved, model: 'claude-sonnet-5',
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0, cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0 },
    };
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());
  const response: LunaResponse = await runtime.invoke({
    instructions: 'Extract only facts explicitly present on this business website. Never invent prices, durations, staff, hours, or contact information. Use empty strings or arrays for missing values. Prices are integer cents; unknown prices or durations are 0. confidenceBp is 0-10000. Normalize weekly hour keys to mon,tue,wed,thu,fri,sat,sun and HH:MM. Record uncertainties as questions.',
    messages: [{ role: 'user', content: `Preferred language: ${opts.locale ?? 'en'}\n${content}` }],
    tools: [tool],
    toolChoice: { type: 'function', name: 'record_business_website' },
    effort: 'low',
    maxOutputTokens: 16_000,
    timeoutMs: LUNA_TIMEOUTS.VISION_MS,
  });

  const toolCall = response.toolCalls.find((part) => part.name === 'record_business_website');
  if (!toolCall) throw new Error('website_no_tool_use');
  const parsed = websiteZ.parse(toolCall.arguments);
  const items: DraftItem[] = parsed.services.filter((s) => s.name.trim()).map((s) => ({
    kind: s.isAddon ? 'addon' : 'service', name: { [opts.locale ?? 'en']: s.name.trim() }, category: s.category.trim() || null,
    durationMin: s.durationMin > 0 ? Math.min(s.durationMin, 600) : null,
    priceCents: s.priceCents > 0 ? Math.min(s.priceCents, 500_000) : null, priceIsFrom: false, variants: [],
    confidenceBp: Math.max(0, Math.min(s.confidenceBp, 10000)), sourceSeq: 0, bbox: null,
  }));
  return {
    locationProposal: { ...parsed.location, staff: parsed.staff }, items, unresolved: parsed.unresolved, model,
    usage: {
      inputTokens: response.usage.uncachedInputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadInputTokens: response.usage.cachedReadInputTokens,
      cacheCreationInputTokens: 0,
    },
  };
}
