/**
 * 只读工具的服务端实现注册表
 *
 * ⚠️ **加工具之前先问一句：这份数据能不能一次性装进上下文？**
 *
 * 服务目录、员工花名册、房间、营业时间、套餐、排班、预约日历这七类
 * 已经随每轮请求直接下发（`queries/storeProfile.ts` 与
 * `queries/bookingCalendar.ts`），对应的工具已经下线。留在这里的只有
 * 三类真正装不下或算不出来的：量太大的（顾客、订单、评价）、
 * 必须服务端实算的（空档）、以及要签发令牌的（健康表链接）。
 *
 * 下线的工具名不是直接消失 —— 见 `RETIRED_TOOL_HINTS`：模型凭旧习惯
 * 报出旧名字时，回一句「这份数据在 <门店档案> 的 SERVICES 段里」
 * 比回「Tool not available」能让它少猜一轮。
 */

import type { CommandContext } from '@gf/contracts';
import { RETIRED_TOOL_HINTS } from '@gf/ai';
import { resolveCustomers, getCustomerDetailTool, listInactiveCustomers } from './customer.js';
import { planAppointmentSlots } from './appointment.js';
import {
  getRevenueAnalytics,
  searchOrders,
  getStoreReviews,
} from './analytics.js';
import { getHealthFormStatus, getHealthFormLink } from './healthForm.js';

export type ReadOnlyToolExecutor = (input: Record<string, unknown>) => Promise<unknown>;

export function createReadOnlyToolExecutors(
  ctx: CommandContext,
): Map<string, ReadOnlyToolExecutor> {
  const map = new Map<string, ReadOnlyToolExecutor>();

  // 客户（顾客表几千上万条，装不进上下文）
  map.set('resolve_customers', (input) => resolveCustomers(ctx, input));
  map.set('get_customer_detail', (input) => getCustomerDetailTool(ctx, input));
  map.set('list_inactive_customers', (input) => listInactiveCustomers(ctx, input));

  // 空档推荐（必须按班表、已占时段、并发上限服务端实算）
  map.set('plan_appointment_slots', (input) => planAppointmentSlots(ctx, input));

  // 报表与流水（量大且要聚合）
  map.set('get_revenue_analytics', (input) => getRevenueAnalytics(ctx, input));
  map.set('search_orders', (input) => searchOrders(ctx, input));
  map.set('get_store_reviews', (input) => getStoreReviews(ctx, input));

  // 健康免责表（链接要签发一次性令牌）
  map.set('get_health_form_status', (input) => getHealthFormStatus(ctx, input));
  map.set('get_health_form_link', (input) => getHealthFormLink(ctx, input));

  // 已下线的工具名：明确告诉模型去上下文的哪一段读，别让它再猜一轮
  for (const [name, hint] of Object.entries(RETIRED_TOOL_HINTS)) {
    map.set(name, async () => ({ retired: true, guidance: hint }));
  }

  return map;
}
