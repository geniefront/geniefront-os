/**
 * 提成引擎 v1（03 §B Phase 1b，宪法第 2/4 条）
 *
 * 三条不可动摇的规则，全部写死在这里而不是配置里：
 *
 *   1. **小费永不进提成基数**。tip 在法律上不是门店收入，
 *      对它抽提成等于雇主占有小费 —— 和 tip.ts 里 house_cut 恒为 0 是同一条红线。
 *   2. **提成基数是净额**（扣掉折扣）还是原价，由店规决定，但必须显式选。
 *      折扣是老板给的还是技师给的，这在真店里是头号争议 —— 不给默认值糊弄过去。
 *   3. **多技师共做一个 item 时，营业额按「分钟 × 角色权重」分摊**，
 *      而不是每人都算一遍全额。后者会让一单产生 1.3 倍的提成支出，
 *      老板要到发工资那天才发现。
 *
 * 纯函数，无 IO。金额一律整数分，百分比一律 basis point。
 */

import { largestRemainderSplit } from './split';

export const BP_ONE = 10_000;

export type PlanKind =
  /** 纯提成：按服务净额抽成 */
  | 'commission'
  /** 纯时薪：不看营业额（前台、洗头工常见） */
  | 'hourly'
  /** 保底 + 提成：两者取大。美国按摩/美甲店最常见的 W-2 结构 */
  | 'commission_vs_hourly'
  /** 租椅 1099：门店不发钱，只收租金。引擎返回 0 提成（决策 2，Phase 2 才上 UI） */
  | 'booth_rent';

export interface CompensationPlan {
  kind: PlanKind;
  /** 服务提成率，bp。4500 = 45% */
  rateBp: number;
  /** 按服务分类覆盖：{ [categoryId]: bp }。没配的分类走 rateBp */
  categoryRateBp: Record<string, number>;
  /** 零售提成率，bp。零售和服务的提成率在真店里从来不一样 */
  retailRateBp: number;
  /** 时薪，分/小时。kind 含 hourly 时必填 */
  hourlyRateCents: number;
  /**
   * 提成基数。
   * 'net'   = 扣折扣后（店里给的折扣技师一起承担）—— 默认，因为折扣多半是技师为留客给的
   * 'gross' = 原价（折扣全由老板承担）
   */
  base: 'net' | 'gross';
  /** 双技师项目里营业额怎么分。默认与小费策略同口径 */
  roleWeightBp: { primary: number; assistant: number };
}

export const DEFAULT_PLAN: CompensationPlan = {
  kind: 'commission',
  rateBp: 4_000,
  categoryRateBp: {},
  retailRateBp: 1_000,
  hourlyRateCents: 0,
  base: 'net',
  roleWeightBp: { primary: BP_ONE, assistant: 3_000 },
};

export class CompensationPlanError extends Error {
  constructor(readonly code: 'INVALID_PLAN', message: string) {
    super(message);
    this.name = 'CompensationPlanError';
  }
}

export function assertValidPlan(p: CompensationPlan): void {
  const pct = (v: number, what: string) => {
    if (!Number.isInteger(v) || v < 0 || v > BP_ONE) {
      throw new CompensationPlanError('INVALID_PLAN', `${what} 必须是 0–10000 之间的整数 bp，收到 ${v}`);
    }
  };
  pct(p.rateBp, '提成率');
  pct(p.retailRateBp, '零售提成率');
  for (const [k, v] of Object.entries(p.categoryRateBp)) pct(v, `分类 ${k} 的提成率`);
  if (!Number.isInteger(p.hourlyRateCents) || p.hourlyRateCents < 0) {
    throw new CompensationPlanError('INVALID_PLAN', '时薪必须是非负整数分');
  }
  if ((p.kind === 'hourly' || p.kind === 'commission_vs_hourly') && p.hourlyRateCents === 0) {
    throw new CompensationPlanError('INVALID_PLAN', `${p.kind} 必须设置时薪`);
  }
}

// ─────────────────────────────────────────────────────────────────── 输入

export interface RevenueItem {
  ticketItemId: string;
  kind: 'service' | 'addon' | 'retail' | 'fee';
  /** 服务分类 id，用于分类提成率覆盖 */
  categoryId: string | null;
  /** item 原价小计（qty × 单价），**不含小费** */
  grossCents: number;
  /** item 自身的折扣 */
  itemDiscountCents: number;
  /** Verified prepaid benefits can set their purchased commission basis independently of staff gross/net policy. */
  commissionBaseOverrideCents?:number;
  /** 这个 item 由谁做。接力/双技师会有多条 */
  staff: ReadonlyArray<{
    membershipId: string;
    role: 'primary' | 'assistant';
    minutes: number;
  }>;
}

export interface CommissionLine {
  membershipId: string;
  ticketItemId: string;
  /** 这个人在这个 item 上认到的营业额（已按基数口径与分摊算好） */
  baseCents: number;
  rateBp: number;
  amountCents: number;
  kind: RevenueItem['kind'];
}

export interface CommissionResult {
  lines: CommissionLine[];
  /** 按人汇总 */
  byStaff: Array<{
    membershipId: string;
    /** 认到的营业额（提成基数） */
    baseCents: number;
    commissionCents: number;
    /** 可读依据 —— 技师质疑时直接展示，和小费的 basis 一个道理 */
    basis: {
      rule: PlanKind;
      base: 'net' | 'gross';
      rateBp: number;
      /** 分类/零售用了不同费率时列出来 */
      mixedRates?: Array<{ kind: string; rateBp: number; baseCents: number }>;
      note?: string;
    };
  }>;
}

/**
 * 算一张单的提成。
 *
 * @param ticketDiscountCents 单据级折扣（不属于任何 item 的那种，例如「整单减 10 块」）。
 *        按各 item 的原价占比摊回去 —— 不摊的话，基数选 'net' 就形同虚设。
 */
export function computeCommission(args: {
  items: readonly RevenueItem[];
  ticketDiscountCents?: number;
  /** 每个人各自的方案。查不到的人用 fallback */
  plans: Readonly<Record<string, CompensationPlan>>;
  fallbackPlan?: CompensationPlan;
}): CommissionResult {
  const { items, plans } = args;
  const fallback = args.fallbackPlan ?? DEFAULT_PLAN;
  const ticketDiscount = args.ticketDiscountCents ?? 0;

  for (const p of [...Object.values(plans), fallback]) assertValidPlan(p);
  for(const item of items)if(item.commissionBaseOverrideCents!==undefined&&(!Number.isSafeInteger(item.commissionBaseOverrideCents)||item.commissionBaseOverrideCents<0))throw new Error('Invalid prepaid commission basis');

  // ── 1. 单据级折扣摊到 item ────────────────────────────────────────────────
  const spread = ticketDiscount > 0
    ? largestRemainderSplit(ticketDiscount, items.map((i) => Math.max(0, i.grossCents)))
    : items.map(() => 0);

  const lines: CommissionLine[] = [];

  for (const [idx, item] of items.entries()) {
    if (item.staff.length === 0) continue;   // 无人认领的行（例如纯零售挂在店上）不产生提成

    const discount = item.itemDiscountCents + (spread[idx] ?? 0);

    // ── 2. 该 item 在各人之间怎么分 ────────────────────────────────────────
    // 分钟 × 角色权重。全组分钟都是 0（前台没记时长）时退化成按角色权重分，
    // 再不行就平均分 —— 绝不因为脏数据把提成算成 0。
    const weights = item.staff.map((s) => {
      const roleBp = s.role === 'assistant'
        ? (plans[s.membershipId] ?? fallback).roleWeightBp.assistant
        : (plans[s.membershipId] ?? fallback).roleWeightBp.primary;
      return Math.max(0, s.minutes) * roleBp;
    });
    const useWeights = weights.some((w) => w > 0)
      ? weights
      : item.staff.map((s) => (s.role === 'assistant' ? 3_000 : BP_ONE));

    for (const [si, s] of item.staff.entries()) {
      const plan = plans[s.membershipId] ?? fallback;

      // 基数口径由**这个人的**方案决定：同一单里两个人可以一个吃折扣一个不吃，
      // 听起来奇怪，但「老板自己下场做的那一单不吃折扣」在真店里就是这样
      const itemBaseTotal = item.commissionBaseOverrideCents??(plan.base === 'gross'
        ? item.grossCents
        : Math.max(0, item.grossCents - discount));

      const share = largestRemainderSplit(itemBaseTotal, useWeights)[si] ?? 0;

      const rateBp = rateFor(item, plan);
      const amount = Math.floor((share * rateBp) / BP_ONE);

      lines.push({
        membershipId: s.membershipId,
        ticketItemId: item.ticketItemId,
        baseCents: share,
        rateBp,
        amountCents: plan.kind === 'booth_rent' ? 0 : amount,
        kind: item.kind,
      });
    }
  }

  // ── 3. 按人汇总 ───────────────────────────────────────────────────────────
  const byStaff = new Map<string, CommissionResult['byStaff'][number]>();
  const rateBuckets = new Map<string, Map<string, { rateBp: number; baseCents: number }>>();

  for (const l of lines) {
    const plan = plans[l.membershipId] ?? fallback;
    const cur = byStaff.get(l.membershipId) ?? {
      membershipId: l.membershipId,
      baseCents: 0,
      commissionCents: 0,
      basis: { rule: plan.kind, base: plan.base, rateBp: plan.rateBp },
    };
    cur.baseCents += l.baseCents;
    cur.commissionCents += l.amountCents;
    byStaff.set(l.membershipId, cur);

    const bucket = rateBuckets.get(l.membershipId) ?? new Map();
    const key = `${l.kind}:${l.rateBp}`;
    const b = bucket.get(key) ?? { rateBp: l.rateBp, baseCents: 0 };
    b.baseCents += l.baseCents;
    bucket.set(key, b);
    rateBuckets.set(l.membershipId, bucket);
  }

  for (const [mid, entry] of byStaff) {
    const bucket = rateBuckets.get(mid)!;
    // 只有一种费率时不啰嗦；混了零售/分类费率才列明细，否则技师看不懂总额怎么来的
    if (bucket.size > 1) {
      entry.basis.mixedRates = [...bucket.entries()].map(([k, v]) => ({
        kind: k.split(':')[0]!, rateBp: v.rateBp, baseCents: v.baseCents,
      }));
    }
    const plan = plans[mid] ?? fallback;
    if (plan.kind === 'booth_rent') entry.basis.note = '租椅：门店不发提成';
  }

  return { lines, byStaff: [...byStaff.values()] };
}

function rateFor(item: RevenueItem, plan: CompensationPlan): number {
  if (item.kind === 'retail') return plan.retailRateBp;
  if (item.categoryId && plan.categoryRateBp[item.categoryId] !== undefined) {
    return plan.categoryRateBp[item.categoryId]!;
  }
  return plan.rateBp;
}

// ─────────────────────────────────────────────────────────── 保底与时薪

export interface DayPay {
  commissionCents: number;
  hourlyCents: number;
  /** 实际发的那一份 */
  payCents: number;
  /** 'commission' | 'hourly' —— 保底方案里到底哪边赢了，工资单上要写清楚 */
  paidBy: 'commission' | 'hourly' | 'none';
  note: string;
}

/**
 * 把当日提成和工时合成实发工资。
 *
 * 保底（commission_vs_hourly）取两者较大值，**不是相加** —— 相加是租椅或
 * 「时薪 + 小提成」结构，那是 Phase 2 的事，v1 不提供，免得老板选错了发多钱。
 *
 * @param minutesWorked 当日在岗分钟数。Phase 1b 用排班时长，
 *        Phase 1c 打卡上线后换成实际打卡时长 —— 两者都只是这个参数的来源。
 */
export function settleDayPay(
  commissionCents: number,
  minutesWorked: number,
  plan: CompensationPlan,
): DayPay {
  assertValidPlan(plan);
  const hourly = Math.round((plan.hourlyRateCents * Math.max(0, minutesWorked)) / 60);

  switch (plan.kind) {
    case 'hourly':
      return { commissionCents: 0, hourlyCents: hourly, payCents: hourly,
               paidBy: 'hourly', note: `时薪 ${(plan.hourlyRateCents / 100).toFixed(2)}/小时 × ${(minutesWorked / 60).toFixed(2)} 小时` };
    case 'booth_rent':
      return { commissionCents: 0, hourlyCents: 0, payCents: 0,
               paidBy: 'none', note: '租椅：营业额归技师，门店只收租金' };
    case 'commission':
      return { commissionCents, hourlyCents: 0, payCents: commissionCents,
               paidBy: 'commission', note: '纯提成' };
    case 'commission_vs_hourly': {
      const useHourly = hourly > commissionCents;
      return {
        commissionCents, hourlyCents: hourly,
        payCents: useHourly ? hourly : commissionCents,
        paidBy: useHourly ? 'hourly' : 'commission',
        note: useHourly
          ? `提成 ${(commissionCents / 100).toFixed(2)} 未达保底，按时薪发`
          : `提成 ${(commissionCents / 100).toFixed(2)} 高于保底 ${(hourly / 100).toFixed(2)}`,
      };
    }
  }
}

/** 把 basis 翻译成技师看得懂的一句话 */
export function explainCommission(e: CommissionResult['byStaff'][number]): string {
  const b = e.basis;
  if (b.note) return b.note;
  const baseLabel = b.base === 'net' ? '折后' : '原价';
  if (b.mixedRates && b.mixedRates.length > 1) {
    const parts = b.mixedRates.map((m) =>
      `${m.kind === 'retail' ? '零售' : '服务'} $${(m.baseCents / 100).toFixed(2)} × ${(m.rateBp / 100).toFixed(0)}%`);
    return `${baseLabel}营业额 ${parts.join(' + ')}`;
  }
  return `${baseLabel}营业额 $${(e.baseCents / 100).toFixed(2)} × ${(b.rateBp / 100).toFixed(0)}%`;
}
