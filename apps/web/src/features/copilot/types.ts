/**
 * 副驾抽屉的会话与消息模型。
 *
 * ⚠️ **消息上不再挂可执行的令牌。**
 *
 * 早先每条助手消息带一个 `proposal`（含 `proposalToken`），和 `planRevision`
 * 并存 —— 两条执行通道，走 token 那条只跑第 0 步且不回写任务状态，
 * 前台点两下就把同一批单建两次。现在消息上只留 `taskId` + `revision`
 * 这两个**指针**，方案本体和执行权都在服务端。
 */

import type { PreviewPayload } from '@gf/contracts';
import type { CopilotClarification } from './api';

export interface MessageItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 原图 data URL。**只活在当前这一屏**，不落 localStorage */
  imagePreview?: string;
  /** 320px 缩略图。落 localStorage，让重开抽屉后还认得出发的是哪张图 */
  imageThumbnail?: string;
  /** 方案指针。刷新页面后靠它向服务端重新拉取方案本体 */
  taskId?: string;
  revision?: number;
  /** 方案预览。**不落 localStorage**，刷新后按 taskId 重新拉 */
  planRevision?: PreviewPayload | null;
  /** 模型要求前台澄清时的提问与候选项 */
  clarification?: CopilotClarification | null;
  executed?: boolean;
  /** 执行成功后服务端签发的撤销令牌（5 分钟有效）。同样不落 localStorage */
  undoToken?: string;
  undoExpiresAt?: string;
  undone?: boolean;
  steps?: string[];
  isStreaming?: boolean;
}

export interface CopilotSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userQueryCount: number;
  messages: MessageItem[];
}

export interface SelectedImageState {
  base64: string;
  previewUrl: string;
  /** 异步生成，生成好之前是 undefined */
  thumbnailUrl?: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  name: string;
}
