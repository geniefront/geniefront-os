/**
 * AI 电话线的就绪五态推导（S4）。
 *
 * 开店向导「功能设置」步骤（`queries/setupReadiness.ts`）和「来电记录」页
 * （`routes/misc.ts` 的 `/v1/desk/calls`）共用这一个 loader —— 两处不再
 * 各自判断「这条线到底能不能接」。
 *
 * 判据全部来自持久化证据（`phone_lines` + `locations.settings.features`）：
 *   · 意愿      —— `features.ai_voice_requested`（老店缺字段 = null）
 *   · 已绑      —— 有 active 的 `ai_voice` 线
 *   · 本地就绪  —— 已绑 且 `tool_token_digest` 非空
 *   · 有效接听  —— `ai_answer = true` 且本地就绪（fail-closed）
 *   · 已暂停    —— 意愿仍为 true，但曾绑过的落地号现在 `active = false`
 *
 * ⚠️ `assistant_id`（Telnyx 侧）只读出来展示，不参与 `ready`：assistant
 * 建在供应商那边，本仓库种子与测试都不写它（S1 §5）。
 */

import type postgres from 'postgres';
import type { CommandContext, AiVoiceReadiness, AiVoiceState } from '@gf/contracts';

interface AiVoiceRow {
  intent: boolean | null;
  active_line_bound: boolean;
  assistant_configured: boolean;
  tool_token_set: boolean;
  ai_answer: boolean;
  inactive_line_exists: boolean;
}

export async function loadAiVoiceReadiness(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'locationId'>,
): Promise<AiVoiceReadiness> {
  const [row] = await tx<AiVoiceRow[]>`
    select
      case when l.settings #> '{features}' ? 'ai_voice_requested'
        then (l.settings #>> '{features,ai_voice_requested}')::boolean else null end as intent,
      exists (
        select 1 from phone_lines p
        where p.location_id = l.id and p.purpose = 'ai_voice' and p.active
      ) as active_line_bound,
      exists (
        select 1 from phone_lines p
        where p.location_id = l.id and p.purpose = 'ai_voice' and p.active
          and p.assistant_id is not null
      ) as assistant_configured,
      exists (
        select 1 from phone_lines p
        where p.location_id = l.id and p.purpose = 'ai_voice' and p.active
          and p.tool_token_digest is not null
      ) as tool_token_set,
      coalesce((
        select p.ai_answer from phone_lines p
        where p.location_id = l.id and p.purpose = 'ai_voice' and p.active
        limit 1
      ), false) as ai_answer,
      exists (
        select 1 from phone_lines p
        where p.location_id = l.id and p.purpose = 'ai_voice' and not p.active
      ) as inactive_line_exists
    from locations l where l.id = ${ctx.locationId}`;

  const intent = row?.intent ?? null;
  const lineBound = row?.active_line_bound ?? false;
  const assistantConfigured = row?.assistant_configured ?? false;
  const toolTokenSet = row?.tool_token_set ?? false;
  const ready = lineBound && toolTokenSet;
  const effectiveAiAnswer = ready && (row?.ai_answer ?? false);

  let state: AiVoiceState;
  if (ready && effectiveAiAnswer) {
    state = 'on';
  } else if (ready) {
    state = 'ready_off';
  } else if (intent === true && (row?.inactive_line_exists ?? false)) {
    // 曾经绑过、现在被停用：平台侧撤下了这条线，需要重新开通。
    state = 'suspended';
  } else if (intent === true || lineBound) {
    // 已表达意愿（人工开通中），或号已绑但 token 还没铸好。
    state = 'requested';
  } else {
    state = 'unconfigured';
  }

  return {
    intent,
    lineBound,
    assistantConfigured,
    toolTokenSet,
    ready,
    effectiveAiAnswer,
    state,
  };
}
