/**
 * 刷新页面后把方案卡片拉回来。
 *
 * localStorage 里只留了 `taskId` 这个指针（方案本体是服务端的权威状态，
 * 缓存一份在浏览器里就会和前台微调后的新 revision 对不上）。抽屉挂载时
 * 拿这些指针去 `GET /v1/ai/copilot/tasks/:id` 各要一份当前版本回来。
 *
 * 拉不回来的（任务过期、被清理）就静静跳过 —— 前台看到的是一条没有卡片的
 * 历史回答，这比弹一堆「任务 xxx 加载失败」有用得多。
 */

import { useEffect, useRef } from 'react';
import { getCopilotTask } from '../api';
import type { CopilotSession } from '../types';

export function useRehydrateTasks(
  sessions: CopilotSession[],
  setSessions: React.Dispatch<React.SetStateAction<CopilotSession[]>>,
  membershipId: string | null | undefined,
): void {
  // 每个 taskId 只补一次。sessions 每次流式增量都会变，不去重就会疯狂请求。
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!membershipId) return;

    const pending = new Set<string>();
    for (const session of sessions) {
      for (const message of session.messages) {
        if (message.taskId && !message.planRevision && !attempted.current.has(message.taskId)) {
          pending.add(message.taskId);
        }
      }
    }
    if (pending.size === 0) return;

    let cancelled = false;
    for (const taskId of pending) {
      attempted.current.add(taskId);
      void getCopilotTask(taskId, membershipId)
        .then((detail) => {
          const preview = detail.previewPayload ?? detail.revision?.previewPayload ?? null;
          if (cancelled || !preview) return;
          setSessions((prev) => prev.map((session) => ({
            ...session,
            messages: session.messages.map((message) => (
              message.taskId === taskId
                ? {
                  ...message,
                  planRevision: preview,
                  revision: detail.revision?.revision ?? message.revision,
                  executed: message.executed
                    || detail.task.status === 'completed'
                    || detail.task.status === 'partially_completed',
                }
                : message
            )),
          })));
        })
        .catch(() => {
          // 任务已过期或被清理：留一条没有卡片的历史回答就好
        });
    }

    return () => { cancelled = true; };
  }, [sessions, setSessions, membershipId]);
}
