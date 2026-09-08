/**
 * 组合套餐（service bundle）命令契约（U10 / 计划 §5、§7）
 *
 * 组合套餐 = 一次消费里固定几个项目一起买、走固定组合价，当场展开成实际
 * 子项目履约。与次卡（marketing.ts 的 package.* / customer_packages）分开：
 * 次卡是购买后留在顾客账户、跨消费按次数核销的预付资产。
 *
 * 本文件只定义**目录管理**与**报价 / 展开**两类契约。创建（预约 / walk-in /
 * 直接开单）、结账、退款、提成、看板、导入等链路在计划 P2–P5 分别接入，
 * 届时复用这里的 `bundleQuote*` 结构与 `@gf/payroll` 的 allocateBundle。
 *
 * 错误语义：套餐相关的校验失败统一走 `VALIDATION_FAILED` + `details.reason`
 * 判别串（沿用仓库既有惯例，见 marketing / ticket handler），reason 取值：
 *   bundle_not_found | bundle_component_service_invalid | bundle_component_empty
 *   bundle_price_above_components | bundle_service_inactive | bundle_version_conflict
 *   bundle_addon_not_addon | bundle_cross_location
 *
 * 分摊口径：目录原价权重摊「套餐内建优惠」，下取整 + 余数分给 seq 末几项 ——
 * 复现计划 §6.1 示例表与 B20 / B32 的字面数字。纯计算在 `@gf/payroll`
 * 的 `allocateBundle`（U10 唯一实现）。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, i18nText } from '../command.js';

// ─────────────────────────────────────────────────────────── 目录管理

/** 模板的一个固定组成项。重复项目用 `qty` 表达，绝不对 serviceId 去重。 */
export const bundleComponentInput = z.object({
  serviceId: uuid,
  /** 重复几次，正整数（上限对齐 sql/0118 的 check）。 */
  qty: z.number().int().min(1).max(20).default(1),
  /** 模板内排序，决定展开顺序与分摊 tiebreak。 */
  seq: z.number().int().min(0).max(10_000).default(0),
  /**
   * 计入组成原价、随该子项目一起履约、但不额外收费的 add-on（计划 §4.2）。
   * 必须是本店 `is_addon = true` 的服务；额外购买的 add-on 不走这里。
   */
  includedAddonIds: z.array(uuid).max(20).default([]),
});
export type BundleComponentInput = z.infer<typeof bundleComponentInput>;

export const BundleSaveTemplate = defineCommand({
  name: 'bundle.saveTemplate',
  input: z.object({
    /** 不传即新建。 */
    bundleId: uuid.optional(),
    name: i18nText,
    /** 可空 i18n 描述。 */
    description: i18nText.nullable().optional(),
    /**
     * 固定组合价，整数分。服务端校验「不超过组成原价合计」（计划 §4.1）；
     * 零价是否允许复用门店免费服务权限，不静默免费。
     */
    priceCents: cents.nonnegative(),
    /** 至少两个执行单元（不同项目或同项目两次），由服务端按展开后校验。 */
    components: z.array(bundleComponentInput).min(1).max(20),
    /** 线上可预约资格；门店整体线上渠道仍独立校验。 */
    onlineBookable: z.boolean().optional(),
    active: z.boolean().optional(),
    sort: z.number().int().min(0).max(10_000).optional(),
    /**
     * 乐观锁：编辑时带上取到的 `version`，与库中不一致则
     * `VALIDATION_FAILED { reason: 'bundle_version_conflict' }`（计划 §5.3）。
     */
    expectedVersion: z.number().int().min(1).optional(),
  }),
  output: z.object({
    bundleId: uuid,
    created: z.boolean(),
    /** 保存后的新版本号（改价 / 改组成会递增）。 */
    version: z.number().int(),
  }),
  permission: 'catalog.manage',
  ai: {
    description: '创建或编辑组合套餐模板（名称、固定组合价、包含的项目与数量）。'
      + '这是「几个项目一起买走优惠总价」的套餐，不是按次核销的次卡。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const BundleArchiveTemplate = defineCommand({
  name: 'bundle.archiveTemplate',
  input: z.object({ bundleId: uuid }),
  output: z.object({ bundleId: uuid }),
  permission: 'catalog.manage',
  ai: {
    description: '下架一个组合套餐模板。历史订单不受影响 —— 名称与价格在下单时已快照。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── 拆单为单项

/**
 * 把工单上一份组合套餐拆回按锁定单项原价计费的普通项目（计划 §4.4，B14）。
 *
 * 仅限**未开工、未付款**：任一子项已 `started_at` 或工单已有 `payments` 即拒。
 * 拆后各子项 `total_cents` = 下单时锁定的 `bundle_list_price_cents`（子项之和 =
 * 实例 `original_total_cents`），四个 `bundle_*` 关联列清空；`order_bundle_instances`
 * 行保留并置 `status='split'` 作为来源凭据。首版不支持带额外加项 / 额外优惠的实例
 * （`bundle_split_with_extras_unsupported`）—— 那种走作废重建。
 */
export const BundleSplitInstance = defineCommand({
  name: 'bundle.splitInstance',
  input: z.object({
    ticketId: uuid,
    bundleInstanceId: uuid,
  }),
  output: z.object({
    ticketId: uuid,
    bundleInstanceId: uuid,
    splitItemCount: z.number().int(),
    subtotalCents: cents,
  }),
  permission: 'ticket.write',
  ai: {
    description: '把工单上的一份组合套餐拆成按原价单独计费的项目（仅未开工未付款时）。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── 报价 / 展开

/** 报价请求：一次选购的套餐 + 额外加项 + 额外整单优惠。 */
export const bundleQuoteRequest = z.object({
  bundleId: uuid,
  /**
   * 客户端取到的模板版本。给了就做一致性校验，防止「预览用旧版价格、
   * 落单时模板已改」（计划 §5.3）。
   */
  expectedVersion: z.number().int().min(1).optional(),
  /** 额外购买的加项，按正常价追加，不吃套餐折扣（计划 §4.2）。 */
  extraAddons: z.array(z.object({
    /** 调用方关联 ID，原样带回。 */
    ref: z.string().min(1).max(64),
    /** 挂在哪个执行单元上：`<componentId>#<unitIndex>`。 */
    attachToUnit: z.string().min(1).max(80),
    serviceId: uuid,
    qty: z.number().int().min(1).max(20).default(1),
  })).max(40).default([]),
  /**
   * 额外整单优惠分摊到本套餐实例的部分，整数分。
   * 典型：套餐锁价 $150，店主结账时再抹 $20 → 顾客付 $130，这 $20 传这里。
   */
  extraDiscountCents: cents.nonnegative().default(0),
  /**
   * 优惠类型，决定它是否落到套餐子项：
   *   `manual`（默认）—— 店主 / 前台权限内的手动折扣，作用于套餐子项 ＋ 额外加项；
   *   `coupon` —— 优惠券 / 自动促销，只摊到额外加项，不与套餐价叠加（计划 §4.5）。
   */
  extraDiscountKind: z.enum(['manual', 'coupon']).default('manual'),
});
export type BundleQuoteRequest = z.infer<typeof bundleQuoteRequest>;

/** 一个执行单元 = 一次可履约的子项目。 */
export const bundleQuoteUnit = z.object({
  componentId: uuid,
  serviceId: uuid,
  seq: z.number().int(),
  unitIndex: z.number().int(),
  unitKey: z.string(),
  listPriceCents: cents,
  bundleNetCents: cents,
  extraDiscountCents: cents,
  netCents: cents,
  /** 该执行单元的标准履约时长（组成服务 + 其包含加项的分钟数之和）。 */
  durationMin: z.number().int(),
  /** 该组成包含、随子项一起履约、不额外收费的 add-on 服务 ID（计划 §4.2）。 */
  includedAddonIds: z.array(uuid),
});
export type BundleQuoteUnit = z.infer<typeof bundleQuoteUnit>;

export const bundleQuoteResult = z.object({
  bundleId: uuid,
  version: z.number().int(),
  /** 下单时锁定用的 i18n 名称快照。 */
  nameSnapshot: z.record(z.string(), z.string()),
  units: z.array(bundleQuoteUnit),
  extraAddons: z.array(z.object({
    ref: z.string(),
    attachToUnit: z.string(),
    /** 归属到第几个执行单元（`units` 的下标）。 */
    unitOrdinal: z.number().int(),
    serviceId: uuid,
    qty: z.number().int(),
    listPriceCents: cents,
    extraDiscountCents: cents,
    netCents: cents,
    durationMin: z.number().int(),
  })),
  originalTotalCents: cents,
  bundlePriceCents: cents,
  bundleDiscountCents: cents,
  extraAddonListTotalCents: cents,
  extraDiscountCents: cents,
  serviceNetTotalCents: cents,
});
export type BundleQuoteResult = z.infer<typeof bundleQuoteResult>;

// ⚠️ 报价是**只读查询**，不是命令 —— 命令总线要求每条命令都留审计，套餐报价
// 会被前端预览高频调用。实现是 `apps/api/src/queries/bundle.ts::quoteBundle`
// （纯载入 + `@gf/payroll` 的 allocateBundle），创建 / 结账链路直接调它，
// 前端走只读路由。上面的 `bundleQuoteRequest` / `bundleQuoteResult` 供两侧共享类型。

export const BUNDLE_COMMANDS = [
  BundleSaveTemplate,
  BundleArchiveTemplate,
  BundleSplitInstance,
] as const;
