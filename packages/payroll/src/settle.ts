/**
 * 打烊日结：点钞、现金进出、刷卡机物理对账、现金小费发放（03 §B Phase 1b）
 *
 * 这一块的设计原则和别处不同 —— **它服务的是老板的疑心**。
 * 前台每天摸几千块现金，账实差几十块是常态；系统的价值不是「不许差」，
 * 而是**让差额有出处**：差在哪一步、谁经手、当时写了什么原因。
 *
 * 决策 19 说「不记录店内琐碎零钱/备用金流水」—— 那说的是不逼老板记流水账。
 * 所以这里的现金进出条目**全部可选**，一条不填也能完成日结；
 * 但只要填了，就必须进期望现金的计算，否则填了反而更对不上。
 *
 * 纯函数，无 IO。金额一律整数分。
 */

/**
 * 美国门店实际会数的面额（分）。
 * 没有 $2 —— 那是收藏品不是流通钞，列进点钞表只会让前台每天多看一行空格。
 */
export const DENOMINATIONS = [10_000, 5_000, 2_000, 1_000, 500, 100, 25, 10, 5, 1] as const;
export type Denomination = (typeof DENOMINATIONS)[number];

/** 点钞结果：面额 → 张/枚数 */
export type CashCount = Partial<Record<Denomination, number>>;

/**
 * 点钞合计。
 *
 * 故意不接受「直接输入一个总额」以外的捷径 —— 前台可以只填总额（传 {} 加 totalOverride），
 * 但一旦开始按面额点，就要求把面额点完，因为半途而废的面额表
 * 会让第二天查账的人以为那是完整的。
 */
export function countCash(count: CashCount): number {
  let total = 0;
  for (const d of DENOMINATIONS) {
    const n = count[d] ?? 0;
    if (!Number.isInteger(n) || n < 0) throw new Error(`面额 ${d} 的数量必须是非负整数，收到 ${n}`);
    total += d * n;
  }
  return total;
}

/** 现金进出。正数 = 进抽屉，负数 = 出抽屉 */
export type CashMovementKind =
  | 'opening_float'   // 早上放备用金
  | 'cash_drop'       // 中途取走存银行/进保险柜
  | 'supply_purchase' // 拿现金去买东西
  | 'tip_payout'      // 发现金小费（由发放流程自动产生，不用手填）
  | 'payout_owner'    // 老板拿走
  | 'other';

export interface CashMovement {
  kind: CashMovementKind;
  /** 正 = 进，负 = 出。tip_payout / cash_drop 一律是负 */
  amountCents: number;
  note?: string;
}

export interface CashReconcileInput {
  /** 昨天留在抽屉里的备用金（今天的起始额） */
  openingFloatCents: number;
  /** 今日现金收款合计，**含现金小费**（收进抽屉的就是这个数） */
  cashTakeCents: number;
  /** 今日现金进出条目 */
  movements: readonly CashMovement[];
  /** 实际点出来多少 */
  countedCents: number;
  /** 打烊后要留多少备用金给明天（从 counted 里扣，不算差异） */
  closingFloatCents: number;
}

export interface CashReconcileResult {
  /** 抽屉里理论上应该有多少 */
  expectedCents: number;
  /** 实点 − 应有。正 = 多了，负 = 少了 */
  varianceCents: number;
  /** 除去留存备用金后，今天实际该交出来多少现金 */
  depositCents: number;
  movementsTotalCents: number;
  /** 差异是否需要必填原因 */
  needsReason: boolean;
}

/**
 * 差异多大才要求写原因。
 * 定成 $2：再小就是硬币找零的正常磨损，天天弹框前台会开始乱填；
 * 再大就漏掉了真正该解释的那一档。
 */
export const VARIANCE_REASON_THRESHOLD_CENTS = 200;

export function reconcileCash(input: CashReconcileInput): CashReconcileResult {
  const movementsTotal = input.movements.reduce((s, m) => s + m.amountCents, 0);
  const expected = input.openingFloatCents + input.cashTakeCents + movementsTotal;
  const variance = input.countedCents - expected;
  return {
    expectedCents: expected,
    varianceCents: variance,
    depositCents: Math.max(0, input.countedCents - input.closingFloatCents),
    movementsTotalCents: movementsTotal,
    needsReason: Math.abs(variance) >= VARIANCE_REASON_THRESHOLD_CENTS,
  };
}

// ────────────────────────────────────────────────────── 刷卡机物理对账

export interface CardReconcileResult {
  expectedCents: number;
  terminalCents: number;
  varianceCents: number;
  needsReason: boolean;
}

/**
 * 刷卡机日结比对。
 *
 * 前台把刷卡机打出的 batch total 敲进来，和系统里的刷卡收款（**含小费**）比。
 * 含小费这点很容易搞错：终端小票上的 total 是含小费的，
 * 拿系统的服务金额去比，每天都会差出一整天的小费额，然后没人再看这个数。
 *
 * 差异阈值比现金严：刷卡不该有磨损，差一分就是漏单或重复刷。
 */
export function reconcileCard(expectedCents: number, terminalCents: number): CardReconcileResult {
  const variance = terminalCents - expectedCents;
  return {
    expectedCents, terminalCents, varianceCents: variance,
    needsReason: variance !== 0,
  };
}

// ────────────────────────────────────────────────── 现金小费发放

export interface TipOwed {
  membershipId: string;
  name: string;
  /** 今日现金小费分配额 */
  todayCents: number;
  /** 昨天没发净的结转 */
  carryInCents: number;
}

export interface TipPayoutPlan {
  membershipId: string;
  name: string;
  owedCents: number;
  /** 按面额取整后实际给的现金 */
  payCents: number;
  /** 发不出的零头，结转到明天 */
  carryOutCents: number;
  /** 给这个人时要数哪些钞票 —— 老板照着数就行 */
  bills: CashCount;
}

/**
 * 排出「今晚每个人拿多少现金」。
 *
 * 为什么要有零头结转：老板手里不会有一堆硬币。欠 $37.60 时，
 * 现实里就是给 $37，剩下六毛记着明天一起给。
 * 以前门店靠前台在本子上记「阿美还差 6 毛」—— 这个函数就是把那本子产品化。
 *
 * @param roundToCents 发放粒度。默认 100（发到整元）；老板有硬币就传 1。
 */
export function planTipPayouts(
  owed: readonly TipOwed[],
  roundToCents = 100,
): TipPayoutPlan[] {
  if (!Number.isInteger(roundToCents) || roundToCents < 1) {
    throw new Error('发放粒度必须是正整数分');
  }
  return owed.map((o) => {
    const total = o.todayCents + o.carryInCents;
    // 负数（上一天多发了）不发钱，整额继续结转 —— 绝不从技师身上"扣回来"，
    // 那会变成当面要钱，没有哪个老板会这么用
    const pay = total <= 0 ? 0 : Math.floor(total / roundToCents) * roundToCents;
    return {
      membershipId: o.membershipId,
      name: o.name,
      owedCents: total,
      payCents: pay,
      carryOutCents: total - pay,
      bills: breakIntoBills(pay),
    };
  });
}

/**
 * 把金额拆成面额张数，供老板照着数钞票。
 * 贪心即最优 —— 美元面额是完全可分的（1,5,10,20,50,100 与硬币同理）。
 */
export function breakIntoBills(amountCents: number): CashCount {
  const out: CashCount = {};
  let left = Math.max(0, amountCents);
  for (const d of DENOMINATIONS) {
    const n = Math.floor(left / d);
    if (n > 0) { out[d] = n; left -= n * d; }
  }
  return out;
}

/** 面额 → 人看的标签 */
export function denominationLabel(d: Denomination): string {
  return d >= 100 ? `$${d / 100}` : `${d}¢`;
}
