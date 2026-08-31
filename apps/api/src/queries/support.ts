/**
 * 客户自己那一侧的工单列表（AUD-08）。
 *
 * ## 为什么必须有
 *
 * 修 QA-006 时补的是「客户没地方提工单」，于是加了一个提交表单就收工了。
 * 但工单不是投递口，是一段有状态的对话：平台可以把状态改成 `waiting`
 * （字面意思是「等客户回话」），而客户那边**没有任何东西显示**。
 * 提完就石沉大海，连「收到了没有」都看不到。
 *
 * ## ⛔ 这里绝不 join `support_request_notes`
 *
 * 那张表是运营的内部备注（「这家店月底要退订，先别答应加功能」这一类）。
 * sql/0077 已经把它的 RLS 收成「必须是 active 运营」，所以这里就算写错
 * 也查不出东西 —— 但**别依赖那一层**：查询本身就不该提到那张表。
 * 两道都在，才是「即使有人改错一处也不会漏」。
 *
 * 客户能看到的只有：自己提的内容、当前状态、以及「客服最后一次动它是什么时候」。
 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';

export interface SupportRequestSummary {
  id: string;
  category: string;
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
  priority: string;
  createdAt: string;
  /** 客服最后一次改状态或加备注的时刻。备注内容不给。 */
  lastOperatorUpdateAt: string | null;
  resolvedAt: string | null;
}

export async function loadMySupportRequests(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  limit = 50,
): Promise<{ requests: SupportRequestSummary[] }> {
  const rows = await tx<{
    id: string; category: string; subject: string; description: string;
    status: string; priority: string;
    created_at: string; last_operator_update_at: string | null; resolved_at: string | null;
  }[]>`
    select id, category, subject, description, status, priority,
           created_at::text as created_at,
           last_operator_update_at::text as last_operator_update_at,
           resolved_at::text as resolved_at
    from support_requests
    where location_id = ${ctx.locationId}
    order by created_at desc
    limit ${Math.min(Math.max(limit, 1), 100)}`;

  return {
    requests: rows.map((r) => ({
      id: r.id,
      category: r.category,
      subject: r.subject,
      description: r.description,
      status: r.status as SupportRequestSummary['status'],
      priority: r.priority,
      createdAt: r.created_at,
      lastOperatorUpdateAt: r.last_operator_update_at,
      resolvedAt: r.resolved_at,
    })),
  };
}
