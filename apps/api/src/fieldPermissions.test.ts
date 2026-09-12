/**
 * AUD-02 回归：**字段级能力必须有字段级判定**。
 *
 * ## 原始缺陷
 *
 * 总线里的门只有一道：「你有没有 `def.permission`」。但有些能力根本不是
 * 一条独立命令，而是另一条命令入参里的**一个字段**：
 *
 *   · 打折 —— `ticket.close.discountCents`，而 `ticket.close` 只要 `ticket.write`
 *   · 超容量 —— `appointment.create.override`，而建单只要 `appointment.write`
 *
 * 权限清单里明明有 `ticket.discount` 和 `appointment.overbook` 两条，
 * 却**没有任何一条命令要求它们**，全仓也没有任何一处判定。
 * 唯一的约束是界面把折扣输入框藏了起来 —— 而藏起来不是约束：
 * 持有 `ticket.write` 的技师（预设里技师就有）可以直接把整单折成 0。
 *
 * 更坏的一面是它给了店主一个假的确认：设置页里那个「打折」勾选框
 * 取消掉以后，他以为限住了，实际什么也没发生。
 *
 * 这和 AUD-01 是同一族缺陷 —— 标记存在，没人强制。
 *
 * ## 为什么按「全集」写
 *
 * 只断言 `ticket.close` 被挡住的话，下一条带 `discountCents` 的命令加进来时
 * 这里依然全绿，而那正是原始缺陷的形状。所以断言的对象是**注册表本身**：
 *
 *   · 入参里出现这些字段的每一条命令，都必须声明对应的 fieldPermissions
 *   · 每条声明的规则，`used()` 必须真的区分「用了」和「没用」
 *   · 总线必须在只有基础权限时拒绝，并点名是哪个字段
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, COMMAND_REGISTRY, ERROR_CODES, type CommandContext, type Permission } from '@gf/contracts';
import { dispatch } from './bus';
import './handlers/appointment';
import './handlers/ticket';
import './handlers/staff';

/**
 * 需要字段级权限的字段 → 它该要求的权限。
 *
 * 这份表是**人写的意图**；下面第一条用例负责证明代码和意图对得上。
 */
const FIELD_INTENT: Array<{ field: string; need: Permission }> = [
  { field: 'discountCents', need: 'ticket.discount' },
  { field: 'override', need: 'appointment.overbook' },
];

/**
 * 豁免：字段同名但语义不同的命令。
 *
 * 优惠券模板里的 `discountCents` 是「这张券面值多少」，不是「这一单打了多少折」，
 * 它已经由 `settings.manage` 守住。逐条列出而不是按前缀放过 —— 豁免必须是
 * 有人看过并写下理由的决定。
 */
const EXEMPT = new Set(['coupon.saveTemplate', 'marketing.saveCouponTemplate']);

/** 取一条命令入参的顶层字段名。取不到（非 object schema）就返回空。 */
function topLevelFields(schema: z.ZodTypeAny): string[] {
  const shape = (schema as z.ZodObject<z.ZodRawShape>)._def?.shape;
  try { return typeof shape === 'function' ? Object.keys(shape()) : []; } catch { return []; }
}

describe('AUD-02 字段级权限', () => {
  it('入参里出现受限字段的每一条命令，都声明了对应的 fieldPermissions', () => {
    const gaps: string[] = [];

    for (const [name, def] of COMMAND_REGISTRY) {
      if (EXEMPT.has(name)) continue;
      const fields = topLevelFields(def.input);
      for (const { field, need } of FIELD_INTENT) {
        if (!fields.includes(field)) continue;
        const declared = (def.fieldPermissions ?? []).some((rule) => rule.need === need);
        if (!declared) gaps.push(`${name}.${field} 未要求 ${need}`);
      }
    }

    expect(gaps).toEqual([]);
  });

  it('每条规则都区分「用了」和「没用」—— 传了默认值不该要求额外权限', () => {
    const rules = [...COMMAND_REGISTRY.values()].flatMap((def) => def.fieldPermissions ?? []);
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      // 空入参 = 什么都没用上，任何规则都不该触发
      expect(rule.used({})).toBe(false);
    }

    const discount = rules.find((r) => r.need === 'ticket.discount')!;
    expect(discount.used({ discountCents: 0 })).toBe(false);  // 结账的正常默认值
    expect(discount.used({ discountCents: 1 })).toBe(true);

    const overbook = rules.find((r) => r.field === 'override')!;
    expect(overbook.used({ override: undefined })).toBe(false);
    expect(overbook.used({ override: { reason: 'guest_requested' } })).toBe(true);
  });

  /**
   * 只有基础权限时，总线必须拒绝。
   *
   * 不连库：拒绝发生在 `withTenant` 之前，ctx 用字面量构造即可 ——
   * 这条用例要证明的正是「还没走到业务逻辑就被挡下了」。
   */
  it('持有基础权限但没有字段权限时，总线拒绝并点名字段', async () => {
    const ctx: CommandContext = {
      orgId: '11111111-1111-4111-8111-111111111111',
      locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      userId: null,
      membershipId: null,
      // 技师预设的核心两条：能开单、能建预约，但不能打折、不能超容量
      permissions: new Set<Permission>(['ticket.write', 'appointment.write']),
      actorKind: 'user',
      locale: 'en',
      timezone: 'America/New_York',
    };

    const cases = [
      {
        command: 'ticket.close',
        field: 'discountCents',
        need: 'ticket.discount',
        input: {
          ticketId: '00000000-0000-4000-8000-000000000001',
          payments: [{ method: 'cash', amountCents: 100 }],
          discountCents: 5000,
        },
      },
      {
        command: 'appointment.reschedule',
        field: 'override',
        need: 'appointment.overbook',
        input: {
          appointmentId: '00000000-0000-4000-8000-000000000002',
          startsAt: '2027-03-15T15:00:00.000Z',
          override: { reason: 'guest_requested' },
        },
      },
    ];

    for (const { command, field, need, input } of cases) {
      const error = await dispatch(command, input, ctx).then(
        () => null,
        (e: unknown) => e as AppError,
      );

      expect(error, `${command} 应当被拒绝`).toBeInstanceOf(AppError);
      expect(error!.code).toBe(ERROR_CODES.PERMISSION_DENIED);
      // 提示必须点名字段：「你不能改这一项」比笼统的「权限不足」可操作
      expect(error!.details).toMatchObject({ command, need, field });
    }
  });
});
