/**
 * 组合套餐（service bundle）—— 目录模板 + 订单实例（U10 / 计划 §5）
 *
 * 与次卡（`package_templates` / `customer_packages`，见 marketing.ts）是两回事：
 *   次卡  = 购买后留在顾客账户，跨消费按次数核销的预付资产。
 *   套餐  = 一次消费里固定几个项目一起买、走固定组合价，当场展开成实际子项。
 *
 * 不变量（计划 §5.3，纯计算部分在 `@gf/payroll` 的 allocateBundle）：
 *   · 模板 ID 不是订单分组 ID —— 买两份产生两个 order_bundle_instances。
 *   · component ID 不是重复执行单元 ID —— qty=2 在下单时展开成两个 item，
 *     各带 (bundle_instance_id, bundle_component_id, bundle_unit_index)。
 *   · 父套餐没有独立收款行，也不占资源 / 不计轮 —— 这里没有「父 service」行。
 *   · 历史财务字段不随模板更新重写：下单把价格 / 名称 / 版本快照进实例。
 *
 * 迁移见 `packages/db/sql/0118_service_bundles.sql`（建表 + RLS + 授权 + 执行项
 * 关联列）。本文件是 drizzle 查询构建器的类型来源，须与该 SQL 保持一致。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { customers, services, appointments } from './scheduling';
import { tickets } from './tickets';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ─────────────────────────────────────────────────────────── 目录：模板

export const serviceBundles = pgTable('service_bundles', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  /** i18n 名称。 */
  name: jsonb('name').notNull(),
  /** i18n 描述，可空。 */
  description: jsonb('description'),
  /** 固定组合价，整数分。校验「不超过组成原价合计」在 handler / 纯函数里做。 */
  priceCents: integer('price_cents').notNull(),
  /** 线上可预约资格；门店整体线上渠道仍独立校验。 */
  onlineBookable: boolean('online_bookable').notNull().default(false),
  active: boolean('active').notNull().default(true),
  /**
   * 模板版本。改价 / 改组成时递增；下单把当时版本快照进
   * `order_bundle_instances.template_version`，停用或改价不影响历史订单。
   */
  version: integer('version').notNull().default(1),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
  /** 由 service_bundles_touch_updated_at 触发器维护（复用 gf_touch_updated_at）。 */
  updatedAt: updatedAt(),
}, (t) => [
  index('service_bundles_location_idx').on(t.locationId, t.active),
]);

/**
 * 模板的固定组成项。重复项目按 qty 表达，下单按执行单元展开 ——
 * 绝不对 service_id 去重（计划 §4.1 / §5.3）。
 */
export const serviceBundleComponents = pgTable('service_bundle_components', {
  /** 模板内稳定的组成 ID。下单后 appointment_items / ticket_items 用它做来源关联。 */
  id: id(),
  bundleId: uuid('bundle_id').notNull()
    .references(() => serviceBundles.id, { onDelete: 'cascade' }),
  orgId: orgCol(),
  locationId: locCol(),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  /** 该组成重复几次，正整数（迁移里 check 1–20）。 */
  qty: integer('qty').notNull().default(1),
  /** 模板内排序，决定展开顺序与分摊 tiebreak。 */
  seq: integer('seq').notNull().default(0),
  /**
   * 计入组成、随该子项目一起履约、但**不额外收费**的 add-on（计划 §4.2）。
   * 引用 services 里 is_addon = true 的行；额外购买的 add-on 不走这里。
   */
  includedAddonIds: uuid('included_addon_ids').array().notNull().default(sql`'{}'::uuid[]`),
  createdAt: createdAt(),
}, (t) => [
  index('service_bundle_components_bundle_idx').on(t.bundleId, t.seq),
  index('service_bundle_components_service_idx').on(t.serviceId),
]);

// ─────────────────────────────────────────────────────────── 订单：套餐实例

/**
 * 某次预约 / 工单实际选购的一份套餐。买两份 = 两行。
 * 预约转工单保留同一实例身份（同一行先挂 appointment_id，开单时补 ticket_id）。
 */
export const orderBundleInstances = pgTable('order_bundle_instances', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  customerId: uuid('customer_id').references(() => customers.id),
  /** 归属：至少一个非空（迁移里 check）。预约转工单时同一行两个都填。 */
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  /** 模板引用，可空（模板可能被删；名称 / 价格已快照）。 */
  bundleId: uuid('bundle_id').references(() => serviceBundles.id),
  /** 下单时锁定的模板版本。 */
  templateVersion: integer('template_version').notNull(),
  /** 下单时的 i18n 名称快照。 */
  nameSnapshot: jsonb('name_snapshot').notNull(),
  /** 组成原价合计（不含额外加项），整数分。 */
  originalTotalCents: integer('original_total_cents').notNull(),
  /** 锁定的固定组合价，整数分。 */
  bundlePriceCents: integer('bundle_price_cents').notNull(),
  /** 套餐内建优惠 = original_total_cents − bundle_price_cents（迁移里 check 相等）。 */
  discountCents: integer('discount_cents').notNull(),
  /** 额外整单优惠分摊到本实例的部分；套餐内建优惠与它分开记（计划 §4.5）。 */
  extraDiscountCents: integer('extra_discount_cents').notNull().default(0),
  /** 创建来源：desk | walkin | booking | kiosk | import | copilot。 */
  source: text('source').notNull().default('desk'),
  /** active | split（已拆为单项）| cancelled。 */
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('order_bundle_instances_appointment_idx').on(t.appointmentId),
  index('order_bundle_instances_ticket_idx').on(t.ticketId),
  index('order_bundle_instances_bundle_idx').on(t.bundleId),
  index('order_bundle_instances_customer_idx').on(t.customerId),
]);

// ─────────────────────────────────────────────────────────── 执行项关联列
//
// appointment_items / ticket_items 的套餐关联列（bundle_instance_id、
// bundle_component_id、bundle_unit_index、bundle_list_price_cents）为可空，
// 由 sql/0118 以 alter table 补上；普通历史行全部为空。drizzle schema 里
// 那两张表的定义分别在 scheduling.ts / tickets.ts，为减小改动面不在此处
// 重复声明 —— 需要时用 sql`` 原样读取（同 addon_ids 的处理方式）。
