/**
 * 组合套餐定价与分摊 —— 唯一的纯计算实现（U10 / 计划 §6）。
 *
 * 这个模块只做算术，不碰数据库、不查目录、不鉴权。命令处理层负责
 * 查询、锁、事务和权限，把「已经锁定的目录快照」喂进来，拿回
 * 「每个执行单元该记多少钱」。创建入口、预览、结账复核共用它 ——
 * 三条路各自 Math.round 一次，就会得出三个总额，而且只在特定金额上
 * 差一分，测不出来、查不到，最后是技师发现的（同 `split.ts` 的教训）。
 *
 * 不变量（计划 §5.3）：
 *   1. 每个套餐实例各执行单元的 `bundleNetCents` 之和 === 锁定的套餐价。
 *   2. 每笔额外优惠的分摊之和 === 该笔优惠；任何明细净额非负。
 *   3. component ID 不是执行单元 ID —— qty=2 展开成两个带 `unitIndex` 的单元，
 *      对 serviceId 去重会丢掉一份。
 *   4. 父套餐没有独立收款行；额外加项不吃套餐折扣（计划 §4.2）。
 *
 * ── 分摊方法（已定，见实施报告「决策 #1」）────────────────────────────────
 * 按**原价权重分摊套餐内建优惠**（= 原价合计 − 组合价），取整规则为
 * 「按权重下取整、余数分给排在后面的组成（seq 升序里的末几项，跳过零价项）」。
 * 这一规则可复现计划 §6.1 示例表与 B20 / B32 的字面数字（A=8824 / C=1764，
 * 退 C = 1764、剩余 13236）。它与 `split.ts` 的 `largestRemainderSplit`
 * （提成 / 小费 / 组单收款用的最大余数法）取整偏向不同 —— 套餐这里以规格
 * 的验收数字为准，不复用那一个。两法结果之和都精确、都确定。
 */

/**
 * 按权重把 `total` 分成 `weights.length` 份：下取整 + 余数分给末几项。
 *
 * @param total   非负整数分。
 * @param weights 非负整数权重（这里是各组成的目录原价）。
 * @returns 各份之和恒等于 `total`；`weights[i] === 0` 的项永远拿 0。
 */
function apportionFloorTrailing(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total === 0) return weights.map(() => 0);

  const sumW = weights.reduce((a, b) => a + b, 0);
  // 调用方已保证 total <= sumW 且 sumW > 0（total > 0 时）。
  const shares = weights.map((w) => Math.floor((total * w) / sumW));
  let leftover = total - shares.reduce((a, b) => a + b, 0);

  // 余数一分一分地分给排在后面、且权重 > 0 的组成。
  for (let i = n - 1; i >= 0 && leftover > 0; i -= 1) {
    if (weights[i]! > 0) { shares[i] = shares[i]! + 1; leftover -= 1; }
  }
  // 兜底：末尾若全是零价项没接住（几乎不可能），给权重最大的一项。
  if (leftover > 0) {
    let maxI = 0;
    for (let i = 1; i < n; i += 1) if (weights[i]! > weights[maxI]!) maxI = i;
    shares[maxI] = shares[maxI]! + leftover;
  }
  return shares;
}

/** 套餐模板里的一个组成项（已锁定的目录快照）。 */
export interface BundleComponentSpec {
  /** 模板内稳定的组成 ID（`service_bundle_components.id`）。 */
  componentId: string;
  serviceId: string;
  /**
   * 该组成**单份**的目录原价，整数分。
   * 若模板把某些 add-on 计入组成（计划 §4.2「模板内包含的 add-on 计入
   * 原价基础但不额外收费」），调用方应在传入前把这部分并进来。
   */
  listPriceCents: number;
  /** 该组成在套餐里重复几次，正整数。 */
  qty: number;
  /** 模板内稳定排序，决定展开顺序与「余数分给末项」的落点。 */
  seq: number;
}

/** 一次消费里额外购买的加项（不在模板包含范围内，按正常价追加）。 */
export interface BundleExtraAddonSpec {
  /** 调用方自己的关联 ID，原样带回。 */
  ref: string;
  /** 挂在哪个执行单元上（`<componentId>#<unitIndex>`），仅作归属记录。 */
  attachToUnit: string;
  /** 单价，整数分。 */
  listPriceCents: number;
  /** 数量，默认 1。 */
  qty?: number;
}

export interface AllocateBundleInput {
  components: readonly BundleComponentSpec[];
  /** 锁定的固定组合价（整个套餐），整数分。 */
  bundlePriceCents: number;
  /** 额外加项，可空。 */
  extraAddons?: readonly BundleExtraAddonSpec[];
  /**
   * 额外整单优惠（券 / 手动折扣）分摊到本套餐实例的部分，整数分。
   * 套餐内建优惠（原价 − 套餐价）与它分开记录（计划 §4.5）。
   */
  extraDiscountCents?: number;
  /**
   * 额外整单优惠是否落到**套餐子项**净额上。
   *
   * 默认 `false` —— 大多数店：券 / 自动优惠不与套餐价叠加（计划 §4.5
   * 「默认套餐部分不自动叠加优惠券」），额外优惠只摊到额外加项。
   * 需要「权限内的手动优惠也作用于套餐子项」的店把它设 `true`
   * （手动优惠的范围 / 上限仍由服务端按权限校验）。
   */
  bundleUnitsEligibleForExtraDiscount?: boolean;
}

/** 一个执行单元 = 一次可履约的子项目。 */
export interface BundleUnitAllocation {
  componentId: string;
  serviceId: string;
  seq: number;
  /** 同一组成的第几份，0 基。 */
  unitIndex: number;
  /** `<componentId>#<unitIndex>`，额外加项的归属键。 */
  unitKey: string;
  /** 该单元的目录原价（整数分）。 */
  listPriceCents: number;
  /** 该单元分得的套餐价份额（整数分），Σ === bundlePriceCents。 */
  bundleNetCents: number;
  /** 该单元分得的额外优惠（整数分，非负）。 */
  extraDiscountCents: number;
  /** 最终净额 = bundleNetCents − extraDiscountCents（非负）。 */
  netCents: number;
}

export interface BundleExtraAddonAllocation {
  ref: string;
  attachToUnit: string;
  qty: number;
  listPriceCents: number;
  extraDiscountCents: number;
  netCents: number;
}

export interface AllocateBundleResult {
  units: BundleUnitAllocation[];
  extraAddons: BundleExtraAddonAllocation[];
  /** 套餐组成的原价合计（不含额外加项）。 */
  originalTotalCents: number;
  bundlePriceCents: number;
  /** 套餐内建优惠 = originalTotalCents − bundlePriceCents（非负）。 */
  bundleDiscountCents: number;
  extraAddonListTotalCents: number;
  extraDiscountCents: number;
  /** 服务侧净额合计（各单元 netCents + 各额外加项 netCents）。 */
  serviceNetTotalCents: number;
}

export class BundlePricingError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ? `${reason}: ${message}` : reason);
    this.name = 'BundlePricingError';
    this.reason = reason;
  }
}

function assertInt(label: string, v: number): void {
  if (!Number.isInteger(v)) throw new BundlePricingError('non_integer_cents', `${label} 必须是整数分：${v}`);
}

/**
 * 展开套餐、锁定报价、分摊组合价、并入额外加项、分摊额外优惠。
 *
 * 纯函数：同样的输入永远给同样的输出，不依赖数据库返回顺序。
 */
export function allocateBundle(input: AllocateBundleInput): AllocateBundleResult {
  const { components, bundlePriceCents } = input;
  const extraDiscountCents = input.extraDiscountCents ?? 0;
  const bundleEligible = input.bundleUnitsEligibleForExtraDiscount ?? false;

  assertInt('bundlePriceCents', bundlePriceCents);
  assertInt('extraDiscountCents', extraDiscountCents);
  if (bundlePriceCents < 0) throw new BundlePricingError('negative_bundle_price', '套餐价不能为负');
  if (extraDiscountCents < 0) throw new BundlePricingError('negative_extra_discount', '额外优惠不能为负');
  if (components.length === 0) throw new BundlePricingError('empty_bundle', '套餐至少要有一个组成');

  // ── 1. 规范执行单元（先展开，再分摊；qty 重复项目不丢失，计划 §6）──────────
  const expanded: Array<Omit<BundleUnitAllocation, 'bundleNetCents' | 'extraDiscountCents' | 'netCents'>> = [];
  for (const c of [...components].sort((a, b) => a.seq - b.seq || (a.componentId < b.componentId ? -1 : 1))) {
    assertInt(`component ${c.componentId} listPriceCents`, c.listPriceCents);
    if (c.listPriceCents < 0) throw new BundlePricingError('negative_component_price', `组成 ${c.componentId} 原价为负`);
    if (!Number.isInteger(c.qty) || c.qty < 1) {
      throw new BundlePricingError('invalid_component_qty', `组成 ${c.componentId} 的数量必须是正整数`);
    }
    for (let unitIndex = 0; unitIndex < c.qty; unitIndex += 1) {
      expanded.push({
        componentId: c.componentId,
        serviceId: c.serviceId,
        seq: c.seq,
        unitIndex,
        unitKey: `${c.componentId}#${unitIndex}`,
        listPriceCents: c.listPriceCents,
      });
    }
  }

  const originalTotalCents = expanded.reduce((n, u) => n + u.listPriceCents, 0);

  // 计划 §6：全部权重为零时只允许零套餐价，否则报校验错误。
  // 先于「不超过原价合计」判：原价合计为 0 时两者都成立，这一条诊断更明确。
  if (originalTotalCents === 0 && bundlePriceCents !== 0) {
    throw new BundlePricingError('zero_weight_nonzero_price', '组成原价合计为 0 时套餐价必须为 0');
  }
  // 计划 §4.1：首版组合价不超过组成原价合计。
  if (bundlePriceCents > originalTotalCents) {
    throw new BundlePricingError('bundle_price_above_components',
      `套餐价 ${bundlePriceCents} 高于组成原价合计 ${originalTotalCents}`);
  }

  // ── 2. 分摊固定组合价：按原价权重摊「套餐内建优惠」，净额 = 原价 − 优惠份额 ──
  const bundleDiscountCents = originalTotalCents - bundlePriceCents;
  const discountByUnit = apportionFloorTrailing(bundleDiscountCents, expanded.map((u) => u.listPriceCents));
  const bundleNetByUnit = expanded.map((u, i) => u.listPriceCents - discountByUnit[i]!);

  // ── 3. 额外加项：按正常价追加，不吃套餐折扣（计划 §4.2）──────────────────
  const extraAddons: BundleExtraAddonAllocation[] = (input.extraAddons ?? []).map((a) => {
    assertInt(`extra addon ${a.ref} listPriceCents`, a.listPriceCents);
    if (a.listPriceCents < 0) throw new BundlePricingError('negative_addon_price', `额外加项 ${a.ref} 价格为负`);
    const qty = a.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1) throw new BundlePricingError('invalid_addon_qty', `额外加项 ${a.ref} 数量非法`);
    return {
      ref: a.ref,
      attachToUnit: a.attachToUnit,
      qty,
      listPriceCents: a.listPriceCents * qty,
      extraDiscountCents: 0,
      netCents: a.listPriceCents * qty,
    };
  });
  const extraAddonListTotalCents = extraAddons.reduce((n, a) => n + a.listPriceCents, 0);

  // ── 4. 分摊额外整单优惠 ────────────────────────────────────────────────
  //  默认只摊到额外加项净额（计划 §4.5：套餐部分不自动叠加优惠券）；
  //  bundleUnitsEligibleForExtraDiscount=true 时也摊到套餐子项净额。
  const eligibleWeights = [
    ...bundleNetByUnit.map((net) => (bundleEligible ? net : 0)),
    ...extraAddons.map((a) => a.netCents),
  ];
  const eligibleTotal = eligibleWeights.reduce((a, b) => a + b, 0);
  if (extraDiscountCents > eligibleTotal) {
    throw new BundlePricingError('extra_discount_exceeds_eligible',
      `额外优惠 ${extraDiscountCents} 超过可分摊净额 ${eligibleTotal}`);
  }
  const extraDiscShares = apportionFloorTrailing(extraDiscountCents, eligibleWeights);

  // ── 5. 组装结果 ──────────────────────────────────────────────────────────
  const units: BundleUnitAllocation[] = expanded.map((u, i) => {
    const bundleNetCents = bundleNetByUnit[i]!;
    const disc = extraDiscShares[i]!;
    return { ...u, bundleNetCents, extraDiscountCents: disc, netCents: bundleNetCents - disc };
  });

  extraAddons.forEach((a, j) => {
    a.extraDiscountCents = extraDiscShares[expanded.length + j]!;
    a.netCents = a.listPriceCents - a.extraDiscountCents;
  });

  const serviceNetTotalCents = units.reduce((n, u) => n + u.netCents, 0)
    + extraAddons.reduce((n, a) => n + a.netCents, 0);

  return {
    units,
    extraAddons,
    originalTotalCents,
    bundlePriceCents,
    bundleDiscountCents,
    extraAddonListTotalCents,
    extraDiscountCents,
    serviceNetTotalCents,
  };
}

/**
 * 退款可退余额（计划 §6：按最终已支付明细净额计算，扣除历史已退）。
 *
 * 纯算术：给定某执行单元的最终净额和它已退过的累计，返回还能退多少。
 * 有额外优惠 / 税 / 费时，调用方传进来的 `finalNetCents` 必须是**分摊后**
 * 的净额，不是套餐目录原价（计划 §6「有额外优惠时不能直接退 1764」）。
 */
export function refundableForUnit(finalNetCents: number, alreadyRefundedCents: number): number {
  assertInt('finalNetCents', finalNetCents);
  assertInt('alreadyRefundedCents', alreadyRefundedCents);
  return Math.max(0, finalNetCents - alreadyRefundedCents);
}
