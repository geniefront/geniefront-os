/**
 * 轮牌引擎（01-ARCHITECTURE §8，宪法第 2 条）
 *
 * 核心是**事件溯源**：当前顺序不是存出来的，是由事件重放算出来的。
 * 这一条决定了产品成不成立 —— 技师质疑"为什么跳过我"时，
 * 前台能一条条给他看，而不是干瞪着一个说不清来历的排序（决策 12）。
 *
 * 纯函数，无 IO。同一份代码被 API、前端预览、测试复用。
 */

/** 轮次一律 basis point：10000 = 一整轮，5000 = 半轮。不用浮点（宪法第 4 条） */
export const FULL_TURN = 10_000;
export const HALF_TURN = 5_000;

export type RotationReason =
  | 'served'                // 接了一单，按项目折算消耗轮次
  | 'request_not_counted'   // 点钟单，多数店不消耗轮次
  | 'skipped_no_skill'      // 不会做这个项目
  | 'skipped_off'           // 请假/下班
  | 'break'                 // 吃饭/上厕所，临时离场
  | 'back'                  // 休息结束回来
  | 'manual_override'       // 前台手动调序 —— 必须带原因
  | 'offline_service'       // 店外/线下单
  | 'reset_daily';          // 每日重置

export interface RotationEvent {
  id: string;
  membershipId: string;
  /** 消耗的轮次（bp）。跳过类通常是 0 */
  deltaBp: number;
  reason: RotationReason;
  at: string;
  actorId: string | null;
  note: string | null;
  /** 仅 manual_override：前台把他放到第几位（0 起） */
  manualRank?: number | null;
}

export interface Participant {
  membershipId: string;
  name: string;
  /** 是否参与今天的 walk-in 轮牌（店长可接客但不吃轮，决策 20） */
  inRotation: boolean;
  /** 稳定的初始顺序 —— 通常是打卡先后 */
  seedOrder: number;
}

export interface RotationPolicy {
  /** 点钟单是否消耗轮次。多数店：不消耗 */
  requestCountsAsTurn: boolean;
  /** 因不会做而被跳过，算不算他一轮 */
  skipNoSkill: 'no_penalty' | 'counts_as_turn';
  /** 被跳过的人下次是否优先 */
  owedTurnPriority: boolean;
  /** 休息中的人：离开队列，还是留在原位 */
  onBreak: 'off_rotation' | 'stay_in_place';
}

export const DEFAULT_POLICY: RotationPolicy = {
  requestCountsAsTurn: false,
  skipNoSkill: 'no_penalty',
  owedTurnPriority: true,
  onBreak: 'off_rotation',
};

export type StaffState = 'available' | 'on_break' | 'off';

export interface StandingEntry {
  membershipId: string;
  name: string;
  /** 今天累计消耗的轮次（bp） */
  turnsBp: number;
  /** 被跳过还没补回来的次数 */
  owed: number;
  state: StaffState;
  /** 前台手动指定的位次；被服务后自动失效 */
  manualRank: number | null;
  /** 队列里的位置（0 起）。休息/离场的人不参与排位，为 null */
  position: number | null;
  /** 可解释性：把他排到这个位置的依据，按时间倒序 */
  trail: Array<{ at: string; reason: RotationReason; deltaBp: number; note: string | null }>;
}

export interface Standing {
  entries: StandingEntry[];
  /** 下一个该接 walk-in 的人。全都在休息时为 null */
  nextUp: StandingEntry | null;
}

/**
 * 按金额折算轮次。
 *
 * 美甲店的现实：$25 的修甲和 $80 的套餐不该算同样一轮，
 * 否则做小单的人会一直吃亏。阶梯由店主配（`00` §1.2）。
 */
export function turnValueByAmount(
  amountCents: number,
  tiers: Array<{ maxCents: number | null; turnBp: number }>,
): number {
  for (const t of tiers) {
    if (t.maxCents === null || amountCents <= t.maxCents) return t.turnBp;
  }
  return FULL_TURN;
}

/**
 * 重放事件得到当前站位。
 *
 * 排序规则（依次比较）：
 *   1. 前台手动指定的位次 —— 人的判断永远优先于算法（决策 12）
 *   2. 累计轮次少的先来 —— 这是轮牌的本义
 *   3. 欠轮多的先来 —— 被跳过的人下次优先（可配）
 *   4. 初始顺序 —— 打卡早的先来，保证结果稳定不跳动
 */
export function computeStanding(
  participants: readonly Participant[],
  events: readonly RotationEvent[],
  policy: RotationPolicy = DEFAULT_POLICY,
): Standing {
  const byId = new Map<string, StandingEntry>();
  for (const p of participants) {
    byId.set(p.membershipId, {
      membershipId: p.membershipId,
      name: p.name,
      turnsBp: 0,
      owed: 0,
      state: p.inRotation ? 'available' : 'off',
      manualRank: null,
      position: null,
      trail: [],
    });
  }

  const ordered = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  for (const ev of ordered) {
    const e = byId.get(ev.membershipId);
    if (!e) continue;   // 已离场的人的历史事件，忽略

    switch (ev.reason) {
      case 'reset_daily':
        e.turnsBp = 0; e.owed = 0; e.manualRank = null; e.trail = [];
        break;

      case 'served':
      case 'offline_service':
        e.turnsBp += ev.deltaBp;
        // 接到单了，手动指定就用掉了 —— 否则他会一直霸占第一位
        e.manualRank = null;
        if (e.owed > 0) e.owed -= 1;
        break;

      case 'request_not_counted':
        // 点钟单：默认不消耗轮次，但店主可以配成消耗
        if (policy.requestCountsAsTurn) e.turnsBp += ev.deltaBp;
        e.manualRank = null;
        break;

      case 'skipped_no_skill':
        if (policy.skipNoSkill === 'counts_as_turn') e.turnsBp += ev.deltaBp;
        else if (policy.owedTurnPriority) e.owed += 1;
        break;

      case 'skipped_off':
        // 请假/下班被跳过：不该记他欠轮，人不在场不算被亏待
        break;

      case 'break':
        e.state = 'on_break';
        break;

      case 'back':
        e.state = 'available';
        break;

      case 'manual_override':
        e.manualRank = ev.manualRank ?? null;
        break;
    }

    e.trail.unshift({
      at: ev.at, reason: ev.reason, deltaBp: ev.deltaBp, note: ev.note,
    });
  }

  const seed = new Map(participants.map((p) => [p.membershipId, p.seedOrder]));
  const entries = [...byId.values()];

  // 休息的人是否退出队列，由策略决定
  const inQueue = entries.filter((e) =>
    e.state === 'available' || (e.state === 'on_break' && policy.onBreak === 'stay_in_place'));

  inQueue.sort((a, b) => {
    if (a.manualRank !== b.manualRank) {
      if (a.manualRank === null) return 1;
      if (b.manualRank === null) return -1;
      return a.manualRank - b.manualRank;
    }
    if (a.turnsBp !== b.turnsBp) return a.turnsBp - b.turnsBp;
    if (policy.owedTurnPriority && a.owed !== b.owed) return b.owed - a.owed;
    return (seed.get(a.membershipId) ?? 0) - (seed.get(b.membershipId) ?? 0);
  });

  inQueue.forEach((e, i) => { e.position = i; });

  // 展示顺序：队列里的按位次，不在队列的排在后面
  const display = [
    ...inQueue,
    ...entries.filter((e) => !inQueue.includes(e))
      .sort((a, b) => (seed.get(a.membershipId) ?? 0) - (seed.get(b.membershipId) ?? 0)),
  ];

  const nextUp = inQueue.find((e) => e.state === 'available') ?? null;
  return { entries: display, nextUp };
}

/**
 * 把站位翻译成人话 —— 技师问"凭什么轮到他不轮到我"时给他看这个。
 *
 * 这个函数比引擎本身更常用：门店里的矛盾大多不是算错了，
 * 是没人能说清算法为什么这么排。
 */
export function explain(entry: StandingEntry, policy: RotationPolicy): string[] {
  const out: string[] = [];
  const turns = (entry.turnsBp / FULL_TURN).toFixed(1).replace(/\.0$/, '');

  if (entry.state === 'off') { out.push('今天不参与轮牌（只接点钟）'); return out; }
  if (entry.state === 'on_break') {
    out.push(policy.onBreak === 'off_rotation' ? '休息中，暂时不排队' : '休息中，位置保留');
  }
  if (entry.manualRank !== null) {
    const why = entry.trail.find((t) => t.reason === 'manual_override');
    out.push(`前台手动排到第 ${entry.manualRank + 1} 位${why?.note ? ` —— ${why.note}` : ''}`);
  }
  out.push(`今天已做 ${turns} 轮`);
  if (entry.owed > 0) out.push(`被跳过 ${entry.owed} 次，下次优先`);
  if (entry.position === 0 && entry.state === 'available') out.push('★ 下一位轮到他');
  return out;
}
