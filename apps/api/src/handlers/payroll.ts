/**
 * 薪酬方案命令实现。
 *
 * 方案版本化：每次保存都是新版本，历史 earnings 一行不动。
 * 老板周三改提成率，技师周一看到的数字不会跟着变 —— 这一条是这个功能能不能被信任的前提。
 */

import { SavePlan, type CommandContext } from '@gf/contracts';
import { assertValidPlan, DEFAULT_PLAN, type CompensationPlan } from '@gf/payroll';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SavePlan, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePlan.input._type>) => {
  const plan: CompensationPlan = {
    kind: input.kind,
    rateBp: input.rateBp,
    categoryRateBp: input.categoryRateBp,
    retailRateBp: input.retailRateBp,
    hourlyRateCents: input.hourlyRateCents,
    base: input.base,
    // 双技师营业额分摊权重跟小费默认口径一致，暂不开放单独配置：
    // 多一个旋钮就多一处能把两边调歪的地方
    roleWeightBp: DEFAULT_PLAN.roleWeightBp,
  };
  assertValidPlan(plan);

  const [prev] = await tx<{ v: number }[]>`
    select coalesce(max(version), 0)::int as v from compensation_plans
    where location_id = ${ctx.locationId}
      and membership_id is not distinct from ${input.membershipId}`;
  const version = (prev?.v ?? 0) + 1;

  const [row] = await tx<{ id: string }[]>`
    insert into compensation_plans
      (org_id, location_id, membership_id, version, config, created_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.membershipId}, ${version},
            ${jsonb(plan)}::jsonb, ${ctx.membershipId})
    returning id`;

  // 提成率不是「金额」，照常进审计 ——
  // 「谁把提成从 45% 改成 35% 的」恰恰是最该留痕的一类操作（宪法第 17 条只管金额）
  audit({
    entityType: 'compensation_plan', entityId: row!.id,
    after: {
      membershipId: input.membershipId,
      kind: input.kind, rateBp: input.rateBp, base: input.base,
      hourlyRateCents: input.hourlyRateCents, version,
    },
  });

  return { planId: row!.id, version };
});

export type { CommandContext };
