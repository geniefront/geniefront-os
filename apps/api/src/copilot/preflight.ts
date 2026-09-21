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
import { generateManageToken } from '../public/bookingToken.js';
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

/** 门店墙上时间的 `2:00 PM`。**一定要带 timeZone**，理由见调用处的长注释 */
function formatStoreTime(iso: string, timezone: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return iso;
  }
}

/** 门店墙上时间的 `Sep 7, 10:00 AM`，用于跨天的批量卡片 */
function formatStoreDateTime(iso: string, timezone: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: timezone, month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return iso;
  }
}

export async function compileTaskPlan(
  ctx: CommandContext,
  taskId: string,
  revision: number,
  planInput: ProposeTaskPlanInput,
  timeAnchor: TimeAnchor,
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
      // ⚠️ **强制覆盖，不是「缺了才补」。**
      //
      // `source` 记的是「这条记录是从哪条路进系统的」，走副驾就一定是
      // ai_copilot —— 这不该由模型决定。模型看到命令目录里的枚举
      // （'desk'|'walkin'|'web'|'phone_ai'|'ai_copilot'）会自己挑一个，
      // 实测它有时填 'desk'（"前台在录入嘛"），于是 AI 建的单和前台手工
      // 建的在库里分不出来 —— 报表算不出 AI 的贡献，出问题也追不到来源。
      // 而且它是**时灵时不灵**的：同一张截图两次导入可能填不同的值。
      resolvedInput['source'] = 'ai_copilot';

      const rawGuest = resolvedInput['guest'] as Record<string, unknown> | undefined;
      const rawCustomer = resolvedInput['customer'] as Record<string, unknown> | undefined;

      // 若有随单新客信息，服务端自动补齐 manageToken
      if (rawGuest || rawCustomer) {
        const guestInfo = (rawGuest || rawCustomer)!;
        const name = String(guestInfo['name'] || resolvedInput['walkInName'] || 'Guest');
        const phoneE164 = String(guestInfo['phoneE164'] || guestInfo['phone'] || '');

        if (phoneE164) {
          resolvedInput['guest'] = {
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

          // 加项独立收费，必须计进卡片上的金额（详见 createBatch 分支的同一条注释）
          const addonIds = [...new Set(items.flatMap((i: any) =>
            Array.isArray(i.addonIds) ? i.addonIds : []))];
          if (addonIds.length > 0) {
            const addons = await tx<{ id: string; name: any; base_price_cents: number }[]>`
              select id, name, base_price_cents from services
              where id = any(${addonIds}) and location_id = ${ctx.locationId}`;
            const addonMap = new Map(addons.map((a) => [a.id, a]));
            for (const it of items) {
              for (const aid of (Array.isArray(it.addonIds) ? it.addonIds : [])) {
                const a = addonMap.get(aid);
                if (!a) {
                  issues.push(`加项未找到: ${aid}`);
                  stepStatus = 'invalid';
                  continue;
                }
                const nm = typeof a.name === 'object'
                  ? a.name['en'] || a.name['zh'] || Object.values(a.name)[0] : a.name;
                names.push(String(nm));
                totalCents += a.base_price_cents;
              }
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
          // ⚠️ **必须指定门店时区。**
          //
          // 不传 timeZone 时 toLocaleTimeString 用的是**服务端进程的时区**。
          // 服务器在弗吉尼亚、门店在洛杉矶，一单 10:00 PDT 会被渲染成
          // 「1:00 PM」印在确认卡片上，前台照着它跟客人复述时间就说错了 ——
          // 这是那种界面上完全看不出错、只有客人白跑一趟才会暴露的错。
          previewDetails['timeDisplay'] = formatStoreTime(items[0].startsAt, timeAnchor.timezone);
        }
      });
    }

    // ── appointment.createBatch 特别预检与补齐 (29 §7.2, §7.3) ────────────────
    if (rawStep.command === 'appointment.createBatch') {
      const batchItems = Array.isArray(resolvedInput['items']) ? resolvedInput['items'] : [];
      if (!resolvedInput['batchId']) {
        resolvedInput['batchId'] = randomUUID();
      }
      // 同 appointment.create 分支：强制覆盖，理由见那里的长注释
      resolvedInput['source'] = 'ai_copilot';

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
            // ⚠️ 加项也要计进总价。addonIds 里的每一项都是独立收费的服务，
            // 只算主项目会让卡片上的金额比实际少一截，前台照着它跟客人报价就报错了。
            const addonIds = Array.isArray(sItem.addonIds) ? sItem.addonIds : [];
            if (addonIds.length > 0) {
              const addons = await tx<{ base_price_cents: number }[]>`
                select base_price_cents from services
                where id = any(${addonIds}) and location_id = ${ctx.locationId}`;
              for (const a of addons) totalCents += a.base_price_cents;
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

        // 批量卡片上至少要能看到时间跨度，否则前台只看到一个「8 条」的黑盒
        const allStarts = batchItems
          .flatMap((it: any) => (Array.isArray(it.serviceItems) ? it.serviceItems : []))
          .map((si: any) => si?.startsAt)
          .filter((x: unknown): x is string => typeof x === 'string')
          .sort();
        if (allStarts.length > 0) {
          previewDetails['startsAt'] = allStarts[0]!;
          previewDetails['timeDisplay'] = allStarts.length === 1
            ? formatStoreTime(allStarts[0]!, timeAnchor.timezone)
            : `${formatStoreDateTime(allStarts[0]!, timeAnchor.timezone)} ~ `
              + `${formatStoreDateTime(allStarts[allStarts.length - 1]!, timeAnchor.timezone)}`;
        }
      });
    }

    // ── resource.setStatus 特别预检 ─────────────────────────────────────────
    //
    // ⚠️ 这里必须**镜像 `handlers/resource.ts` 的状态机规则**。
    //
    // 房态不是一个可以随便写的字段：`cleaning` / `in_use` 由服务流程自己驱动，
    // 手动只允许「设为维护」和「从维护或占用中放回可用」。预检以前不查这条，
    // 于是「把 3 号房设成清洁中」会以绿色 ready 出现在卡片上，前台点确认之后
    // 才在总线上撞 VALIDATION_FAILED —— 预检存在的全部意义就是不让这种事发生。
    if (rawStep.command === 'resource.setStatus') {
      await withTenant(ctx, async (tx) => {
        const resId = resolvedInput['resourceId'];
        if (!resId) return;

        const [r] = await tx<{ name: string; status: string }[]>`
          select name, status from resources
          where id = ${resId} and location_id = ${ctx.locationId}`;
        if (!r) {
          issues.push(`工位/房间未找到: ${resId}`);
          stepStatus = 'invalid';
          return;
        }

        previewDetails['roomName'] = r.name;
        previewDetails['currentStatus'] = r.status;
        const target = String(resolvedInput['status'] ?? '');
        previewDetails['targetStatus'] = target;

        // 目标状态和现状一致：总线会放行（等价于空操作），预检也不拦
        if (target === r.status) return;

        const [busy] = await tx<{ count: number }[]>`
          select count(*)::int as count from resource_occupancies
          where resource_id = ${resId} and status <> 'released'`;
        const occupied = (busy?.count ?? 0) > 0;

        if (occupied) {
          issues.push(`${r.name} 上还有未释放的占用，改状态前需要先结束当前服务`);
          stepStatus = 'conflict';
          return;
        }

        const allowed = target === 'maintenance'
          || (target === 'available' && ['maintenance', 'in_use'].includes(r.status));
        if (!allowed) {
          issues.push(
            `${r.name} 无法手动从「${r.status}」改为「${target}」：`
            + 'cleaning / in_use 由服务流程自动驱动，手动只支持设为 maintenance，'
            + '或把 maintenance / in_use 的工位放回 available',
          );
          stepStatus = 'conflict';
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

    // ⚠️ operationKey 必须带上 revision。
    //
    // 旧实现是 `copilot:${taskId}:${idx}:${hash}` —— 不含版本号，而上面两个
    // 提前 continue 的分支用的又是 `copilot:${taskId}:${revision}:${idx}`，
    // 同一个概念在一个函数里有两种格式。后果是前台微调生成新 revision 后，
    // 只要入参没变，operationKey 就和上一版一模一样，执行引擎的
    // `findStepByOperationKey` 会把它当成「上一次崩溃前已经做过」而直接跳过。
    const inputHash = createHash('sha256')
      .update(canonicalJson(resolvedInput))
      .digest('hex')
      .slice(0, 16);
    const operationKey = `copilot:${taskId}:${revision}:${idx}:${inputHash}`;

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
