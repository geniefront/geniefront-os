import { describe, it, expect } from 'vitest';
import {
  allocateTip, assertLegalTipPolicy, explainAllocation, TipPolicyError,
  DEFAULT_TIP_POLICY, BP, type ServiceLine, type TipPolicy,
} from './tip';

const line = (
  membershipId: string, minutes: number, amountCents: number,
  extra: Partial<ServiceLine> = {},
): ServiceLine => ({
  ticketItemId: `i-${membershipId}`, membershipId, name: membershipId,
  role: 'primary', minutes, amountCents, levelKey: null, ...extra,
});

const sum = (r: ReturnType<typeof allocateTip>) =>
  r.allocations.reduce((s, a) => s + a.amountCents, 0);
const got = (r: ReturnType<typeof allocateTip>, id: string) =>
  r.allocations.find((a) => a.membershipId === id)?.amountCents ?? 0;

describe('FLSA 硬锁（不可协商）', () => {
  it('⭐ house_cut 非 0 直接拒绝 —— 联邦法禁止雇主占有小费', () => {
    const bad = { ...DEFAULT_TIP_POLICY, houseCutBp: 500 } as unknown as TipPolicy;
    expect(() => assertLegalTipPolicy(bad)).toThrow(TipPolicyError);
    try { assertLegalTipPolicy(bad); } catch (e) {
      expect((e as TipPolicyError).code).toBe('HOUSE_CUT_FORBIDDEN');
    }
  });

  it('分配时也会挡，不只是保存时挡', () => {
    const bad = { ...DEFAULT_TIP_POLICY, houseCutBp: 1 } as unknown as TipPolicy;
    expect(() => allocateTip(2000, [line('Amy', 60, 8000)], bad)).toThrow(TipPolicyError);
  });

  it('tip_out 比例越界要拒绝', () => {
    const bad: TipPolicy = {
      ...DEFAULT_TIP_POLICY,
      tipOut: [{ fromRole: 'primary', toRole: 'assistant', bp: 20_000 }],
    };
    expect(() => assertLegalTipPolicy(bad)).toThrow(/0–10000/);
  });
});

describe('分毫不差（技师会发现差一分钱）', () => {
  it('⭐ 三个人分 $10，总额必须精确等于 1000 分', () => {
    const r = allocateTip(1000, [
      line('Amy', 60, 6000), line('Linh', 60, 6000), line('Kim', 60, 6000),
    ]);
    expect(sum(r)).toBe(1000);
    // 1000/3 = 333.33，有人拿 334
    expect(r.allocations.map((a) => a.amountCents).sort()).toEqual([333, 333, 334]);
  });

  it('⭐ 除不尽的各种金额都不丢分', () => {
    for (const tip of [1, 7, 99, 333, 1234, 5001, 9999]) {
      for (const n of [2, 3, 4, 7]) {
        const lines = Array.from({ length: n }, (_, i) => line(`s${i}`, 30 + i, 5000));
        expect(sum(allocateTip(tip, lines))).toBe(tip);
      }
    }
  });

  it('小费为 0 或没人做时不产生分配', () => {
    expect(allocateTip(0, [line('Amy', 60, 8000)]).allocations).toEqual([]);
    const r = allocateTip(1000, []);
    expect(r.allocations).toEqual([]);
    expect(r.pooledCents).toBe(1000);
  });
});

describe('按服务时长分（默认规则）', () => {
  it('做得久的分得多', () => {
    const r = allocateTip(3000, [line('Amy', 40, 8000), line('Kim', 20, 4000)]);
    expect(got(r, 'Amy')).toBe(2000);
    expect(got(r, 'Kim')).toBe(1000);
  });

  it('⭐ 文档里那个例子：Master 1.5x 做 40min + 新手 1.0x 做 40min，$30 小费', () => {
    const policy: TipPolicy = {
      ...DEFAULT_TIP_POLICY,
      levelWeightsBp: { master: 15_000, junior: BP },
    };
    const r = allocateTip(3000, [
      line('Amy', 40, 6000, { levelKey: 'master' }),
      line('Kim', 40, 6000, { levelKey: 'junior' }),
    ], policy);
    // 权重 60 : 40 → $18.00 / $12.00（00 §3.0 的透明示例）
    expect(got(r, 'Amy')).toBe(1800);
    expect(got(r, 'Kim')).toBe(1200);
    expect(sum(r)).toBe(3000);
  });
});

describe('其他分配基准', () => {
  it('按服务金额占比', () => {
    const policy: TipPolicy = { ...DEFAULT_TIP_POLICY, basis: 'price_share' };
    const r = allocateTip(1000, [line('Amy', 30, 7500), line('Kim', 90, 2500)], policy);
    // 金额 75:25，时长不参与
    expect(got(r, 'Amy')).toBe(750);
    expect(got(r, 'Kim')).toBe(250);
  });

  it('平均分（不看时长金额）', () => {
    const policy: TipPolicy = { ...DEFAULT_TIP_POLICY, basis: 'equal' };
    const r = allocateTip(1000, [line('Amy', 10, 9000), line('Kim', 90, 1000)], policy);
    expect(got(r, 'Amy')).toBe(500);
    expect(got(r, 'Kim')).toBe(500);
  });
});

describe('双技师与助理', () => {
  it('助理权重更低', () => {
    const r = allocateTip(1300, [
      line('Amy', 60, 9000),
      line('Kim', 60, 0, { role: 'assistant' }),   // 0.3x
    ]);
    expect(got(r, 'Amy')).toBe(1000);
    expect(got(r, 'Kim')).toBe(300);
  });

  it('⭐ tip-out：主技师按比例分给助理，总额不变', () => {
    const policy: TipPolicy = {
      ...DEFAULT_TIP_POLICY,
      roleWeightsBp: { primary: BP, assistant: 0 },   // 助理不直接参与分配
      tipOut: [{ fromRole: 'primary', toRole: 'assistant', bp: 1_000 }],  // 主技师给 10%
    };
    const r = allocateTip(2000, [
      line('Amy', 60, 9000),
      line('Kim', 60, 0, { role: 'assistant' }),
    ], policy);
    expect(got(r, 'Amy')).toBe(1800);
    expect(got(r, 'Kim')).toBe(200);
    expect(sum(r)).toBe(2000);
  });
});

describe('接力服务（同一人多条 line 要合并）', () => {
  it('⭐ Amy 做 30min 被叫走、Kim 接手 40min —— 按各自实际工时分', () => {
    const r = allocateTip(3500, [
      line('Amy', 30, 4000),
      line('Kim', 40, 5000),
    ]);
    expect(got(r, 'Amy')).toBe(1500);
    expect(got(r, 'Kim')).toBe(2000);
  });

  it('同一人的多条 line 合并成一笔，不重复出现', () => {
    const r = allocateTip(2000, [
      line('Amy', 30, 3000), line('Amy', 30, 3000), line('Kim', 60, 6000),
    ]);
    expect(r.allocations).toHaveLength(2);
    expect(got(r, 'Amy')).toBe(1000);
    expect(r.allocations.find((a) => a.membershipId === 'Amy')!.basis.minutes).toBe(60);
  });
});

describe('余数归属由店规决定', () => {
  it('给服务时间最长的人', () => {
    const r = allocateTip(1000, [
      line('Amy', 61, 5000), line('Linh', 60, 5000), line('Kim', 59, 5000),
    ], { ...DEFAULT_TIP_POLICY, remainderTo: 'longest_service' });
    expect(sum(r)).toBe(1000);
    // Amy 时间最长，余数归他
    expect(got(r, 'Amy')).toBeGreaterThanOrEqual(got(r, 'Linh'));
  });

  it('给等级最高的人', () => {
    const policy: TipPolicy = {
      ...DEFAULT_TIP_POLICY, remainderTo: 'highest_level',
      levelWeightsBp: { master: 15_000, junior: BP },
    };
    const r = allocateTip(1001, [
      line('Amy', 60, 5000, { levelKey: 'junior' }),
      line('Master', 60, 5000, { levelKey: 'master' }),
    ], policy);
    expect(sum(r)).toBe(1001);
  });
});

describe('可解释性（技师下班要看懂自己为什么分这么多）', () => {
  it('⭐ 每一笔都能翻译成一句人话', () => {
    const policy: TipPolicy = { ...DEFAULT_TIP_POLICY, levelWeightsBp: { master: 15_000 } };
    const r = allocateTip(3000, [
      line('Amy', 40, 6000, { levelKey: 'master' }),
      line('Kim', 40, 6000),
    ], policy);
    const amy = r.allocations.find((a) => a.membershipId === 'Amy')!;
    const text = explainAllocation(amy);
    expect(text).toContain('做了 40 分钟');
    expect(text).toContain('等级系数 1.5x');
    expect(text).toContain('占 60.0%');
  });

  it('basis 里存着完整依据，能落库供事后追溯', () => {
    const r = allocateTip(1000, [line('Amy', 50, 8000), line('Kim', 30, 4000)]);
    const amy = r.allocations.find((a) => a.membershipId === 'Amy')!;
    expect(amy.basis).toMatchObject({ rule: 'active_minutes', minutes: 50 });
    expect(amy.basis.sharePct).toBe('62.5%');
  });
});
