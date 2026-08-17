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
import { chargeUsage } from '../billing/usage';

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

  const charge = await chargeUsage(tx, ctx, {
    kind: 'ai_assist',
    costMillicents: input.costMillicents,
    usageEventId: usageRow!.id,
  });

  audit({
    entityType: 'usage_event', entityId: usageRow!.id,
    after: {
      feature: input.feature,
      model: input.model,
      tokens: input.tokens,
      rounds: input.rounds,
      hadProposal: input.hadProposal,
      chargedCents: charge?.chargedCents ?? 0,
    },
  });

  return {
    usageEventId: usageRow!.id,
    chargedCents: charge?.chargedCents ?? 0,
    balanceAfterCents: charge?.balanceAfterCents ?? null,
  };
});
