import { useMutation } from '@tanstack/react-query';
import { apiGet, apiPost, authHeaders, API_BASE } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface CopilotProposal {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  confirm?: 'always' | 'destructive' | 'never';
  proposalId: string;
  proposalToken: string;
  expiresAt: string;
}

export async function executeCopilotProposal(
  proposalToken: string,
  membershipId?: string | null,
): Promise<{
  result: unknown;
  replayed: boolean;
  undoToken?: string;
  proposalId: string;
  command: string;
  undoProposalToken?: string;
  undoExpiresAt?: string;
}> {
  return apiPost(
    '/v1/ai/copilot/execute',
    { proposalToken },
    { membershipId: membershipId || undefined },
  );
}

export interface CopilotResponse {
  answer: string;
  proposal: CopilotProposal | null;
  source: 'local' | 'model';
  costCents: number;
  sessionId?: string | null;
  toolsUsed?: string[];
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
  onProposal?: (proposal: CopilotProposal) => void;
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
          } else if (event['type'] === 'proposal' && event['proposal']) {
            callbacks.onProposal?.(event['proposal'] as CopilotProposal);
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
      if (res.proposal) {
        callbacks.onProposal?.(res.proposal);
      }
      callbacks.onDone?.(res);
    } catch (fallbackErr: any) {
      callbacks.onError?.(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr?.message || fallbackErr)));
    }
  }
}

export function useAskCopilot() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async ({ question, sessionId, image }: AskCopilotInput) => {
      return apiPost<CopilotResponse>(
        '/v1/ai/copilot',
        { question, sessionId, image },
        { headers: { 'X-Membership-Id': membershipId! } },
      );
    },
  });
}
