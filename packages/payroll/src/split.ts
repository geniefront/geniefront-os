/**
 * 整数分的按权重拆分 —— 唯一实现（宪法第 2/4 条）。
 *
 * 这个函数在 Phase 1b 被三处用到，而它们全都是「差一分就要吵架」的地方：
 *   1. 组单一人付全部时，把一笔钱摊回各人各自的单
 *   2. 单据级折扣摊到各个 item，用来算提成基数
 *   3. 多技师共做一个 item 时，把这个 item 的营业额分给各人
 *
 * 曾经打算让各处自己 Math.round 一下 —— 那样三处会得出三个总额，
 * 而且只在特定金额上差一分，测不出来、查不到，最后是技师发现的。
 *
 * 最大余额法：先按权重取整数分（向下取整），剩下的几分按小数部分从大到小
 * 依次多给一分。**返回值之和恒等于 total**，这是这个模块存在的全部理由。
 */

export interface SplitOptions {
  /**
   * 权重全为 0 时怎么办。
   * 'equal' = 平均分（默认，多用于「三个人都没记分钟数」这种脏数据）
   * 'first' = 全给第一个
   * 'throw' = 抛错（调用方确信不可能发生时用）
   */
  zeroWeights?: 'equal' | 'first' | 'throw';
}

/**
 * 把 total 分成 weights.length 份。
 *
 * @param total   整数分。允许为负（退款/冲账场景），符号会被正确保留。
 * @param weights 非负权重。可以是分钟数、金额、也可以全是 1。
 */
export function largestRemainderSplit(
  total: number,
  weights: readonly number[],
  opts: SplitOptions = {},
): number[] {
  if (!Number.isInteger(total)) throw new Error(`拆分金额必须是整数分：${total}`);
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new Error('权重必须是非负有限数');
  }

  let ws = [...weights];
  const sum = ws.reduce((a, b) => a + b, 0);

  if (sum <= 0) {
    const mode = opts.zeroWeights ?? 'equal';
    if (mode === 'throw') throw new Error('权重之和为 0，无法拆分');
    ws = mode === 'first'
      ? ws.map((_, i) => (i === 0 ? 1 : 0))
      : ws.map(() => 1);
  }

  // 负数单独处理：对绝对值拆分再取反。
  // 直接对负数取 floor 会让余数分配的方向反过来 —— 那会导致
  // 冲账金额和原单金额不是精确相反数，对账时永远差一分。
  const neg = total < 0;
  const abs = Math.abs(total);
  const totalW = ws.reduce((a, b) => a + b, 0);

  const exact = ws.map((w) => (abs * w) / totalW);
  const out = exact.map((x) => Math.floor(x));
  let left = abs - out.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), w: ws[i]! }))
    // 小数部分相同时按权重大的优先，再按下标 —— 保证结果确定，
    // 否则同一批数据两次调用可能给出不同答案，对账时无从解释
    .sort((a, b) => (b.frac - a.frac) || (b.w - a.w) || (a.i - b.i));

  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = out[i]! + 1;
    left -= 1;
  }

  return neg ? out.map((x) => -x) : out;
}

/**
 * 把几个"桶"里的钱按顺序填进几个"需求"里。
 *
 * 组单合并结账要同时满足两个精确性，而它们会互相打架：
 *   · **每张单**收到的钱必须正好等于它自己的金额（否则某人的营业额被静默改了）
 *   · **每种支付方式**的合计必须正好等于实际收了多少现金/刷了多少卡
 *     （否则打烊点钞对不上，而那正是这一期要解决的问题）
 *
 * 按比例摊 + 四舍五入会在其中一边差出一分。所以不摊，**填**：
 * 现金先冲抵前几张单，用完了再用刷卡的顶上。纯整数搬运，两边都不会差。
 * 前台也解释得清：「这一百块现金冲了张三和李四的单，剩下的刷卡」。
 *
 * @returns matrix[needIndex][bucketIndex]
 */
export function distributeBuckets(
  needs: readonly number[], buckets: readonly number[],
): number[][] {
  const needSum = needs.reduce((a, b) => a + b, 0);
  const bucketSum = buckets.reduce((a, b) => a + b, 0);
  if (needSum !== bucketSum) {
    throw new Error(`需求合计 ${needSum} 与来源合计 ${bucketSum} 不等，无法填充`);
  }
  if (needs.some((n) => n < 0) || buckets.some((b) => b < 0)) {
    throw new Error('填充不接受负数');
  }

  const left = [...buckets];
  return needs.map((need) => {
    const row = buckets.map(() => 0);
    let want = need;
    for (let j = 0; j < left.length && want > 0; j++) {
      const take = Math.min(left[j]!, want);
      row[j] = take;
      left[j] = left[j]! - take;
      want -= take;
    }
    return row;
  });
}
