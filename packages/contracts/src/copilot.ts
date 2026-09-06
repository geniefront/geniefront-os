/**
 * 前台副驾核心公共契约 (29 §4.2, §5.2, §8.1)
 */

import { z } from 'zod';
import { uuid } from './command.js';

/** 任务状态枚举 */
export const copilotTaskStatus = z.enum([
  'collecting',
  'needs_input',
  'ready',
  'running',
  'partially_completed',
  'completed',
  'failed',
  'cancelled',
]);
export type CopilotTaskStatus = z.infer<typeof copilotTaskStatus>;

/** 步骤状态枚举 */
export const copilotStepStatus = z.enum([
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
]);
export type CopilotStepStatus = z.infer<typeof copilotStepStatus>;

/** 执行模式枚举 */
export const copilotExecutionMode = z.enum(['atomic', 'independent_sequential']);
export type CopilotExecutionMode = z.infer<typeof copilotExecutionMode>;

// ─────────────────────────────────────────────────────────────────────────────
// 元工具入参定义 (Meta-Tools)
// ─────────────────────────────────────────────────────────────────────────────

/** propose_task_plan 入参 */
export const proposeTaskPlanInput = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  executionMode: copilotExecutionMode.default('atomic'),
  steps: z.array(
    z.object({
      stepKey: z.string().min(1).max(64),
      command: z.string().min(1).max(100),
      input: z.record(z.string(), z.unknown()),
      summary: z.string().min(1).max(500),
      dependsOn: z.array(z.string()).optional(),
    }),
  ).min(1).max(20),
});
export type ProposeTaskPlanInput = z.infer<typeof proposeTaskPlanInput>;

/** ask_user_clarification 入参 */
export const askClarificationInput = z.object({
  question: z.string().min(1).max(1000),
  missingFields: z.array(z.string()).default([]),
  candidateOptions: z.array(
    z.object({
      label: z.string().min(1).max(100),
      value: z.string().min(1).max(100),
      description: z.string().max(200).optional(),
    }),
  ).optional(),
});
export type AskClarificationInput = z.infer<typeof askClarificationInput>;

// ─────────────────────────────────────────────────────────────────────────────
// 预览与前端半结构化卡片数据模型
// ─────────────────────────────────────────────────────────────────────────────

export interface StepPreviewItem {
  stepIndex: number;
  stepKey: string;
  command: string;
  summary: string;
  status: 'ready' | 'conflict' | 'invalid';
  canExecute: boolean;
  issues?: string[] | undefined;
  suggestedFix?: string | undefined;
  resolvedInput: Record<string, unknown>;
  details: {
    customerName?: string | undefined;
    customerId?: string | null | undefined;
    serviceName?: string | undefined;
    serviceId?: string | undefined;
    staffName?: string | undefined;
    staffMembershipId?: string | null | undefined;
    timeDisplay?: string | undefined;
    startsAt?: string | undefined;
    endsAt?: string | undefined;
    roomName?: string | undefined;
    resourceId?: string | null | undefined;
    priceCents?: number | undefined;
    partySize?: number | undefined;
    notes?: string | undefined;
    [key: string]: unknown;
  };
}

export interface PreviewPayload {
  title: string;
  summary: string;
  executionMode: CopilotExecutionMode;
  steps: StepPreviewItem[];
  overallReady: boolean;
  hasConflicts: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据表实体模型 (Database Models)
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotTask {
  id: string;
  orgId: string;
  locationId: string;
  membershipId: string;
  sessionId: string;
  originalGoal: string;
  status: CopilotTaskStatus;
  currentRevision: number;
  timeAnchor: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CopilotPlanRevision {
  id: string;
  taskId: string;
  orgId: string;
  locationId: string;
  membershipId: string;
  revision: number;
  canonicalHash: string;
  previewPayload: PreviewPayload;
  executionMode: CopilotExecutionMode;
  createdAt: string;
}

export interface CopilotTaskStep {
  id: string;
  taskId: string;
  revision: number;
  stepIndex: number;
  orgId: string;
  locationId: string;
  membershipId: string;
  command: string;
  resolvedInput: Record<string, unknown>;
  summary: string;
  operationKey: string;
  status: CopilotStepStatus;
  executionResult?: Record<string, unknown> | null | undefined;
  errorDetails?: Record<string, unknown> | null | undefined;
  undoToken?: string | null | undefined;
  undoExpiresAt?: string | null | undefined;
  attempt: number;
  updatedAt: string;
}

export interface CopilotTaskEvent {
  id: number;
  taskId: string;
  orgId: string;
  locationId: string;
  membershipId: string;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// API 请求与响应类型
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotTurnRequest {
  question?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  image?: {
    base64: string;
    mediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined;
  } | undefined;
  clientRequestId?: string | undefined;
}

export interface CopilotReviseRequest {
  expectedRevision: number;
  selectedStepIndices?: number[] | undefined;
  modifications?: Array<{
    stepIndex: number;
    startsAt?: string | undefined;
    membershipId?: string | null | undefined;
    resourceId?: string | null | undefined;
    notes?: string | undefined;
  }> | undefined;
}

export interface CopilotExecuteRequest {
  revision: number;
  proposalToken?: string | undefined;
  selectedStepIndices?: number[] | undefined;
  clientRequestId?: string | undefined;
}
