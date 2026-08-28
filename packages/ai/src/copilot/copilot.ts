/**
 * 前台副驾的模型调用（05 §6）
 *
 * 一条流水线：
 *   现场快照 + 问题 → Claude（缓存段 + strict tool use）
 *     → 只读工具（要查就查，可以来回几轮）
 *     → 回答 或 命令提案
 *
 * **AI 永远不直接写数据库**（05 §0）。这个模块不认识 postgres：
 * 只读工具由调用方注入，命令提案只是一个待确认的对象，
 * 真正的执行由前台点确认之后走命令总线完成。
 *
 * ## 缓存断点在哪
 *
 * ```
 * [ 缓存段 · 逐字节稳定 ]   ← cache_control 打在这里
 *   系统提示 + 命令目录        ~4k tokens
 * [ 易变段 ]
 *   现场快照                   ≤1.5k tokens
 *   最近 N 轮对话
 *   这次的问题
 * ```
 *
 * 验证：看 `usage.cacheReadInputTokens`，一直是 0 就说明
 * 有东西在偷偷让缓存失效（05 §6.2）。
 */

import Anthropic from '@anthropic-ai/sdk';
import { copilotSystemText, copilotUserText } from './prompt.js';
import { sumUsage, type TokenUsage } from '../cost.js';

/**
 * 前台副驾用 Sonnet 5（05 §7）。
 *
 * 不用 Opus：这是**高频**场景，一家忙店一天 50 次。价目表提取那种
 * 一辈子几次、错一次亏一年的场景才值得上 Opus。
 */
export const COPILOT_MODEL = 'claude-sonnet-5';

/** Sonnet 5 的价格，单位毫分（$3 / $15 每百万 token，05 §7 说了别按优惠价算） */
export const SONNET_5_RATES = {
  inputPerMTok: 300_000,
  outputPerMTok: 1_500_000,
  cacheReadPerMTok: 30_000,
  cacheWritePerMTok: 375_000,
} as const;

/**
 * 只读工具。
 *
 * ⚠️ **全部是只读的，一个都不能有副作用。** 模型可以随便调它们、
 * 调多少次都行，不用确认 —— 这个性质是整个设计成立的前提。
 * 想加一个「顺便帮她建一下」的工具时，回来读这一句。
 */
export interface ReadOnlyTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

/** 模型提的一个命令提案。**还没有执行** */
export interface CommandProposal {
  command: string;
  input: Record<string, unknown>;
  /** 前台在确认卡片上唯一会读的那句话 */
  summary: string;
  /** 命令定义里的确认策略，由调用方填 */
  confirm?: string;
}

export interface CopilotResult {
  /** 给前台看的话。没有提案时这就是全部 */
  answer: string;
  proposal: CommandProposal | null;
  usage: TokenUsage;
  /** 走了几轮工具。用来在日志里看有没有绕圈 */
  rounds: number;
  /** 模型调过哪些只读工具，前台可以展开看「它凭什么这么说」 */
  toolsUsed: string[];
  /** 中断原因：轮数用尽 / 模型拒答。正常结束是 undefined */
  stopped?: 'max_rounds' | 'refusal' | 'max_tokens';
}

export interface CopilotImageInput {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface CopilotCallbacks {
  onStep?: (step: string) => void;
  onDelta?: (delta: string) => void;
  onThinking?: (thought: string) => void;
}

export interface CopilotOptions {
  apiKey: string;
  /** 命令目录文本，由 `commandCatalogText()` 生成。**必须逐字节稳定** */
  commandCatalog: string;
  /** 已经格式化好的现场快照 */
  snapshot: string;
  question: string;
  /** 可选多模态图片输入（如外部预约截图、单据照片） */
  image?: CopilotImageInput | undefined;
  /** 思考深度：前台日常高频用 low 极速响应，复杂多步可用 medium */
  effort?: 'low' | 'medium' | 'high' | undefined;
  /** 最近几轮对话。太多会把缓存后面的易变段撑大，默认只留 3 轮（05 §6.1） */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  tools: readonly ReadOnlyTool[];
  /** 流式回调 */
  callbacks?: CopilotCallbacks | undefined;
  /** 注入用，测试里替换掉真实客户端 */
  client?: Pick<Anthropic, 'messages'>;
  timeoutMs?: number;
  log?: { warn: (o: unknown, m: string) => void };
}

/**
 * 工具调用的轮数上限。
 *
 * ⭐ 必须有。没有上限的话，一个「查客人 → 没查到 → 再查一次」的循环
 * 能把一次 $0.012 的调用烧成几毛钱，而前台看到的只是一个一直在转的圈。
 * 三轮足够走完「查客人 → 查空档 → 提案」这条最长的正常路径。
 */
const MAX_ROUNDS = 3;

/**
 * 提案工具。`command` 是枚举 —— **模型编不出一个不存在的命令名**。
 *
 * ⚠️ `input` 是一个**装着 JSON 的字符串**，不是一个 object。这不是随手写的：
 *
 * `strict: true` 要求 schema 里每一个 `type: 'object'` 都显式写
 * `additionalProperties: false`，而命令入参的字段**每条命令都不一样**，
 * 根本枚举不出来 —— 写成 object 会被 API 当场 400：
 * `tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false`。
 *
 * 两条路：放弃 strict（那就丢掉命令名的枚举保证），或者把入参当字符串传。
 * 选后者：命令名那一条保证比入参的形状重要得多 —— 编错字段名的结果是
 * 一个 `VALIDATION_FAILED`，编错命令名则可能命中另一条真实存在的命令。
 * 而入参本来就要过 Zod（bus.ts 第 1 步），少一层 JSON Schema 不损失什么。
 */
function proposeTool(commandNames: readonly string[]): Anthropic.Tool {
  return {
    name: 'propose_command',
    description:
      '提议一条要前台确认的命令。**这不会立刻执行**，前台点确认之后才会。' +
      '只读的问题不要用这个工具，直接回答就行。',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'input_json', 'summary'],
      properties: {
        command: {
          type: 'string',
          enum: [...commandNames],
          description: '命令名，只能是枚举里的一个',
        },
        input_json: {
          type: 'string',
          description:
            '命令的入参，写成一个 JSON 对象字符串，例如 '
            + '{"appointmentId":"…","startsAt":"2026-08-17T18:00:00-05:00"}。'
            + '字段名照命令目录里写的填。',
        },
        summary: {
          type: 'string',
          description:
            '给前台看的一句话：谁、哪一单、从什么变成什么。' +
            '她不点开详情也能判断对不对。用她说话的语言。',
        },
      },
    } as unknown as Anthropic.Tool.InputSchema,
  };
}

/**
 * 把模型写的 JSON 字符串解回对象。
 *
 * 解不出来返回 null —— 上层会把提案丢掉并让前台自己操作。
 * **绝不「尽力修复」**：一个被猜着补全的入参可能正好是一条合法但错误的命令，
 * 而前台在卡片上只看得到那句 summary，看不出参数被动过手脚。
 */
function parseProposalInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function askCopilot(opts: CopilotOptions): Promise<CopilotResult> {
  const client = opts.client ?? new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: 1,
  });

  const commandNames = extractCommandNames(opts.commandCatalog);
  const tools: Anthropic.Tool[] = [
    ...opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as unknown as Anthropic.Tool.InputSchema,
    })),
    proposeTool(commandNames),
  ];

  const userContent: Anthropic.MessageParam['content'] = opts.image
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: opts.image.mediaType,
            data: opts.image.base64,
          },
        },
        {
          type: 'text',
          text: copilotUserText(opts.snapshot, opts.question),
        },
      ]
    : copilotUserText(opts.snapshot, opts.question);

  const messages: Anthropic.MessageParam[] = [
    // 最近几轮对话。**只留文本**，不把上一轮的工具调用也带回来 ——
    // 那会让易变段迅速膨胀，而模型并不需要看到上次它怎么查的
    ...(opts.history ?? []).slice(-3).map((h) => ({
      role: h.role,
      content: h.text,
    } as Anthropic.MessageParam)),
    { role: 'user', content: userContent },
  ];

  const usages: TokenUsage[] = [];
  const toolsUsed: string[] = [];
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let message: Anthropic.Message;

    if (typeof (client.messages as any).stream === 'function' && opts.callbacks?.onDelta) {
      const stream = (client.messages as any).stream({
        model: COPILOT_MODEL,
        max_tokens: 2000,
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
        system: [{
          type: 'text',
          text: copilotSystemText(opts.commandCatalog),
          cache_control: { type: 'ephemeral' },
        }],
        tools,
        messages,
      });

      stream.on('text', (delta: string) => {
        opts.callbacks?.onDelta?.(delta);
      });

      message = await stream.finalMessage();
    } else {
      message = await client.messages.create({
        model: COPILOT_MODEL,
        max_tokens: 2000,
        // 仅在明确指定 effort 时开启思考模式；日常高频采用标准直出模式（毫秒级首字）
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
        system: [{
          type: 'text',
          // ⭐ 缓存断点打在这里。这一段逐字节稳定，读取只要 0.1 倍价
          text: copilotSystemText(opts.commandCatalog),
          cache_control: { type: 'ephemeral' },
        }],
        tools,
        messages,
      });
    }

    usages.push({
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    });

    // 安全分类器拒答会返回 200 + stop_reason: refusal，content 是空的。
    // 不先看 stop_reason 就读 content 会拿到空数组然后在别处炸
    if (message.stop_reason === 'refusal') {
      return {
        answer: '这个请求我没法处理，请前台自己在界面上操作。',
        proposal: null, usage: sumUsage(usages), rounds: round, toolsUsed,
        stopped: 'refusal',
      };
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n');

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    // ── 提案 ────────────────────────────────────────────────────────────
    const propose = toolUses.find((t) => t.name === 'propose_command');
    if (propose) {
      const raw = propose.input as {
        command?: unknown; input_json?: unknown; summary?: unknown;
      };
      const parsed = parseProposalInput(raw.input_json);
      if (!parsed) {
        // 入参不是合法 JSON。**不猜，不修** —— 给一句前台能照着做的话
        opts.log?.warn({ command: raw.command }, 'copilot proposal input not valid JSON');
        return {
          answer: '我想帮你做这件事，但参数没组对。麻烦你直接在界面上操作一下。',
          proposal: null, usage: sumUsage(usages), rounds: round, toolsUsed,
        };
      }
      return {
        answer: text || String(raw.summary ?? ''),
        proposal: {
          command: String(raw.command ?? ''),
          input: parsed,
          summary: String(raw.summary ?? ''),
        },
        usage: sumUsage(usages), rounds: round, toolsUsed,
      };
    }

    // ── 只读工具：跑一轮再回去 ───────────────────────────────────────────
    if (toolUses.length > 0) {
      messages.push({ role: 'assistant', content: message.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const tool = byName.get(use.name);
        toolsUsed.push(use.name);
        if (!tool) {
          // strict 之外的工具名（理论上不该出现）—— 告诉模型而不是抛异常，
          // 它下一轮会改用别的工具
          results.push({
            type: 'tool_result', tool_use_id: use.id,
            content: `没有叫 ${use.name} 的工具`, is_error: true,
          });
          continue;
        }
        try {
          opts.callbacks?.onStep?.(`🔍 正在查询 ${use.name}...`);
          const out = await tool.run((use.input ?? {}) as Record<string, unknown>);
          results.push({
            type: 'tool_result', tool_use_id: use.id,
            content: JSON.stringify(out),
          });
        } catch (e) {
          opts.log?.warn({ err: e, tool: use.name }, 'copilot tool failed');
          // ⚠️ 工具挂了要**告诉模型**，不是整个请求失败。
          // 它可以换一种方式回答，或者老实说「这个我查不到」
          results.push({
            type: 'tool_result', tool_use_id: use.id,
            content: e instanceof Error ? e.message : '查询失败',
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    // ── 纯文本回答 ──────────────────────────────────────────────────────
    if (message.stop_reason === 'max_tokens') {
      return {
        answer: text || '我说太长了没说完，请把问题拆小一点再问一次。',
        proposal: null, usage: sumUsage(usages), rounds: round, toolsUsed,
        stopped: 'max_tokens',
      };
    }
    return {
      answer: text || '我没听懂，能换个说法吗？',
      proposal: null, usage: sumUsage(usages), rounds: round, toolsUsed,
    };
  }

  // 轮数用尽。给一句前台能直接用的话，而不是一个技术错误
  return {
    answer: '这件事我查了几轮还是没弄清楚，麻烦你直接在界面上操作一下。',
    proposal: null, usage: sumUsage(usages), rounds: MAX_ROUNDS, toolsUsed,
    stopped: 'max_rounds',
  };
}

/**
 * 从命令目录文本里抽出命令名。
 *
 * 之所以从**文本**里抽而不是另外传一份数组：两者必须严格一致。
 * 分成两个来源的话，目录里有而枚举里没有的命令，模型会照着目录去提，
 * 然后被 strict 挡下来 —— 表现是「它有时候就是不肯用这条命令」，
 * 极难查。
 */
export function extractCommandNames(catalog: string): string[] {
  const names: string[] = [];
  for (const line of catalog.split('\n')) {
    const m = /^([a-z][a-z_]*\.[a-zA-Z]+)\s+\[/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}
