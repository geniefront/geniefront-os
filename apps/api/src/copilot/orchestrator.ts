/**
 * Luna 编排器引擎 (29 §4.2, §5.1, §5.2, §8.2)
 *
 * 负责：
 * 1. 维护模型多轮循环 (支持 8 轮动态预算)；
 * 2. 只读工具调用与结果回填；
 * 3. 遇到 ask_user_clarification 挂起为 needs_input；
 * 4. 收到 propose_task_plan 提交预检器并签发不可变 Revision；
 * 5. 模型校验失败时的反思与自我修复循环。
 */

import {
  type CommandContext,
  type CopilotTask,
  type PreviewPayload,
  type AskClarificationInput,
  askClarificationInput,
  proposeTaskPlanInput,
  commandCatalogTextForPermissions,
} from '@gf/contracts';
import {
  getLunaRuntime,
  type LunaTool,
  type LunaMessage,
  type LunaToolCall,
  type NormalizedUsage,
  sumNormalizedUsage,
  copilotSystemText,
  copilotUserText,
  formatFloorSnapshot,
  COPILOT_MAX_ROUNDS,
  type FloorSnapshot,
  type TimeAnchor,
  buildCopilotTools,
} from '@gf/ai';
import { createTask, savePlanRevision, appendTaskEvent, updateTaskStatus } from './taskStore.js';
import { compileTaskPlan } from './preflight.js';

export interface CopilotOrchestratorArgs {
  question: string;
  sessionId: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }> | undefined;
  taskId?: string | undefined;
  image?: { base64: string; mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined } | undefined;
  snapshot: FloorSnapshot;
  timeAnchor: TimeAnchor;
  readOnlyExecutors: Map<string, (input: Record<string, unknown>) => Promise<unknown>>;
  callbacks?: {
    onDelta?: ((text: string) => void) | undefined;
    onStep?: ((stepDescription: string) => void) | undefined;
    onReasoning?: ((thought: string) => void) | undefined;
  } | undefined;
}

export interface CopilotOrchestratorResult {
  task: CopilotTask;
  answer: string;
  planRevision: PreviewPayload | null;
  canonicalHash: string | null;
  revision: number | null;
  clarification: AskClarificationInput | null;
  toolsUsed: string[];
  rounds: number;
  usage: NormalizedUsage;
}

export async function runCopilotOrchestration(
  ctx: CommandContext,
  args: CopilotOrchestratorArgs,
): Promise<CopilotOrchestratorResult> {
  const luna = getLunaRuntime();

  // 1. 初始化或加载任务
  const task = await createTask(ctx, {
    sessionId: args.sessionId,
    originalGoal: args.question,
    timeAnchor: args.timeAnchor,
  });

  await appendTaskEvent(ctx, task.id, 'TASK_CREATED', {
    originalGoal: args.question,
    sessionId: args.sessionId,
  });

  const commandCatalog = commandCatalogTextForPermissions(ctx.permissions);
  const instructions = copilotSystemText(commandCatalog);
  const userPrompt = copilotUserText(
    formatFloorSnapshot(args.snapshot),
    args.question,
    args.timeAnchor,
  );

  const tools: LunaTool[] = buildCopilotTools(ctx.permissions);
  const toolsUsedSet = new Set<string>();
  const usages: NormalizedUsage[] = [];

  const messages: LunaMessage[] = [];
  if (args.history && args.history.length > 0) {
    for (const h of args.history) {
      const text = h.text?.trim();
      if (text) {
        messages.push({
          role: h.role,
          content: text,
        });
      }
    }
  }

  if (args.image) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image', base64: args.image.base64, mediaType: args.image.mediaType },
        { type: 'text', text: userPrompt },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: userPrompt,
    });
  }

  let finalAnswer = '';
  let planRevision: PreviewPayload | null = null;
  let canonicalHash: string | null = null;
  let currentRevision: number | null = null;
  let clarification: AskClarificationInput | null = null;
  let round = 0;

  while (round < COPILOT_MAX_ROUNDS) {
    round++;
    args.callbacks?.onStep?.(`正在思考与分析 (第 ${round}/${COPILOT_MAX_ROUNDS} 轮)...`);

    const response = await luna.invoke({
      instructions,
      messages,
      tools,
      toolChoice: 'auto',
      onDelta: args.callbacks?.onDelta,
      onReasoningDelta: args.callbacks?.onReasoning,
      onToolCallStart: (name) => {
        args.callbacks?.onStep?.(`调用工具: ${name}`);
      },
    });

    usages.push(response.usage);
    finalAnswer = response.text || finalAnswer;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      // 模型没有进一步工具调用，直接输出回答
      break;
    }

    // 记录本轮 Assistant 输出（包含 toolCalls）
    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    let stopLoop = false;

    for (const toolCall of response.toolCalls) {
      toolsUsedSet.add(toolCall.name);

      // ── 分支 1: 请求用户澄清 ──────────────────────────────────────────────
      if (toolCall.name === 'ask_user_clarification') {
        const parsed = askClarificationInput.safeParse(toolCall.arguments);
        if (parsed.success) {
          clarification = parsed.data;
          finalAnswer = clarification.question;
          await updateTaskStatus(ctx, task.id, 'needs_input');
          await appendTaskEvent(ctx, task.id, 'NEEDS_CLARIFICATION', {
            question: clarification.question,
            missingFields: clarification.missingFields,
            candidateOptions: clarification.candidateOptions,
          });
          stopLoop = true;
          break;
        }
      }

      // ── 分支 2: 提交任务方案草案 ──────────────────────────────────────────
      if (toolCall.name === 'propose_task_plan') {
        const parsed = proposeTaskPlanInput.safeParse(toolCall.arguments);
        if (parsed.success) {
          args.callbacks?.onStep?.('方案已生成，正在执行业务规则与排期预检...');
          const compiled = await compileTaskPlan(
            ctx,
            task.id,
            task.currentRevision,
            parsed.data,
            args.timeAnchor,
          );

          // 若有格式错误且处于前几轮，允许模型反思自我修正 (29 §2)
          const hasInvalid = compiled.previewPayload.steps.some((s) => s.status === 'invalid');
          if (hasInvalid && round < 4) {
            const errorReport = compiled.previewPayload.steps
              .filter((s) => s.status === 'invalid')
              .map((s) => `步骤 ${s.stepKey} (${s.command}) 校验不通过: ${(s.issues || []).join('; ')}`)
              .join('\n');

            messages.push({
              role: 'tool',
              callId: toolCall.callId,
              content: JSON.stringify({
                status: 'validation_failed',
                message: `提交的方案存在参数错误，请重新根据错误修正后再次调用 propose_task_plan:\n${errorReport}`,
              }),
            });
            continue;
          }

          // 持久化 Revision 到数据库
          const savedRev = await savePlanRevision(ctx, {
            taskId: task.id,
            revision: task.currentRevision,
            canonicalHash: compiled.canonicalHash,
            previewPayload: compiled.previewPayload,
            executionMode: compiled.executionMode,
            steps: compiled.compiledSteps.map((s) => ({
              stepIndex: s.stepIndex,
              command: s.command,
              resolvedInput: s.resolvedInput,
              summary: s.summary,
              operationKey: s.operationKey,
              status: s.status,
            })),
          });

          await appendTaskEvent(ctx, task.id, 'PLAN_READY', {
            revision: savedRev.revision,
            title: savedRev.previewPayload.title,
            stepsCount: savedRev.previewPayload.steps.length,
            hasConflicts: savedRev.previewPayload.hasConflicts,
          });

          await updateTaskStatus(ctx, task.id, 'ready', savedRev.revision);

          planRevision = savedRev.previewPayload;
          canonicalHash = savedRev.canonicalHash;
          currentRevision = savedRev.revision;
          if (!finalAnswer) {
            finalAnswer = savedRev.previewPayload.summary || savedRev.previewPayload.title;
          }
          stopLoop = true;
          break;
        } else {
          // Zod 校验失败，送回模型让其修正
          messages.push({
            role: 'tool',
            callId: toolCall.callId,
            content: JSON.stringify({
              error: 'propose_task_plan 入参格式不符合要求',
              issues: parsed.error.issues,
            }),
          });
          continue;
        }
      }

      // ── 分支 3: 执行只读工具 ──────────────────────────────────────────────
      const executor = args.readOnlyExecutors.get(toolCall.name);
      if (executor) {
        try {
          const result = await executor(toolCall.arguments);
          messages.push({
            role: 'tool',
            callId: toolCall.callId,
            content: typeof result === 'string' ? result : JSON.stringify(result ?? {}),
          });
        } catch (err: any) {
          messages.push({
            role: 'tool',
            callId: toolCall.callId,
            content: JSON.stringify({ error: err?.message || 'Tool execution failed' }),
          });
        }
      } else {
        messages.push({
          role: 'tool',
          callId: toolCall.callId,
          content: JSON.stringify({ error: `Tool ${toolCall.name} is not available` }),
        });
      }
    }

    if (stopLoop) break;
  }

  if (!finalAnswer) {
    if (clarification?.question) {
      finalAnswer = clarification.question;
    } else if (planRevision?.summary || planRevision?.title) {
      finalAnswer = planRevision.summary || planRevision.title;
    } else {
      // 8 轮耗尽但仍未产出最终文本回答，发起一次无工具强制收敛总结 (Graceful fallback)
      try {
        args.callbacks?.onStep?.('正在整理并输出最终分析结果...');
        const fallbackResp = await luna.invoke({
          instructions: `${instructions}\n\n【重要要求】当前思考轮次已达上限，不得再调用任何工具，请直接向用户做最终文字总结与汇报。若有未能自动导入或确认的内容，清晰向用户说明当前处理进度和需要确认的事项。`,
          messages,
          tools: undefined,
          toolChoice: 'none',
          onDelta: args.callbacks?.onDelta,
          onReasoningDelta: args.callbacks?.onReasoning,
        });
        usages.push(fallbackResp.usage);
        if (fallbackResp.text && fallbackResp.text.trim()) {
          finalAnswer = fallbackResp.text.trim();
        }
      } catch {
        // ignore fallback failure and use hard fallback below
      }

      if (!finalAnswer) {
        finalAnswer = '已为您完成前序检索与分析。本次处理步骤较多，未能自动生成完整方案卡片，请查看上方执行阶段，或进一步补充具体信息后重试。';
      }
    }
  }

  const aggregatedUsage = sumNormalizedUsage(usages);

  return {
    task,
    answer: finalAnswer,
    planRevision,
    canonicalHash,
    revision: currentRevision,
    clarification,
    toolsUsed: [...toolsUsedSet],
    rounds: round,
    usage: aggregatedUsage,
  };
}
