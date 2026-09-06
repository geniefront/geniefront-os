/**
 * Luna 统一运行时封装 (29 §4.2, §5.1)
 *
 * 基于官方 openai SDK 接入 gpt-5.6-luna，支持：
 * 1. Responses API 与标准工具调用；
 * 2. 异常分类归一化 (refusal, context_length, rate_limit, timeout, cancelled)；
 * 3. 流式文本与函数调用事件解析；
 * 4. NormalizedUsage 统一转换。
 */

import OpenAI from 'openai';
import {
  LUNA_MODEL,
  LUNA_DEFAULT_EFFORT,
  LUNA_TIMEOUTS,
  LUNA_MAX_OUTPUT_TOKENS,
  type LunaEffort,
} from './config.js';
import { normalizeOpenAiUsage, type NormalizedUsage } from './usage.js';

export interface LunaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean | undefined;
}

export interface LunaToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

export interface LunaToolOutput {
  callId: string;
  output: string;
}

export interface LunaContentPartText {
  type: 'text';
  text: string;
}

export interface LunaContentPartImage {
  type: 'image';
  base64: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined;
}

export type LunaContentPart = LunaContentPartText | LunaContentPartImage;

export interface LunaMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | LunaContentPart[] | undefined;
  toolCalls?: LunaToolCall[] | undefined;
  callId?: string | undefined;
  name?: string | undefined;
}

export interface LunaInvokeOptions {
  instructions?: string | undefined;
  messages: LunaMessage[];
  tools?: LunaTool[] | undefined;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string } | undefined;
  effort?: LunaEffort | undefined;
  maxOutputTokens?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onDelta?: ((text: string) => void) | undefined;
  onReasoningDelta?: ((thought: string) => void) | undefined;
  onToolCallStart?: ((name: string, callId: string) => void) | undefined;
}

export interface LunaResponse {
  text: string;
  toolCalls: LunaToolCall[];
  usage: NormalizedUsage;
  status: 'completed' | 'refusal' | 'incomplete';
  model: string;
}

/** 错误类型分类 */
export type LunaErrorKind =
  | 'refusal'
  | 'context_length_exceeded'
  | 'rate_limit_exceeded'
  | 'upstream_timeout'
  | 'cancelled'
  | 'upstream_error';

export class LunaRuntimeError extends Error {
  readonly kind: LunaErrorKind;
  readonly status?: number | undefined;
  override readonly cause?: unknown;

  constructor(
    kind: LunaErrorKind,
    message: string,
    opts?: { status?: number | undefined; cause?: unknown },
  ) {
    super(message);
    this.name = 'LunaRuntimeError';
    this.kind = kind;
    this.status = opts?.status;
    this.cause = opts?.cause;
  }
}

/**
 * 统一将上游异常转译为标准化的 LunaRuntimeError
 */
export function normalizeLunaError(err: unknown): LunaRuntimeError {
  if (err instanceof LunaRuntimeError) return err;

  const anyErr = err as any;
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
  const message = String(anyErr?.message || anyErr || 'Unknown Luna runtime error');

  if (anyErr?.name === 'AbortError' || message.includes('aborted') || message.includes('cancelled')) {
    return new LunaRuntimeError('cancelled', 'Request was cancelled', { status, cause: err });
  }

  if (status === 429 || message.includes('rate_limit') || message.includes('Rate limit')) {
    return new LunaRuntimeError('rate_limit_exceeded', `Luna rate limit exceeded: ${message}`, {
      status: 429,
      cause: err,
    });
  }

  if (
    status === 504 ||
    status === 408 ||
    message.includes('timeout') ||
    message.includes('ETIMEDOUT') ||
    message.includes('timed out')
  ) {
    return new LunaRuntimeError('upstream_timeout', `Luna upstream timeout: ${message}`, {
      status: status ?? 504,
      cause: err,
    });
  }

  if (
    message.includes('context_length') ||
    message.includes('maximum context length') ||
    message.includes('too many tokens')
  ) {
    return new LunaRuntimeError('context_length_exceeded', `Luna context length exceeded: ${message}`, {
      status: 400,
      cause: err,
    });
  }

  if (message.includes('refusal') || message.includes('safety policy')) {
    return new LunaRuntimeError('refusal', `Luna model refused request: ${message}`, {
      status,
      cause: err,
    });
  }

  return new LunaRuntimeError('upstream_error', message, { status, cause: err });
}

export class LunaRuntime {
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY || '';
    const base = baseURL || process.env.OPENAI_BASE_URL;
    this.client = new OpenAI({
      apiKey: key,
      baseURL: base || undefined,
      timeout: LUNA_TIMEOUTS.DEFAULT_MS,
      maxRetries: 1,
    });
  }

  /**
   * 将系统提示词与 Luna 统一消息列表映射为 Responses API 所需的 input items
   */
  private formatResponsesInput(messages: LunaMessage[]): any[] {
    const items: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          items.push({
            role: 'user',
            content: [{ type: 'input_text', text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          const content = msg.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'input_text', text: part.text };
            }
            if (part.type === 'image') {
              const mime = part.mediaType || 'image/jpeg';
              return {
                type: 'input_image',
                image_url: `data:${mime};base64,${part.base64}`,
                detail: 'high',
              };
            }
            return { type: 'input_text', text: '' };
          });
          items.push({ role: 'user', content });
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            items.push({
              type: 'function_call',
              call_id: tc.callId,
              name: tc.name,
              arguments: tc.rawArguments || JSON.stringify(tc.arguments),
            });
          }
        }
        if (msg.content && typeof msg.content === 'string') {
          items.push({
            role: 'assistant',
            content: [{ type: 'output_text', text: msg.content }],
          });
        }
      } else if (msg.role === 'tool') {
        items.push({
          type: 'function_call_output',
          call_id: msg.callId,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? {}),
        });
      }
    }

    return items;
  }

  /**
   * 格式化工具列表为 Responses API 结构
   */
  private formatTools(tools?: LunaTool[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: t.strict ?? true,
    }));
  }

  /**
   * 格式化 tool_choice
   */
  private formatToolChoice(choice?: LunaInvokeOptions['toolChoice']): any {
    if (!choice) return undefined;
    if (typeof choice === 'string') return choice;
    return { type: 'function', name: choice.name };
  }

  /**
   * 调用 Luna 模型，支持流式解析与双轨收集
   */
  async invoke(opts: LunaInvokeOptions): Promise<LunaResponse> {
    try {
      const tools = this.formatTools(opts.tools);
      const input = this.formatResponsesInput(opts.messages);
      const effort = opts.effort ?? LUNA_DEFAULT_EFFORT;
      const maxOutputTokens = opts.maxOutputTokens ?? LUNA_MAX_OUTPUT_TOKENS.COPILOT;
      const timeoutMs = opts.timeoutMs ?? LUNA_TIMEOUTS.DEFAULT_MS;

      const requestBody: any = {
        model: LUNA_MODEL,
        reasoning: { effort },
        max_output_tokens: maxOutputTokens,
        store: false,
        stream: true,
        instructions: opts.instructions,
        input,
        tools,
        tool_choice: this.formatToolChoice(opts.toolChoice),
        parallel_tool_calls: false,
      };

      const responseStream = await this.client.responses.create(
        requestBody,
        {
          timeout: timeoutMs,
          signal: opts.signal,
        },
      );

      const stream = (responseStream as unknown) as AsyncIterable<any>;

      let fullText = '';
      const toolCallsMap = new Map<string, { name: string; argsText: string }>();
      let rawResponse: any = null;

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta ?? '';
          fullText += delta;
          opts.onDelta?.(delta);
        } else if (event.type === 'response.function_call_arguments.delta') {
          const callId = event.call_id || event.item_id || 'default';
          const prev = toolCallsMap.get(callId) || { name: event.name || '', argsText: '' };
          if (event.name && !prev.name) {
            prev.name = event.name;
            opts.onToolCallStart?.(event.name, callId);
          }
          prev.argsText += event.delta ?? '';
          toolCallsMap.set(callId, prev);
        } else if (event.type === 'response.output_item.added') {
          if (event.item?.type === 'function_call') {
            const callId = event.item.call_id || event.item.id;
            const name = event.item.name || '';
            toolCallsMap.set(callId, { name, argsText: '' });
            opts.onToolCallStart?.(name, callId);
          }
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
          rawResponse = event.response;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Stream error from Luna');
        }
      }

      // 若未在完成事件中截获，尝试从 rawResponse.output 中提取
      const toolCalls: LunaToolCall[] = [];
      if (rawResponse?.output && Array.isArray(rawResponse.output)) {
        for (const item of rawResponse.output) {
          if (item.type === 'function_call') {
            const callId = item.call_id || item.id || `call_${toolCalls.length}`;
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(item.arguments || '{}');
            } catch {
              parsedArgs = {};
            }
            toolCalls.push({
              callId,
              name: item.name,
              arguments: parsedArgs,
              rawArguments: item.arguments || '{}',
            });
          }
        }
      } else {
        for (const [callId, info] of toolCallsMap.entries()) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(info.argsText || '{}');
          } catch {
            parsedArgs = {};
          }
          toolCalls.push({
            callId,
            name: info.name,
            arguments: parsedArgs,
            rawArguments: info.argsText || '{}',
          });
        }
      }

      const usage = normalizeOpenAiUsage(rawResponse?.usage);
      const status = rawResponse?.status === 'incomplete'
        ? 'incomplete'
        : (rawResponse?.refusal ? 'refusal' : 'completed');

      return {
        text: fullText,
        toolCalls,
        usage,
        status,
        model: rawResponse?.model || LUNA_MODEL,
      };
    } catch (err) {
      throw normalizeLunaError(err);
    }
  }
}

/** 全局单例工厂，惰性初始化 */
let defaultLunaInstance: LunaRuntime | null = null;
export function getLunaRuntime(): LunaRuntime {
  if (!defaultLunaInstance) {
    defaultLunaInstance = new LunaRuntime();
  }
  return defaultLunaInstance;
}
