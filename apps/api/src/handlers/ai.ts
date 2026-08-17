/**
 * 副驾用量的落库（05 §7.3）
 *
 * 一条命令做两件必须一起成功或一起失败的事：
 *   1. 往 `usage_events` 记一条（成本报表、额度包定价的计算基础）
 *   2. 从 `credit_ledger` 扣一笔（决策 8 的预充值余额）
 *
 * 分开的话，中间挂掉就会留下「用量记了但没扣钱」或者反过来 ——
 * 两种漂移都要到月底对账时才被发现，那时候已经查不清是哪几次调用。
 */

import { RecordAiAssist } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { chargeQuota } from '../billing/usage';
import { creditsFor } from '@gf/payroll';

registerHandler(RecordAiAssist, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordAiAssist.input._type>) => {
  const [usageRow] = await tx<{ id: string }[]>`
    insert into usage_events (org_id, location_id, kind, qty, cost_cents, meta)
    values (${ctx.orgId}, ${ctx.locationId}, 'ai_assist',
            ${input.tokens},
            ${Math.round(input.costMillicents / 1000)},
            ${jsonb({
              feature: input.feature,
              model: input.model,
              // ⭐ 精确的毫分进 meta。cost_cents 存整数分（表结构如此），
              // 而一次调用一两分钱，四舍五入到分之后按月加总会漂出百分之几 ——
              // 那是副驾额度包定价的计算基础（决策 8），漂不得
              costMillicents: input.costMillicents,
              rounds: input.rounds,
              hadProposal: input.hadProposal,
            })}::jsonb)
    returning id`;

  /**
   * 扣积分。**1 积分 = $0.01 的真实成本，向上取整**（`@gf/payroll` 的长注释）。
   *
   * ⚠️ 关键词直接答掉的那些**根本不会走到这里** —— 副驾路由在本地
   * 答完就返回了，压根不调这条命令。所以「常用查询不算积分」
   * 不是一段判断，是一条根本没有发生的调用。
   */
  const credits = creditsFor(input.costMillicents);
  const charge = await chargeQuota(tx, ctx, {
    unit: 'credit',
    amount: credits,
    usageEventId: usageRow!.id,
    source: input.feature,
  });

  audit({
    entityType: 'usage_event', entityId: usageRow!.id,
    after: {
      feature: input.feature,
      model: input.model,
      tokens: input.tokens,
      rounds: input.rounds,
      hadProposal: input.hadProposal,
      credits,
      fromIncluded: charge?.fromIncluded ?? 0,
      fromBalance: charge?.fromBalance ?? 0,
    },
  });

  return {
    usageEventId: usageRow!.id,
    credits,
    fromIncluded: charge?.fromIncluded ?? 0,
    fromBalance: charge?.fromBalance ?? 0,
    includedRemaining: charge?.includedRemaining ?? 0,
    balanceAfter: charge?.balanceAfter ?? 0,
  };
});
