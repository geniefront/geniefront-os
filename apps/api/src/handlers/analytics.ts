/**
 * 经营分析写命令。只持久化已经生成好的摘要。
 * 模型调用必须留在事务外（见 businessSummary.ts）。
 */

import { SaveBusinessSummary } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SaveBusinessSummary, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveBusinessSummary.input._type>) => {
  const [saved] = await tx<{ id: string; generated_at: string }[]>`
    insert into ai_business_summaries
      (org_id, location_id, period_start, period_end, generator, generator_version,
       input_facts_sha256, input_record_count, content)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.periodStart}, ${input.periodEnd},
      ${input.generator}, ${input.generatorVersion}, ${input.inputFactsSha256},
      ${input.inputRecordCount}, ${jsonb(input.content)}::jsonb)
    on conflict (location_id, input_facts_sha256, generator_version) do nothing
    returning id, generated_at::text`;

  let summaryId = saved?.id;
  let generatedAt = saved?.generated_at;

  if (!summaryId || !generatedAt) {
    const [winner] = await tx<{ id: string; generated_at: string }[]>`
      select id, generated_at::text as generated_at from ai_business_summaries
      where location_id = ${ctx.locationId}
        and input_facts_sha256 = ${input.inputFactsSha256}
        and generator_version = ${input.generatorVersion}`;
    summaryId = winner!.id;
    generatedAt = winner!.generated_at;
  }

  audit({
    entityType: 'ai_business_summary',
    entityId: summaryId,
    after: {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      generator: input.generator,
      generatorVersion: input.generatorVersion,
      inputFactsSha256: input.inputFactsSha256,
      inputRecordCount: input.inputRecordCount,
    },
  });

  return {
    summaryId,
    generatedAt,
    highlights: input.content.highlights,
    risks: input.content.risks,
    actions: input.content.actions,
  };
});
