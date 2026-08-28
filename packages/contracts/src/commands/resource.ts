/**
 * 房间与工位资源管理命令（02-DATA-MODEL §7，P0 房态看板）
 *
 * 包含：
 *   - resource.setStatus: 标记房间/工位实时状态（available | in_service | cleaning | maintenance）
 *   - resource.save: 房间/工位维护（增删改名称、类型、容量、技师上限）
 */

import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

export const RESOURCE_STATUSES = ['available', 'in_service', 'cleaning', 'maintenance'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

// ─────────────────────────────────────────────────────────── resource.setStatus

export const resourceSetStatusInput = z.object({
  resourceId: uuid,
  status: z.enum(RESOURCE_STATUSES),
  note: z.string().max(500).optional(),
  guestName: z.string().max(120).optional(),
  serviceName: z.string().max(120).optional(),
});
export type ResourceSetStatusInput = z.infer<typeof resourceSetStatusInput>;

export const resourceSetStatusOutput = z.object({
  resourceId: uuid,
  status: z.enum(RESOURCE_STATUSES),
});
export type ResourceSetStatusOutput = z.infer<typeof resourceSetStatusOutput>;

export const resourceSetStatus = defineCommand({
  name: 'resource.setStatus',
  input: resourceSetStatusInput,
  output: resourceSetStatusOutput,
  permission: 'appointment.write',
  ai: {
    description: '变更房间或工位的实时状态（空闲 available、服务中 in_service、打扫中 cleaning、维护中 maintenance）',
    confirm: 'never',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── resource.save

export const resourceSaveInput = z.object({
  resourceId: uuid.optional(),
  name: z.string().trim().min(1, '资源名称不能为空').max(100),
  type: z.string().trim().min(1).default('room'),
  resourceTypeId: uuid.optional(),
  capacity: z.number().int().min(1).default(1),
  maxStaff: z.number().int().min(1).optional().nullable(),
  active: z.boolean().default(true),
});
export type ResourceSaveInput = z.infer<typeof resourceSaveInput>;

export const resourceSaveOutput = z.object({
  resourceId: uuid,
  created: z.boolean(),
});
export const resourceSave = defineCommand({
  name: 'resource.save',
  input: resourceSaveInput,
  output: resourceSaveOutput,
  permission: 'settings.manage',
  ai: {
    description: '创建或编辑房间、美甲台、按摩床等工位资源配置',
    confirm: 'never',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── resource.delete

export const resourceDeleteInput = z.object({
  resourceId: uuid,
  force: z.boolean().default(false),
});
export type ResourceDeleteInput = z.infer<typeof resourceDeleteInput>;

export const resourceDeleteOutput = z.object({
  resourceId: uuid,
  deleted: z.boolean(),
});
export type ResourceDeleteOutput = z.infer<typeof resourceDeleteOutput>;

export const resourceDelete = defineCommand({
  name: 'resource.delete',
  input: resourceDeleteInput,
  output: resourceDeleteOutput,
  permission: 'settings.manage',
  ai: {
    description: '删除房间或工位资源',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

export const RESOURCE_COMMANDS = [
  resourceSetStatus,
  resourceSave,
  resourceDelete,
] as const;
