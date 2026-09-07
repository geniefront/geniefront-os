import { describe, expect, it } from 'vitest';
import { rotationRank, rotationRankLabel } from './rotationRank';

describe('rotationRank', () => {
  /*
   * 这一条是本模块存在的理由：引擎用 0 表示「下一位轮到他」，
   * 而前台看到的必须是 #1。入座弹窗曾把它原样印成 #0。
   */
  it('0 基顺位换成 1 基名次', () => {
    expect(rotationRank(0)).toBe(1);
    expect(rotationRank(1)).toBe(2);
    expect(rotationRank(3)).toBe(4);
  });

  it('不在轮牌队列时返回 null，而不是 0 或 1', () => {
    expect(rotationRank(null)).toBeNull();
    expect(rotationRank(undefined)).toBeNull();
  });

  it('给了下标才用下标兜底，且同样是 1 基', () => {
    expect(rotationRank(null, 0)).toBe(1);
    expect(rotationRank(undefined, 2)).toBe(3);
    // 有真实顺位时不看下标 —— 下标是渲染顺序，不是轮牌顺序。
    expect(rotationRank(0, 5)).toBe(1);
  });

  it('徽章文案：缺失给短横线，不给会被误读成名次的数字', () => {
    expect(rotationRankLabel(0)).toBe('#1');
    expect(rotationRankLabel(null)).toBe('—');
    expect(rotationRankLabel(undefined)).toBe('—');
    expect(rotationRankLabel(null, 1)).toBe('#2');
  });

  /*
   * 曾经的两处写法各自的错误结果，固定住以免有人「改回去」。
   * position 为 0 时：`?? index + 1` 会漏出 0；`position ? ... : '—'` 会
   * 把正好轮到的那一位判成没有顺位。
   */
  it('轮到的那一位既不显示 #0，也不显示短横线', () => {
    expect(rotationRankLabel(0, 7)).toBe('#1');
    expect(rotationRankLabel(0)).not.toBe('#0');
    expect(rotationRankLabel(0)).not.toBe('—');
  });
});
