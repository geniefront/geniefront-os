/**
 * 轮牌顺位的显示换算。
 *
 * ⚠️ **引擎里的 `position` 是 0 基的**（`packages/rotation/src/engine.ts`：
 * `naturalQueue.forEach((e, i) => { e.position = i })`），`position === 0`
 * 表示「下一位轮到他」。而前台读到的是名次，第一位必须显示成 `#1`。
 *
 * 这个换算已经在三个地方各写了一遍，其中入座弹窗写错了两处：
 *
 *   · `entry.position ?? index + 1` —— `??` 只在 null/undefined 时回退，
 *     `0` 会原样透出，前台看到一个 `#0`；
 *   · `rotationPosition ? '#' + n : '—'` —— `0` 是 falsy，于是**正好轮到的
 *     那一位**在候选列表里显示成「没有顺位」，与事实完全相反。
 *
 * 轮牌是门店里最容易起争议的一块，同一个人在同一个弹窗里出现两个说法，
 * 前台没有办法判断该信哪一个。因此把规则收敛到这里，只此一份。
 */

/** 不在轮牌队列里（未到店 / 已下班）时 `position` 为 null。 */
export type RotationPosition = number | null | undefined;

/**
 * 顺位 → 人读的名次。不在队列里返回 null，由调用方决定显示成 `—` 还是别的。
 *
 * `fallbackIndex` 是列表里的下标，仅在顺位缺失但仍要给一个稳定序号时使用
 * （例如整条轮牌都还没算出来的瞬间）。不传就返回 null。
 *
 * 重载让类型跟着用法走：传了下标就一定拿得到数字，调用点不必再判空。
 */
export function rotationRank(position: RotationPosition, fallbackIndex: number): number;
export function rotationRank(position: RotationPosition): number | null;
export function rotationRank(position: RotationPosition, fallbackIndex?: number): number | null {
  if (typeof position === 'number' && Number.isFinite(position)) return position + 1;
  return typeof fallbackIndex === 'number' ? fallbackIndex + 1 : null;
}

/** 顺位的徽章文案。缺失时给一个短横线，而不是一个会被误读成名次的数字。 */
export function rotationRankLabel(position: RotationPosition, fallbackIndex?: number): string {
  const rank = fallbackIndex === undefined
    ? rotationRank(position)
    : rotationRank(position, fallbackIndex);
  return rank === null ? '—' : `#${rank}`;
}
