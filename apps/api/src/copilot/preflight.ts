/**
 * 服务端预检与计划编译器 (29 §4.2, §7.3, §7.4, §8.1)
 *
 * 负责：
 * 1. 业务规则与容量预检 (排班、技能、时间、冲突)；
 * 2. 随单新客处理 (密码学短码与 manageToken 服务端安全注入)；
 * 3. 生成不可变 Revision，计算参数 Canonical Hash 与 Preview 数据。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  getCommand,
  type CommandContext,
  type ProposeTaskPlanInput,
  type PreviewPayload,
  type StepPreviewItem,
  type CopilotExecutionMode,
  type CopilotStepStatus,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import { generateConfirmationCode, generateManageToken } from '../public/bookingToken.js';
import type { TimeAnchor } from '@gf/ai';

export interface CompiledStep {
  stepIndex: number;
  stepKey: string;
  command: string;
  resolvedInput: Record<string, unknown>;
  summary: string;
  operationKey: string;
  status: CopilotStepStatus;
  preview: StepPreviewItem;
}

export interface PreflightResult {
  previewPayload: PreviewPayload;
  canonicalHash: string;
  executionMode: CopilotExecutionMode;
  compiledSteps: CompiledStep[];
}

/** 规范化 JSON 序列化（排序键），用于哈希与签名 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`,
  );
  return '{' + pairs.join(',') + '}';
}

export async function compileTaskPlan(
  ctx: CommandContext,
  taskId: string,
  revision: number,
  planInput: ProposeTaskPlanInput,
  _timeAnchor: TimeAnchor,
): Promise<PreflightResult> {
  const compiledSteps: CompiledStep[] = [];

  for (let idx = 0; idx < planInput.steps.length; idx++) {
    const rawStep = planInput.steps[idx]!;
    const cmd = getCommand(rawStep.command);

    if (!cmd) {
      const preview: StepPreviewItem = {
        stepIndex: idx,
        stepKey: rawStep.stepKey,
        command: rawStep.command,
        summary: rawStep.summary,
        status: 'invalid',
        canExecute: false,
        issues: [`未知命令: ${rawStep.command}`],
        resolvedInput: rawStep.input,
        details: {},
      };
      compiledSteps.push({
        stepIndex: idx,
        stepKey: rawStep.stepKey,
        command: rawStep.command,
        resolvedInput: rawStep.input,
        summary: rawStep.summary,
        operationKey: `copilot:${taskId}:${revision}:${idx}`,
        status: 'failed',
        preview,
      });
      continue;
    }

    if (cmd.permission && !ctx.permissions.has(cmd.permission)) {
      const preview: StepPreviewItem = {
        stepIndex: idx,
        stepKey: rawStep.stepKey,
        command: rawStep.command,
        summary: rawStep.summary,
        status: 'invalid',
        canExecute: false,
        issues: [`当前操作人无权执行此操作 (缺少 ${cmd.permission} 权限)`],
        resolvedInput: rawStep.input,
        details: {},
      };
      compiledSteps.push({
        stepIndex: idx,
        stepKey: rawStep.stepKey,
        command: rawStep.command,
        resolvedInput: rawStep.input,
        summary: rawStep.summary,
        operationKey: `copilot:${taskId}:${revision}:${idx}`,
        status: 'failed',
        preview,
      });
      continue;
    }

    // 深拷贝入参以安全处理
    const resolvedInput = JSON.parse(JSON.stringify(rawStep.input));
    const issues: string[] = [];
    let stepStatus: 'ready' | 'conflict' | 'invalid' = 'ready';
    const previewDetails: StepPreviewItem['details'] = {};

    // ── appointment.create 特别预检与补齐 (29 §7.3) ──────────────────────────
    if (rawStep.command === 'appointment.create') {
      if (resolvedInput['customerId'] === undefined) {
        resolvedInput['customerId'] = null;
      }
      if (!resolvedInput['source']) {
        resolvedInput['source'] = 'ai_copilot';
      }

      const rawGuest = resolvedInput['guest'] as Record<string, unknown> | undefined;
      const rawCustomer = resolvedInput['customer'] as Record<string, unknown> | undefined;

      // 若有随单新客信息，服务端自动补齐确认码与 manageToken
      if (rawGuest || rawCustomer) {
        const guestInfo = (rawGuest || rawCustomer)!;
        const name = String(guestInfo['name'] || resolvedInput['walkInName'] || 'Guest');
        const phoneE164 = String(guestInfo['phoneE164'] || guestInfo['phone'] || '');

        if (phoneE164) {
          resolvedInput['guest'] = {
            confirmationCode:
              typeof guestInfo['confirmationCode'] === 'string' &&
              /^[A-Z0-9]{2,4}-[A-Z0-9]{4,6}$/.test(guestInfo['confirmationCode'])
                ? guestInfo['confirmationCode']
                : generateConfirmationCode('GF'),
            manageToken:
              typeof guestInfo['manageToken'] === 'string' &&
              /^mt_[A-Za-z0-9_-]{20,}$/.test(guestInfo['manageToken'])
                ? guestInfo['manageToken']
                : generateManageToken(),
            customer: {
              name,
              phoneE164,
              email: guestInfo['email'] ? String(guestInfo['email']) : undefined,
              smsOptIn: guestInfo['smsOptIn'] === true,
            },
          };
          previewDetails['customerName'] = name;
        }
      }

      if (resolvedInput['walkInName']) {
        previewDetails['customerName'] = String(resolvedInput['walkInName']);
      }

      // 查询服务项目与技师
      await withTenant(ctx, async (tx) => {
        if (resolvedInput['customerId'] && !previewDetails['customerName']) {
          const [c] = await tx<{ name: string }[]>`
            select display_name as name from customers where id = ${resolvedInput['customerId']} and org_id = ${ctx.orgId}`;
          if (c) previewDetails['customerName'] = c.name;
        }

        const items = Array.isArray(resolvedInput['items']) ? resolvedInput['items'] : [];
        const svcIds = items.map((i: any) => i.serviceId).filter(Boolean);
        const staffIds = items.map((i: any) => i.membershipId).filter(Boolean);

        if (svcIds.length > 0) {
          const svcs = await tx<{ id: string; name: any; base_price_cents: number }[]>`
            select id, name, base_price_cents from services
            where id = any(${svcIds}) and location_id = ${ctx.locationId}`;
          const svcMap = new Map(svcs.map((s) => [s.id, s]));
          const names: string[] = [];
          let totalCents = 0;
          for (const it of items) {
            const s = svcMap.get(it.serviceId);
            if (s) {
              const nm = typeof s.name === 'object' ? s.name['en'] || s.name['zh'] || Object.values(s.name)[0] : s.name;
              names.push(String(nm));
              totalCents += it.priceCentsOverride ?? s.base_price_cents;
            } else {
              issues.push(`服务项目未找到: ${it.serviceId}`);
              stepStatus = 'invalid';
            }
          }
          previewDetails['serviceName'] = names.join(' + ');
          previewDetails['priceCents'] = totalCents;
        }

        if (staffIds.length > 0) {
          const staffs = await tx<{ membership_id: string; is_bookable: boolean; full_name: string }[]>`
            select sp.membership_id, sp.is_bookable, coalesce(sp.display_name->>'en', sp.display_name->>'zh', '') as full_name
            from staff_profiles sp
            where sp.membership_id = any(${staffIds}) and sp.location_id = ${ctx.locationId}`;
          const staffMap = new Map(staffs.map((s) => [s.membership_id, s]));
          const staffNames: string[] = [];
          for (const it of items) {
            if (it.membershipId) {
              const st = staffMap.get(it.membershipId);
              if (st) {
                staffNames.push(st.full_name);
                if (!st.is_bookable) {
                  issues.push(`技师 ${st.full_name} 当前设为不可预约`);
                  stepStatus = 'conflict';
                }
              } else {
                issues.push(`技师未找到: ${it.membershipId}`);
                stepStatus = 'invalid';
              }
            }
          }
          previewDetails['staffName'] = staffNames.join(', ');
        }

        if (items.length > 0 && items[0]?.startsAt) {
          previewDetails['startsAt'] = String(items[0].startsAt);
          try {
            const d = new Date(items[0].startsAt);
            previewDetails['timeDisplay'] = d.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            });
          } catch {
            previewDetails['timeDisplay'] = String(items[0].startsAt);
          }
        }
      });
    }

    // ── appointment.createBatch 特别预检与补齐 (29 §7.2, §7.3) ────────────────
    if (rawStep.command === 'appointment.createBatch') {
      const batchItems = Array.isArray(resolvedInput['items']) ? resolvedInput['items'] : [];
      if (!resolvedInput['batchId']) {
        resolvedInput['batchId'] = randomUUID();
      }

      await withTenant(ctx, async (tx) => {
        const customerNames: string[] = [];
        let totalCents = 0;

        for (const item of batchItems) {
          const rawGuest = item['guest'] as Record<string, unknown> | undefined;
          if (rawGuest) {
            const name = String(rawGuest['name'] || item['walkInName'] || 'Guest');
            const phoneE164 = String(rawGuest['phoneE164'] || rawGuest['phone'] || '');
            if (phoneE164) {
              item['guest'] = {
                confirmationCode:
                  typeof rawGuest['confirmationCode'] === 'string' &&
                  /^[A-Z0-9]{2,4}-[A-Z0-9]{4,6}$/.test(rawGuest['confirmationCode'])
                    ? rawGuest['confirmationCode']
                    : generateConfirmationCode('GF'),
                manageToken:
                  typeof rawGuest['manageToken'] === 'string' &&
                  /^mt_[A-Za-z0-9_-]{20,}$/.test(rawGuest['manageToken'])
                    ? rawGuest['manageToken']
                    : generateManageToken(),
                customer: {
                  name,
                  phoneE164,
                  email: rawGuest['email'] ? String(rawGuest['email']) : undefined,
                  smsOptIn: rawGuest['smsOptIn'] === true,
                },
              };
              customerNames.push(name);
            }
          } else if (item['customerId']) {
            const [c] = await tx<{ name: string }[]>`
              select display_name as name from customers where id = ${item['customerId']} and org_id = ${ctx.orgId}`;
            if (c) customerNames.push(c.name);
          } else if (item['walkInName']) {
            customerNames.push(String(item['walkInName']));
          }

          const serviceItems = Array.isArray(item['serviceItems']) ? item['serviceItems'] : [];
          for (const sItem of serviceItems) {
            if (sItem.serviceId) {
              const [s] = await tx<{ base_price_cents: number }[]>`
                select base_price_cents from services where id = ${sItem.serviceId} and location_id = ${ctx.locationId}`;
              if (s) {
                totalCents += sItem.priceCentsOverride ?? s.base_price_cents;
              }
            }
            if (sItem.membershipId) {
              const [st] = await tx<{ is_bookable: boolean; full_name: string }[]>`
                select sp.is_bookable, coalesce(sp.display_name->>'en', sp.display_name->>'zh', '') as full_name
                from staff_profiles sp
                where sp.membership_id = ${sItem.membershipId} and sp.location_id = ${ctx.locationId}`;
              if (st && !st.is_bookable) {
                issues.push(`批次预约中技师 ${st.full_name} 当前设为不可预约`);
                stepStatus = 'conflict';
              }
            }
          }
        }

        if (customerNames.length > 0) {
          previewDetails['customerName'] = customerNames.join(', ');
        }
        previewDetails['priceCents'] = totalCents;
      });
    }

    // ── resource.setStatus 特别预检 ─────────────────────────────────────────
    if (rawStep.command === 'resource.setStatus') {
      await withTenant(ctx, async (tx) => {
        const resId = resolvedInput['resourceId'];
        if (resId) {
          const [r] = await tx<{ name: string; status: string }[]>`
            select name, status from resources where id = ${resId} and location_id = ${ctx.locationId}`;
          if (r) {
            previewDetails['roomName'] = r.name;
            previewDetails['currentStatus'] = r.status;
            previewDetails['targetStatus'] = resolvedInput['status'];
          } else {
            issues.push(`工位/房间未找到: ${resId}`);
            stepStatus = 'invalid';
          }
        }
      });
    }

    // 基础 Schema 校验
    const parseResult = cmd.input.safeParse(resolvedInput);
    if (!parseResult.success) {
      for (const issue of parseResult.error.issues) {
        issues.push(`参数格式错误: ${issue.path.join('.') || 'root'} - ${issue.message}`);
      }
      stepStatus = 'invalid';
    }

    const inputHash = createHash('sha256')
      .update(canonicalJson(resolvedInput))
      .digest('hex')
      .slice(0, 16);
    const operationKey = `copilot:${taskId}:${idx}:${inputHash}`;

    const preview: StepPreviewItem = {
      stepIndex: idx,
      stepKey: rawStep.stepKey,
      command: rawStep.command,
      summary: rawStep.summary,
      status: stepStatus,
      canExecute: stepStatus === 'ready',
      issues: issues.length > 0 ? issues : undefined,
      resolvedInput,
      details: previewDetails,
    };

    compiledSteps.push({
      stepIndex: idx,
      stepKey: rawStep.stepKey,
      command: rawStep.command,
      resolvedInput,
      summary: rawStep.summary,
      operationKey,
      status: stepStatus === 'ready' ? 'ready' : ((stepStatus as string) === 'conflict' ? 'blocked' : 'failed'),
      preview,
    });
  }

  const stepsPreview = compiledSteps.map((s) => s.preview);
  const hasConflicts = stepsPreview.some((s) => s.status === 'conflict');
  const hasInvalids = stepsPreview.some((s) => s.status === 'invalid');
  const overallReady = !hasConflicts && !hasInvalids;

  const previewPayload: PreviewPayload = {
    title: planInput.title,
    summary: planInput.summary,
    executionMode: planInput.executionMode,
    steps: stepsPreview,
    overallReady,
    hasConflicts,
  };

  const canonicalHash = createHash('sha256')
    .update(
      canonicalJson({
        title: planInput.title,
        executionMode: planInput.executionMode,
        steps: compiledSteps.map((s) => ({ command: s.command, input: s.resolvedInput })),
      }),
    )
    .digest('hex');

  return {
    previewPayload,
    canonicalHash,
    executionMode: planInput.executionMode,
    compiledSteps,
  };
}
