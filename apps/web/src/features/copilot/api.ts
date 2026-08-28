import { useMutation } from '@tanstack/react-query';
import { apiPost, authHeaders, API_BASE } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface CopilotHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface CopilotProposal {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  confirm?: 'always' | 'destructive' | 'never';
}

export interface CopilotResponse {
  answer: string;
  proposal: CopilotProposal | null;
  source: 'local' | 'model';
  costCents: number;
  snapshot?: string;
  sessionId?: string | null;
  toolsUsed?: string[];
}

export interface CopilotImagePayload {
  base64: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface AskCopilotInput {
  question: string;
  sessionId?: string;
  image?: CopilotImagePayload;
  history?: CopilotHistoryItem[];
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
          if (event['type'] === 'step' && typeof event['step'] === 'string') {
            callbacks.onStep?.(event['step']);
          } else if (event['type'] === 'delta' && typeof event['delta'] === 'string') {
            callbacks.onDelta?.(event['delta']);
          } else if (event['type'] === 'proposal' && event['proposal']) {
            callbacks.onProposal?.(event['proposal'] as CopilotProposal);
          } else if (event['type'] === 'done') {
            callbacks.onDone?.(event as unknown as CopilotResponse);
          } else if (event['type'] === 'error') {
            throw new Error(String(event['error'] ?? 'Unknown error'));
          }
        } catch (e) {
          console.warn('Failed to parse SSE JSON:', jsonStr, e);
        }
      }
    }
  } catch (err: any) {
    console.warn('Stream failed, falling back to standard copilot api:', err);
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
    mutationFn: async ({ question, sessionId, image, history }: AskCopilotInput) => {
      return apiPost<CopilotResponse>(
        '/v1/ai/copilot',
        { question, sessionId, image, history },
        { headers: { 'X-Membership-Id': membershipId! } },
      );
    },
  });
}
