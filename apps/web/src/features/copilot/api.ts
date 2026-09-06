import { apiGet, apiPost, authHeaders, API_BASE } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * 撤销一次已执行的副驾动作。
 *
 * ⚠️ `/v1/ai/copilot/execute` 现在**只接受撤销令牌**。正向执行一律走
 * `executeCopilotTask()`（task + revision，服务端有 CAS 抢锁和幂等重放）。
 *
 * 早先这条路两用：既跑撤销，也跑一枚随回答签发的 legacy 提案令牌。
 * 后者只执行方案的第 0 步、且不回写任务状态，任务仍停在 ready，
 * 前台再点一次卡片就整批重跑 —— 同一单被建两次。那条路已经删掉了。
 */
export async function undoCopilotAction(
  undoToken: string,
  membershipId?: string | null,
): Promise<{ result: unknown; replayed: boolean; command: string }> {
  return apiPost(
    '/v1/ai/copilot/execute',
    { proposalToken: undoToken },
    { membershipId: membershipId || undefined },
  );
}

export interface CopilotClarification {
  question: string;
  missingFields?: string[];
  candidateOptions?: Array<{ label: string; value: string; description?: string }>;
}

export interface CopilotResponse {
  answer: string;
  source: 'local' | 'model';
  costCents: number;
  sessionId?: string | null;
  toolsUsed?: string[];
  taskId?: string;
  planRevision?: PreviewPayload | null;
  canonicalHash?: string | null;
  revision?: number;
  clarification?: CopilotClarification | null;
}

export interface CopilotImagePayload {
  base64: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface StoredCopilotSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  userQueryCount: number;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
}

export async function getCopilotSessions(membershipId: string): Promise<StoredCopilotSession[]> {
  const result = await apiGet<{ sessions: StoredCopilotSession[] }>(
    '/v1/ai/copilot/sessions',
    membershipId,
  );
  return result.sessions;
}

export async function removeCopilotSession(
  sessionId: string,
  membershipId: string,
): Promise<void> {
  const response = await fetch(`${API_BASE}/v1/ai/copilot/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: await authHeaders(membershipId),
  });
  if (!response.ok) throw new Error(`COPILOT_SESSION_DELETE_FAILED_${response.status}`);
}

export interface AskCopilotInput {
  question: string;
  sessionId?: string;
  image?: CopilotImagePayload;
}

export interface StreamAskCopilotCallbacks {
  onStep?: (step: string) => void;
  onDelta?: (delta: string) => void;
  onDone?: (res: CopilotResponse) => void;
  onError?: (err: Error) => void;
}

export async function streamAskCopilot(
  input: AskCopilotInput,
  callbacks: StreamAskCopilotCallbacks,
  membershipId?: string | null,
): Promise<void> {
  let receivedEvent = false;
  let receivedDone = false;
  try {
    const headers = await authHeaders(membershipId || undefined);
    const resp = await fetch(`${API_BASE}/v1/ai/copilot/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`Stream endpoint status: ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';

      for (const block of lines) {
        const trimmed = block.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr) as Record<string, unknown>;
          receivedEvent = true;
          if (event['type'] === 'step' && typeof event['step'] === 'string') {
            callbacks.onStep?.(event['step']);
          } else if (event['type'] === 'delta' && typeof event['delta'] === 'string') {
            callbacks.onDelta?.(event['delta']);
          } else if (event['type'] === 'done') {
            receivedDone = true;
            callbacks.onDone?.(event as unknown as CopilotResponse);
          } else if (event['type'] === 'error') {
            callbacks.onError?.(new Error(String(event['error'] ?? 'Unknown error')));
            return;
          }
        } catch (e) {
          console.warn('Failed to parse SSE JSON:', jsonStr, e);
        }
      }
    }
    if (!receivedDone) {
      const error = new Error('AI stream ended before completion');
      // 收到过事件说明服务端已经开始处理。此时自动再发普通请求可能造成
      // 第二次模型调用和重复计费，应该明确失败并让用户决定是否重试。
      if (receivedEvent) {
        callbacks.onError?.(error);
        return;
      }
      throw error;
    }
  } catch (err: any) {
    console.warn('Stream failed, falling back to standard copilot api:', err);
    // 只有在 SSE 尚未收到任何服务端事件时才回退；一旦服务端开始工作，
    // 自动重放就不再安全。
    if (receivedEvent) {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    callbacks.onStep?.('⚡ 正在切换至高速直连通道...');
    try {
      const res = await apiPost<CopilotResponse>(
        '/v1/ai/copilot',
        input,
        { membershipId: membershipId || undefined },
      );
      callbacks.onDone?.(res);
    } catch (fallbackErr: any) {
      callbacks.onError?.(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr?.message || fallbackErr)));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Luna 重构：Task 协议接口 (29 §9.1, §10.1)
// ─────────────────────────────────────────────────────────────────────────────

export type {
  CopilotTask,
  CopilotPlanRevision,
  CopilotTaskStep,
  CopilotTaskEvent,
  PreviewPayload,
  StepPreviewItem,
  CopilotTurnRequest,
  CopilotReviseRequest,
  CopilotExecuteRequest,
} from '@gf/contracts';

import type {
  CopilotTask,
  CopilotPlanRevision,
  CopilotTaskStep,
  PreviewPayload,
  CopilotTurnRequest,
  CopilotReviseRequest,
  CopilotExecuteRequest,
} from '@gf/contracts';

/**
 * `GET /v1/ai/copilot/tasks/:id` 的返回。
 *
 * ⚠️ 字段名要和路由**逐字对齐**：路由返回的是 `previewPayload`，
 * 这里以前写的是 `preview`，于是 `detail.preview` 永远是 undefined ——
 * TypeScript 只检查这个 interface，不检查服务端真的返回了什么，
 * 所以这个 bug 编译期一声不吭，运行时表现为「刷新后方案卡片消失」。
 *
 * 任务存在但还没有任何 revision 时（比如停在 needs_input），
 * `revision` 与 `previewPayload` 都是 null，所以两个都可空。
 */
export interface TaskDetailsResponse {
  task: CopilotTask;
  revision: CopilotPlanRevision | null;
  previewPayload: PreviewPayload | null;
  steps: CopilotTaskStep[];
}

export async function getCopilotTask(
  taskId: string,
  membershipId?: string | null,
): Promise<TaskDetailsResponse> {
  return apiGet<TaskDetailsResponse>(
    `/v1/ai/copilot/tasks/${encodeURIComponent(taskId)}`,
    membershipId || undefined,
  );
}

export interface ReviseTaskResponse {
  ok: boolean;
  taskId: string;
  revision: number;
  canonicalHash: string;
  previewPayload: PreviewPayload;
  overallReady: boolean;
  hasConflicts: boolean;
}

export async function reviseCopilotTask(
  taskId: string,
  data: CopilotReviseRequest,
  membershipId?: string | null,
): Promise<ReviseTaskResponse> {
  return apiPost<ReviseTaskResponse>(
    `/v1/ai/copilot/tasks/${encodeURIComponent(taskId)}/revise`,
    data,
    { membershipId: membershipId || undefined },
  );
}

export interface ExecuteTaskResponse {
  ok: boolean;
  execution: {
    taskId: string;
    revision: number;
    status: 'completed' | 'partially_completed' | 'failed';
    replayed?: boolean | undefined;
    executedSteps: Array<{
      stepIndex: number;
      command: string;
      status: 'succeeded' | 'failed' | 'skipped' | 'blocked';
      result?: unknown;
      error?: string | undefined;
      undoToken?: string | undefined;
    }>;
  };
}

export async function executeCopilotTask(
  taskId: string,
  data: CopilotExecuteRequest,
  membershipId?: string | null,
): Promise<ExecuteTaskResponse> {
  return apiPost<ExecuteTaskResponse>(
    `/v1/ai/copilot/tasks/${encodeURIComponent(taskId)}/execute`,
    data,
    { membershipId: membershipId || undefined },
  );
}

export async function cancelCopilotTask(
  taskId: string,
  membershipId?: string | null,
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(
    `/v1/ai/copilot/tasks/${encodeURIComponent(taskId)}/cancel`,
    {},
    { membershipId: membershipId || undefined },
  );
}

export interface TurnResponse {
  taskId: string;
  sessionId: string;
  answer: string;
  planRevision: PreviewPayload | null;
  canonicalHash: string | null;
  revision: number | null;
  clarification: CopilotClarification | null;
  costCents: number;
  toolsUsed: string[];
}

export async function postCopilotTurn(
  input: CopilotTurnRequest,
  membershipId?: string | null,
): Promise<TurnResponse> {
  return apiPost<TurnResponse>(
    '/v1/ai/copilot/turns',
    input,
    { membershipId: membershipId || undefined },
  );
}

