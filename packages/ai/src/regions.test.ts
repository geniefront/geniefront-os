/**
 * 大牌子分块的纯函数（05 §5.2）。
 *
 * 每一条都在问：**这一行检查没有的话，老板的项目库里会少什么？**
 */

import { describe, it, expect } from 'vitest';
import { verifyCoverage, padRegion, shouldChunk, capRegions, type Region } from './regions';

const r = (label: string, y1: number, y2: number): Region =>
  ({ label, bbox: [0, y1, 1000, y2] });

describe('分区覆盖检查', () => {
  it('从头盖到尾就通过', () => {
    const c = verifyCoverage([r('MANICURE', 0, 500), r('PEDICURE', 500, 1000)], 1000);
    expect(c.ok).toBe(true);
    expect(c.gaps).toEqual([]);
    expect(c.covered).toBe(1);
  });

  it('相邻块重叠没有坏处 —— 重复的行后面会被 mergeDrafts 合掉', () => {
    const c = verifyCoverage([r('A', 0, 550), r('B', 450, 1000)], 1000);
    expect(c.ok).toBe(true);
    expect(c.covered).toBe(1);
  });

  it('⭐ 中间漏了一整块要拦下来', () => {
    // 模型把牌子分成 MANICURE / PEDICURE，漏看了中间那块 WAXING。
    // 不拦的话：第二遍只裁两块，WAXING 那七行一个都不会被录，
    // 而整条流程不报任何错 —— 老板拿到一份看起来很完整的项目库，少了七项。
    const c = verifyCoverage([r('MANICURE', 0, 300), r('PEDICURE', 700, 1000)], 1000);
    expect(c.ok).toBe(false);
    expect(c.gaps[0]).toEqual([300, 700]);
  });

  it('⭐ 最下面一块漏掉也要拦 —— 这是最常见的漏法', () => {
    // 牌子最下面常常是「Add-on」「Waxing」这种小字区，最容易被跳过
    const c = verifyCoverage([r('MANICURE', 0, 400), r('PEDICURE', 400, 780)], 1000);
    expect(c.ok).toBe(false);
    expect(c.gaps[0]).toEqual([780, 1000]);
  });

  it('顶上漏一条也算 —— 那里常常是店名下面的第一个分类', () => {
    const c = verifyCoverage([r('PEDICURE', 200, 1000)], 1000);
    expect(c.ok).toBe(false);
    expect(c.gaps[0]).toEqual([0, 200]);
  });

  it('几个像素的缝不算漏 —— 模型给的框本来就不会严丝合缝', () => {
    const c = verifyCoverage([r('A', 0, 498), r('B', 502, 1000)], 1000);
    expect(c.ok).toBe(true);
  });

  it('一块都没报 = 不可用，不是「全覆盖」', () => {
    expect(verifyCoverage([], 1000).ok).toBe(false);
  });

  it('缺口按大小排序 —— 排查时先看最大的那个', () => {
    const c = verifyCoverage([r('A', 50, 200), r('B', 500, 1000)], 1000);
    expect(c.gaps[0]).toEqual([200, 500]);   // 300px，最大的排前面
    expect(c.gaps[1]).toEqual([0, 50]);      // 50px
  });
});

describe('裁切前留余量', () => {
  it('纵向留一圈、横向留满', () => {
    // 贴着字裁会把价格的最后一位切掉，而 `$45` 裁成 `$4` 仍然像个
    // 完整的价格 —— 模型会老老实实录成四块钱
    expect(padRegion(r('A', 500, 600), 1000, 2000, 0.02)).toEqual([0, 460, 1000, 640]);
  });

  it('不会越界', () => {
    expect(padRegion(r('A', 10, 1990), 1000, 2000, 0.02)).toEqual([0, 0, 1000, 2000]);
  });
});

describe('分区数超过上限', () => {
  it('⭐ 合并相邻块，绝不丢掉多出来的那些', () => {
    // 只裁前 6 块的话，后三块一行都不会被录 —— 和漏分区是同一种灾难。
    // 合并只是让某一块大一点，一行都不会少。
    const nine = Array.from({ length: 9 }, (_, i) => r(`R${i}`, i * 100, (i + 1) * 100));
    const out = capRegions(nine, 6);
    expect(out).toHaveLength(6);
    // 覆盖范围必须一点不少
    expect(Math.min(...out.map((g) => g.bbox[1]))).toBe(0);
    expect(Math.max(...out.map((g) => g.bbox[3]))).toBe(900);
    expect(verifyCoverage(out, 900).ok).toBe(true);
  });

  it('没超上限就原样返回（按纵向排好）', () => {
    const out = capRegions([r('B', 500, 1000), r('A', 0, 500)], 6);
    expect(out.map((g) => g.label)).toEqual(['A', 'B']);
  });
});

describe('值不值得分块', () => {
  it('只报出一块就别分了 —— 白花一次调用，还多一次漏行的机会', () => {
    expect(shouldChunk([r('全部', 0, 1000)])).toBe(false);
    expect(shouldChunk([r('A', 0, 500), r('B', 500, 1000)])).toBe(true);
  });
});
