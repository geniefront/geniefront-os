/**
 * 只读领域工具汇总与注册 (29 §4.2, §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { resolveCustomers, getCustomerDetailTool, listInactiveCustomers } from './customer.js';
import { planAppointmentSlots, searchAppointments } from './appointment.js';
import { getStaffDirectory, getStaffSchedules } from './schedule.js';
import { listRooms } from './resource.js';
import { getServiceCatalog } from './service.js';
import {
  getRevenueAnalytics,
  searchOrders,
  getStoreReviews,
  getPromotionsAndCards,
  getStoreInfo,
} from './analytics.js';
import { validateTaskDraft } from './validation.js';
import { getQueueStatus } from './queue.js';
import { getHealthFormStatus, getHealthFormLink } from './healthForm.js';

export function createReadOnlyToolExecutors(
  ctx: CommandContext,
): Map<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const map = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();

  // 客户
  map.set('resolve_customers', (input) => resolveCustomers(ctx, input));
  map.set('find_customer', (input) => resolveCustomers(ctx, input)); // 兼容别名
  map.set('get_customer_detail', (input) => getCustomerDetailTool(ctx, input));
  map.set('list_inactive_customers', (input) => listInactiveCustomers(ctx, input));

  // 预约与排期
  map.set('plan_appointment_slots', (input) => planAppointmentSlots(ctx, input));
  map.set('find_open_slots', (input) => planAppointmentSlots(ctx, input)); // 兼容别名
  map.set('search_appointments', (input) => searchAppointments(ctx, input));
  map.set('get_day_overview', (input) => searchAppointments(ctx, input)); // 兼容别名
  map.set('get_appointments', (input) => searchAppointments(ctx, input)); // 兼容别名

  // 员工与排班
  map.set('get_staff_directory', (input) => getStaffDirectory(ctx, input));
  map.set('list_staff_skills', (input) => getStaffDirectory(ctx, input)); // 兼容别名
  map.set('get_staff_schedules', (input) => getStaffSchedules(ctx, input));

  // 候客队列
  map.set('get_queue_status', (input) => getQueueStatus(ctx, input));

  // 健康免责表
  map.set('get_health_form_status', (input) => getHealthFormStatus(ctx, input));
  map.set('get_health_form_link', (input) => getHealthFormLink(ctx, input));

  // 房态
  map.set('list_rooms', (input) => listRooms(ctx, input));

  // 服务
  map.set('get_service_catalog', (input) => getServiceCatalog(ctx, input));

  // 经营报表与信息
  map.set('get_revenue_analytics', (input) => getRevenueAnalytics(ctx, input));
  map.set('search_orders', (input) => searchOrders(ctx, input));
  map.set('get_store_reviews', (input) => getStoreReviews(ctx, input));
  map.set('get_promotions_and_cards', (input) => getPromotionsAndCards(ctx, input));
  map.set('get_store_info', (input) => getStoreInfo(ctx, input));

  // 预检
  map.set('validate_task_draft', (input) => validateTaskDraft(ctx, input));

  return map;
}
