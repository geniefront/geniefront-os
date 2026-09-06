/**
 * 副驾会话的本地留存。
 *
 * ## 什么能落 localStorage，什么不能
 *
 * 能落的只有**文本和指针**：消息正文、时间戳、taskId、revision。
 *
 * 不能落的有三类，各有各的理由：
 * - **截图**：几 MB 的 base64，几条就把 5MB 配额撑爆，之后整个会话历史都写不进去；
 * - **可执行令牌**（撤销令牌）：localStorage 是可篡改、可跨标签页读取的，
 *   签名令牌不该躺在那里；而且它们本来就只有几分钟有效期；
 * - **方案本体 `planRevision`**：它是服务端的权威状态，还会因为前台微调而
 *   产生新版本。缓存一份在浏览器里，刷新后看到的是旧版，点执行时服务端
 *   按新版跑 —— 界面和实际执行的东西对不上。
 *
 * 方案在刷新后怎么回来：靠 `taskId` 向 `GET /v1/ai/copilot/tasks/:id`
 * 重新拉一份当前 revision（见 `useRehydrateTasks`）。指针便宜、权威、不会过期。
 */

import type { TranslationKey } from '@/i18n';
import type { CopilotSession } from './types';

export const MAX_SESSION_TURNS = 50;
export const MAX_STORED_SESSIONS = 20;
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** 欢迎语与默认会话标题都跟着界面语言走，靠调用方传入 `t` —— 这是模块级函数，本身没有 hook 上下文 */
export function createInitialSession(t: Translate, initialTitle?: string): CopilotSession {
  return {
    id: crypto.randomUUID(),
    title: initialTitle ?? t('schedule.copilotNewChatTitle'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userQueryCount: 0,
    messages: [{
      id: 'welcome_msg',
      role: 'assistant',
      content: t('schedule.copilotWelcomeMessage'),
      timestamp: Date.now(),
    }],
  };
}

export function loadStoredSessions(key: string, t: Translate): CopilotSession[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [createInitialSession(t)];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [createInitialSession(t)];
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    const valid = parsed.filter((item): item is CopilotSession => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<CopilotSession>;
      return typeof row.id === 'string' && typeof row.title === 'string'
        && typeof row.updatedAt === 'number' && row.updatedAt >= cutoff
        && Array.isArray(row.messages);
    }).slice(0, MAX_STORED_SESSIONS);
    return valid.length > 0 ? valid : [createInitialSession(t)];
  } catch {
    return [createInitialSession(t)];
  }
}

export function sessionsForStorage(sessions: CopilotSession[]): CopilotSession[] {
  const cutoff = Date.now() - SESSION_RETENTION_MS;
  return sessions
    .filter((session) => session.updatedAt >= cutoff)
    .slice(0, MAX_STORED_SESSIONS)
    .map((session) => ({
      ...session,
      messages: session.messages.map(({
        imagePreview: _image,
        planRevision: _planRevision,
        undoToken: _undoToken,
        undoExpiresAt: _undoExpiry,
        isStreaming: _streaming,
        ...message
      }) => message),
    }));
}
