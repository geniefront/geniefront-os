/**
 * 会话留存的两条硬约束。
 *
 * 这一层出错的方式很特别：**它不会报错，只会安静地停止工作**。
 * localStorage 配额满时 `setItem` 抛异常，而旧实现是 `catch {}` ——
 * 表现是「聊天记录莫名其妙不再保存了」，前台报不出所以然，
 * 开发也复现不了（自己的浏览器里配额还很空）。
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { persistSessions, sessionsForStorage } from './sessionStorage';
import type { CopilotSession } from './types';

const session = (over: Partial<CopilotSession> = {}): CopilotSession => ({
  id: crypto.randomUUID(),
  title: '会话',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  userQueryCount: 1,
  messages: [{
    id: 'm1',
    role: 'assistant',
    content: '导入 8 条预约',
    timestamp: Date.now(),
    imagePreview: 'data:image/png;base64,' + 'A'.repeat(2000),
    imageThumbnail: 'data:image/jpeg;base64,thumb',
    planRevision: { title: 't', summary: 's', executionMode: 'atomic', steps: [], overallReady: true, hasConflicts: false },
    taskId: 'task-1',
    revision: 2,
    undoToken: 'signed.undo.token',
    undoExpiresAt: new Date().toISOString(),
    isStreaming: true,
  }],
  ...over,
});

describe('sessionsForStorage', () => {
  const [stored] = sessionsForStorage([session()]);
  const msg = stored!.messages[0]!;

  it('⭐ 原图不落盘，缩略图留下 —— 前台重开抽屉要认得出发的是哪张图', () => {
    expect(msg.imagePreview).toBeUndefined();
    expect(msg.imageThumbnail).toBe('data:image/jpeg;base64,thumb');
  });

  it('⭐ 可执行令牌不落盘 —— localStorage 是可篡改、可跨标签页读的', () => {
    expect(msg.undoToken).toBeUndefined();
    expect(msg.undoExpiresAt).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('signed.undo.token');
  });

  it('⭐ 方案本体不落盘，只留 taskId 指针 —— 缓存的旧版本会和服务端对不上', () => {
    expect(msg.planRevision).toBeUndefined();
    expect(msg.taskId).toBe('task-1');
    expect(msg.revision).toBe(2);
  });

  it('流式中间态不落盘，否则重开时那条消息会一直显示「生成中」', () => {
    expect(msg.isStreaming).toBeUndefined();
  });

  it('过期会话被剔除', () => {
    const old = session({ updatedAt: Date.now() - 8 * 24 * 60 * 60_000 });
    expect(sessionsForStorage([old])).toHaveLength(0);
  });
});

describe('persistSessions 配额兜底', () => {
  beforeEach(() => localStorage.clear());

  it('正常情况直接写入', () => {
    persistSessions('k', [session()]);
    expect(JSON.parse(localStorage.getItem('k')!)).toHaveLength(1);
  });

  it('⭐ 配额满时丢掉最老的一半重试，而不是静默放弃', () => {
    const sessions = Array.from({ length: 8 }, () => session());
    let calls = 0;
    const real = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => {
      calls++;
      // 前两次（全量 8 条、裁到 4 条）都写不下，第三次（2 条）才成功
      if (calls < 3) throw new DOMException('quota', 'QuotaExceededError');
      real(k, v);
    });

    persistSessions('k', sessions);

    expect(calls).toBe(3);
    expect(JSON.parse(localStorage.getItem('k')!)).toHaveLength(2);
    spy.mockRestore();
  });

  it('⭐ 砍到一条也写不下时清掉这个键，不要永远卡在写不进去的状态', () => {
    localStorage.setItem('k', '["stale"]');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    persistSessions('k', [session()]);

    spy.mockRestore();
    expect(localStorage.getItem('k')).toBeNull();
  });
});
