/**
 * 小费分配引擎（01-ARCHITECTURE §9，宪法第 2/4 条）
 *
 * 这是整个产品里最容易引发人事摩擦的一块。三条硬要求：
 *
 *   1. **分毫不差** —— 各人所得之和必须等于小费总额。差一分钱技师就会发现，
 *      而且会认为是被克扣了。用最大余额法，余数按店规给人，不四舍五入了事。
 *   2. **可解释** —— 每一笔都带 basis，技师下班能看懂自己为什么分这么多。
 *   3. **合法** —— 联邦 FLSA 禁止雇主/经理占有任何小费。house_cut 恒为 0，
 *      这不是配置项，是硬锁（`00` §3.2）。
 *
 * 纯函数，无 IO。金额一律整数分，百分比一律 basis point。
 */

export const BP = 10_000;

export class TipPolicyError extends Error {
  constructor(readonly code: 'HOUSE_CUT_FORBIDDEN' | 'INVALID_POLICY', message: string) {
    super(message);
    this.name = 'TipPolicyError';
  }
}

export type TipBasis = 'active_minutes' | 'price_share' | 'equal' | 'level_weighted';

export interface TipPolicy {
  basis: TipBasis;
  /** 技师等级加权，10000 = 1.0x。Master 常见 15000 */
  levelWeightsBp: Record<string, number>;
  /** 双技师项目里的角色权重 */
  roleWeightsBp: { primary: number; assistant: number };
  /** 技师分给助理/洗头工的比例 */
  tipOut: Array<{ fromRole: 'primary'; toRole: 'assistant'; bp: number }>;
  /** 余数给谁 */
  remainderTo: 'longest_service' | 'highest_level' | 'pool_next_day';
  /**
   * ⚠️ 必须恒为 0。字段存在只为向后兼容，UI 不提供入口，API 拒绝非 0。
   * 联邦 FLSA（2018 修正）禁止雇主、经理、主管占有任何小费，
   * 即使不使用 tip credit 也一样。
   */
  houseCutBp: 0;
}

export const DEFAULT_TIP_POLICY: TipPolicy = {
  basis: 'active_minutes',
  levelWeightsBp: {},
  roleWeightsBp: { primary: BP, assistant: 3_000 },
  tipOut: [],
  remainderTo: 'longest_service',
  houseCutBp: 0,
};

export interface ServiceLine {
  ticketItemId: string;
  membershipId: string;
  name: string;
  role: 'primary' | 'assistant';
  /** 实际服务分钟数。接力/双技师时各记各的 */
  minutes: number;
  /** 该 item 的服务金额（分） */
  amountCents: number;
  levelKey: string | null;
}

export interface TipAllocation {
  membershipId: string;
  name: string;
  amountCents: number;
  /** 可读的计算依据 —— 技师质疑时直接展示（01 §9） */
  basis: {
    rule: TipBasis;
    myWeight: number;
    totalWeight: number;
    sharePct: string;
    minutes?: number;
    levelWeightBp?: number;
    roleWeightBp?: number;
    tipOutCents?: number;
    remainderCents?: number;
    note?: string;
  };
}

export interface TipResult {
  allocations: TipAllocation[];
  /** 无人可分时留到下一天的池子 */
  pooledCents: number;
}

export function assertLegalTipPolicy(p: TipPolicy): void {
  if (p.houseCutBp !== 0) {
    throw new TipPolicyError(
      'HOUSE_CUT_FORBIDDEN',
      '联邦 FLSA 禁止雇主/经理占有小费，house_cut 必须为 0',
    );
  }
  for (const [k, v] of Object.entries(p.levelWeightsBp)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new TipPolicyError('INVALID_POLICY', `等级权重 ${k} 必须是非负整数 bp`);
    }
  }
  for (const t of p.tipOut) {
    if (t.bp < 0 || t.bp > BP) {
      throw new TipPolicyError('INVALID_POLICY', 'tip_out 比例必须在 0–10000 bp 之间');
    }
  }
}

function rawWeight(l: ServiceLine, p: TipPolicy): number {
  const level = (l.levelKey && p.levelWeightsBp[l.levelKey]) || BP;
  const role = l.role === 'assistant' ? p.roleWeightsBp.assistant : p.roleWeightsBp.primary;
  const base =
    p.basis === 'active_minutes' ? l.minutes
    : p.basis === 'price_share' ? l.amountCents
    : 1;                                   // equal / level_weighted 按人头，再乘权重
  // 等级与角色权重永远参与：这是「等级三维差异化」的第三维（00 §3.0）
  return base * (level / BP) * (role / BP);
}

/**
 * 分配小费。
 *
 * 余数处理用最大余额法：先按权重取整数分，剩下的几分按小数部分大小依次多给一分。
 * 直接 Math.round 会导致总额对不上 —— 一单差一两分，一天下来技师就会来问。
 */
export function allocateTip(
  tipCents: number,
  lines: readonly ServiceLine[],
  policy: TipPolicy = DEFAULT_TIP_POLICY,
): TipResult {
  assertLegalTipPolicy(policy);

  if (tipCents <= 0 || lines.length === 0) {
    return { allocations: [], pooledCents: tipCents > 0 ? tipCents : 0 };
  }

  // 同一个人在一单里可能有多条 line（接力、多项目）—— 先按人合并
  const byStaff = new Map<string, {
    membershipId: string; name: string; minutes: number; amountCents: number;
    weight: number; levelWeightBp: number; roleWeightBp: number; hasAssistant: boolean;
  }>();

  for (const l of lines) {
    const w = rawWeight(l, policy);
    const cur = byStaff.get(l.membershipId);
    const levelBp = (l.levelKey && policy.levelWeightsBp[l.levelKey]) || BP;
    const roleBp = l.role === 'assistant' ? policy.roleWeightsBp.assistant : policy.roleWeightsBp.primary;
    if (cur) {
      cur.minutes += l.minutes; cur.amountCents += l.amountCents; cur.weight += w;
      cur.hasAssistant ||= l.role === 'assistant';
    } else {
      byStaff.set(l.membershipId, {
        membershipId: l.membershipId, name: l.name,
        minutes: l.minutes, amountCents: l.amountCents, weight: w,
        levelWeightBp: levelBp, roleWeightBp: roleBp,
        hasAssistant: l.role === 'assistant',
      });
    }
  }

  const staff = [...byStaff.values()];
  const totalWeight = staff.reduce((s, x) => s + x.weight, 0);
  if (totalWeight <= 0) return { allocations: [], pooledCents: tipCents };

  // 最大余额法
  const exact = staff.map((s) => (tipCents * s.weight) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let left = tipCents - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);

  const cents = [...floors];
  const gotRemainder = new Set<number>();
  let pooledCents = 0;
  if (policy.remainderTo === 'pool_next_day') {
    pooledCents = left;
  } else {
    for (const { i } of order) {
      if (left <= 0) break;
      cents[i] = cents[i]! + 1; left -= 1; gotRemainder.add(i);
    }
  }

  // 余数归属：店规说了算（remainder_to）。上面按小数排序只是保证总额对得上，
  // 真正的"谁多拿那一分"由这里决定。
  if (policy.remainderTo === 'longest_service' || policy.remainderTo === 'highest_level') {
    const pick = policy.remainderTo === 'longest_service'
      ? staff.reduce((a, b) => (b.minutes > a.minutes ? b : a))
      : staff.reduce((a, b) => (b.levelWeightBp > a.levelWeightBp ? b : a));
    const pickIdx = staff.indexOf(pick);
    // 把已经发出去的余数收回来重新给指定的人
    const extra = gotRemainder.size;
    if (extra > 0 && pickIdx >= 0) {
      for (const i of gotRemainder) cents[i] = cents[i]! - 1;
      cents[pickIdx] = cents[pickIdx]! + extra;
      gotRemainder.clear(); gotRemainder.add(pickIdx);
    }
  }

  // tip-out：主技师按比例分给助理
  const tipOutCents = new Map<string, number>();
  for (const rule of policy.tipOut) {
    const assistants = staff.filter((s) => s.hasAssistant);
    if (assistants.length === 0) continue;
    for (let i = 0; i < staff.length; i++) {
      const s = staff[i]!;
      if (s.hasAssistant) continue;              // 只有主技师往外分
      const give = Math.floor((cents[i]! * rule.bp) / BP);
      if (give <= 0) continue;
      cents[i] = cents[i]! - give;
      tipOutCents.set(s.membershipId, -(give));
      // 平均分给助理；除不尽的余数给第一个
      const each = Math.floor(give / assistants.length);
      let rest = give - each * assistants.length;
      for (const a of assistants) {
        const ai = staff.indexOf(a);
        const add = each + (rest > 0 ? 1 : 0);
        if (rest > 0) rest -= 1;
        cents[ai] = cents[ai]! + add;
        tipOutCents.set(a.membershipId, (tipOutCents.get(a.membershipId) ?? 0) + add);
      }
    }
  }

  const allocations: TipAllocation[] = staff.map((s, i) => ({
    membershipId: s.membershipId,
    name: s.name,
    amountCents: cents[i]!,
    basis: {
      rule: policy.basis,
      myWeight: Math.round(s.weight * 100) / 100,
      totalWeight: Math.round(totalWeight * 100) / 100,
      sharePct: `${((s.weight / totalWeight) * 100).toFixed(1)}%`,
      ...(policy.basis === 'active_minutes' ? { minutes: s.minutes } : {}),
      ...(s.levelWeightBp !== BP ? { levelWeightBp: s.levelWeightBp } : {}),
      ...(s.roleWeightBp !== BP ? { roleWeightBp: s.roleWeightBp } : {}),
      ...(tipOutCents.has(s.membershipId) ? { tipOutCents: tipOutCents.get(s.membershipId)! } : {}),
      ...(gotRemainder.has(i) ? { remainderCents: 1 } : {}),
    },
  }));

  return { allocations, pooledCents };
}

/** 把 basis 翻译成技师看得懂的一句话 */
export function explainAllocation(a: TipAllocation): string {
  const b = a.basis;
  const parts: string[] = [];
  if (b.rule === 'active_minutes' && b.minutes !== undefined) {
    parts.push(`做了 ${b.minutes} 分钟`);
  } else if (b.rule === 'price_share') {
    parts.push('按服务金额占比');
  } else if (b.rule === 'equal') {
    parts.push('平均分');
  }
  if (b.levelWeightBp !== undefined) parts.push(`等级系数 ${(b.levelWeightBp / BP).toFixed(1)}x`);
  if (b.roleWeightBp !== undefined) parts.push(`助理系数 ${(b.roleWeightBp / BP).toFixed(1)}x`);
  parts.push(`占 ${b.sharePct}`);
  if (b.tipOutCents !== undefined) {
    parts.push(b.tipOutCents < 0
      ? `分给助理 $${(-b.tipOutCents / 100).toFixed(2)}`
      : `从主技师分得 $${(b.tipOutCents / 100).toFixed(2)}`);
  }
  return parts.join(' · ');
}
