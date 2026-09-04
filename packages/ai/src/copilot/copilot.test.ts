import { describe, expect, it, vi } from 'vitest';
import { askCopilot, MAX_TOOL_RESULT_CHARS } from './copilot';

const usage = { input_tokens: 1, output_tokens: 1 };

describe('askCopilot tool execution', () => {
  it('runs independent tool calls concurrently and caps oversized results', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    const started: string[] = [];
    const create = vi.fn()
      .mockResolvedValueOnce({
        usage,
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'first_lookup', input: {} },
          { type: 'tool_use', id: 'tool-2', name: 'large_lookup', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        usage,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      });

    const pending = askCopilot({
      apiKey: 'test',
      commandCatalog: 'appointment.cancel [always] {appointmentId}\n  Cancel appointment',
      snapshot: 'snapshot',
      question: 'question',
      client: { messages: { create } } as any,
      tools: [
        {
          name: 'first_lookup', description: 'first', inputSchema: { type: 'object' },
          run: async () => {
            started.push('first');
            return new Promise((resolve) => { releaseFirst = resolve; });
          },
        },
        {
          name: 'large_lookup', description: 'large', inputSchema: { type: 'object' },
          run: async () => {
            started.push('large');
            return { value: 'x'.repeat(MAX_TOOL_RESULT_CHARS + 10_000) };
          },
        },
      ],
    });

    await vi.waitFor(() => expect(started).toEqual(['first', 'large']));
    releaseFirst?.({ ok: true });
    await expect(pending).resolves.toMatchObject({ answer: 'done', rounds: 2 });

    const secondRequest = create.mock.calls[1]?.[0] as any;
    const results = secondRequest.messages.at(-1).content as Array<{ content: string }>;
    expect(results[1]?.content).toContain('结果过长');
    expect(results[1]?.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it('omits the tools field when the caller has no readable tools or allowed commands', async () => {
    const create = vi.fn().mockResolvedValue({
      usage,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'No authorized action is available.' }],
    });
    await askCopilot({
      apiKey: 'test',
      commandCatalog: '',
      snapshot: 'snapshot',
      question: 'question',
      client: { messages: { create } } as any,
      tools: [],
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools');
  });
});
