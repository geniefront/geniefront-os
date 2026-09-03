import { describe, it, expect } from 'vitest';
import {
  computeStanding, explain, turnValueByAmount,
  FULL_TURN, HALF_TURN, DEFAULT_POLICY,
  type Participant, type RotationEvent, type RotationPolicy,
} from './engine';

const P = (name: string, seedOrder: number, inRotation = true): Participant =>
  ({ membershipId: name, name, inRotation, seedOrder });

let seq = 0;
const E = (
  membershipId: string, reason: RotationEvent['reason'],
  deltaBp = 0, extra: Partial<RotationEvent> = {},
): RotationEvent => ({
  id: `e${++seq}`, membershipId, reason, deltaBp,
  at: `2026-08-15T${String(8 + Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}:00Z`,
  actorId: null, note: null, ...extra,
});

const staff = [P('Amy', 0), P('Linh', 1), P('Kim', 2)];
const order = (s: ReturnType<typeof computeStanding>) =>
  s.entries.filter((e) => e.position !== null).map((e) => e.name);

describe('基本轮转', () => {
  it('没人做过单时按初始顺序（打卡先后）', () => {
    const s = computeStanding(staff, []);
    expect(order(s)).toEqual(['Amy', 'Linh', 'Kim']);
    expect(s.nextUp?.name).toBe('Amy');
  });

  it('做完一单排到队尾', () => {
    const s = computeStanding(staff, [E('Amy', 'served', FULL_TURN)]);
    expect(order(s)).toEqual(['Linh', 'Kim', 'Amy']);
  });

  it('⭐ 半轮：两个 $25 的小单才等于一个 $80 的大单', () => {
    const s = computeStanding(staff, [
      E('Amy', 'served', HALF_TURN),   // Amy 做了个修甲
      E('Linh', 'served', FULL_TURN),  // Linh 做了个套餐
    ]);
    // Amy 只消耗半轮，所以还在 Linh 前面
    expect(order(s)).toEqual(['Kim', 'Amy', 'Linh']);

    const s2 = computeStanding(staff, [
      E('Amy', 'served', HALF_TURN), E('Amy', 'served', HALF_TURN),
      E('Linh', 'served', FULL_TURN),
    ]);
    // 两个半轮 = 一整轮，此时按初始顺序 Amy 在 Linh 前
    expect(s2.entries.find((e) => e.name === 'Amy')!.turnsBp)
      .toBe(s2.entries.find((e) => e.name === 'Linh')!.turnsBp);
  });

  it('金额阶梯：$25 算半轮，$80 算一轮', () => {
    const tiers = [{ maxCents: 3000, turnBp: HALF_TURN }, { maxCents: null, turnBp: FULL_TURN }];
    expect(turnValueByAmount(2500, tiers)).toBe(HALF_TURN);
    expect(turnValueByAmount(8000, tiers)).toBe(FULL_TURN);
    expect(turnValueByAmount(3000, tiers)).toBe(HALF_TURN);  // 边界含等于
  });
});

describe('点钟单（决定性的一条店规）', () => {
  it('默认不消耗轮次 —— 指名找你不该占用你排队的机会', () => {
    const s = computeStanding(staff, [E('Amy', 'request_not_counted', FULL_TURN)]);
    expect(order(s)).toEqual(['Amy', 'Linh', 'Kim']);
    expect(s.entries.find((e) => e.name === 'Amy')!.turnsBp).toBe(0);
  });

  it('店主可以配成消耗轮次', () => {
    const policy: RotationPolicy = { ...DEFAULT_POLICY, requestCountsAsTurn: true };
    const s = computeStanding(staff, [E('Amy', 'request_not_counted', FULL_TURN)], policy);
    expect(order(s)).toEqual(['Linh', 'Kim', 'Amy']);
  });
});

describe('跳过与欠轮', () => {
  it('⭐ 不会做这个项目被跳过 → 不算他一轮，且下次优先', () => {
    const s = computeStanding(staff, [
      E('Amy', 'skipped_no_skill'),      // Amy 不会做 Gel-X，跳过
      E('Linh', 'served', FULL_TURN),    // 单给了 Linh
    ]);
    expect(order(s)).toEqual(['Amy', 'Kim', 'Linh']);
    expect(s.entries.find((e) => e.name === 'Amy')!.owed).toBe(1);
  });

  it('欠轮在轮次相同时把人往前提', () => {
    const s = computeStanding(staff, [
      E('Amy', 'skipped_no_skill'),
      E('Kim', 'skipped_no_skill'),
    ]);
    // Amy 和 Kim 都欠一轮、都是 0 轮，按初始顺序 Amy 在前；
    // Linh 没欠轮，排到他们后面
    expect(order(s)).toEqual(['Amy', 'Kim', 'Linh']);
  });

  it('店主可以配成「跳过也算一轮」', () => {
    const policy: RotationPolicy = { ...DEFAULT_POLICY, skipNoSkill: 'counts_as_turn' };
    const s = computeStanding(staff, [E('Amy', 'skipped_no_skill', FULL_TURN)], policy);
    expect(order(s)).toEqual(['Linh', 'Kim', 'Amy']);
  });

  it('请假被跳过不记欠轮 —— 人不在场不算被亏待', () => {
    const s = computeStanding(staff, [E('Amy', 'skipped_off')]);
    expect(s.entries.find((e) => e.name === 'Amy')!.owed).toBe(0);
  });

  it('接到单后欠轮抵掉一次', () => {
    const s = computeStanding(staff, [
      E('Amy', 'skipped_no_skill'),
      E('Amy', 'served', FULL_TURN),
    ]);
    expect(s.entries.find((e) => e.name === 'Amy')!.owed).toBe(0);
  });
});

describe('休息', () => {
  it('默认离开队列，回来后归位', () => {
    const s = computeStanding(staff, [E('Linh', 'break')]);
    expect(order(s)).toEqual(['Amy', 'Kim']);
    expect(s.entries.find((e) => e.name === 'Linh')!.state).toBe('on_break');

    const s2 = computeStanding(staff, [E('Linh', 'break'), E('Linh', 'back')]);
    expect(order(s2)).toEqual(['Amy', 'Linh', 'Kim']);
  });

  it('店主可以配成「休息时保留位置」', () => {
    const policy: RotationPolicy = { ...DEFAULT_POLICY, onBreak: 'stay_in_place' };
    const s = computeStanding(staff, [E('Linh', 'break')], policy);
    expect(order(s)).toEqual(['Amy', 'Linh', 'Kim']);
    // 位置保留，但不会被叫到
    expect(s.nextUp?.name).toBe('Amy');
  });

  it('全员休息时没有下一位（而不是硬塞一个）', () => {
    const s = computeStanding(staff, [E('Amy', 'break'), E('Linh', 'break'), E('Kim', 'break')]);
    expect(s.nextUp).toBeNull();
  });
});

describe('一人多角色：店长不吃 walk-in 轮（决策 20）', () => {
  it('inRotation=false 的人不进队列，但仍然在列表里', () => {
    const withManager = [P('Amy', 0, false), P('Linh', 1), P('Kim', 2)];
    const s = computeStanding(withManager, []);
    expect(order(s)).toEqual(['Linh', 'Kim']);
    expect(s.nextUp?.name).toBe('Linh');
    // Amy 仍然显示，只是标成不参与
    expect(s.entries.map((e) => e.name)).toContain('Amy');
    expect(s.entries.find((e) => e.name === 'Amy')!.state).toBe('off');
  });
});

describe('前台手动调序（决策 12：人的判断优先，但必须留痕）', () => {
  it('⭐ 手动排到第一位，压过算法的排序', () => {
    const s = computeStanding(staff, [
      E('Amy', 'served', FULL_TURN),        // Amy 本该在队尾
      E('Amy', 'manual_override', 0, { manualRank: 0, note: '客人指定要 Amy' }),
    ]);
    expect(order(s)[0]).toBe('Amy');
    expect(s.nextUp?.name).toBe('Amy');
  });

  it('⭐ 接到单后手动指定自动失效 —— 否则他会永远霸占第一位', () => {
    const s = computeStanding(staff, [
      E('Amy', 'manual_override', 0, { manualRank: 0, note: '客人指定' }),
      E('Amy', 'served', FULL_TURN),
    ]);
    expect(s.entries.find((e) => e.name === 'Amy')!.manualRank).toBeNull();
    expect(order(s)[0]).not.toBe('Amy');
  });

  it('点钟单也会用掉手动指定', () => {
    const s = computeStanding(staff, [
      E('Kim', 'manual_override', 0, { manualRank: 0 }),
      E('Kim', 'request_not_counted', FULL_TURN),
    ]);
    expect(s.entries.find((e) => e.name === 'Kim')!.manualRank).toBeNull();
  });

  it('⭐ 手动排到指定中间位次（manualRank: 2，第 3 位），自然队列正确定位', () => {
    // staff 默认打卡顺序: Amy, Linh, Kim
    // 所有人 0 轮，自然顺序为 [Amy, Linh, Kim]
    // 手动将 Amy 插到 index 2 (第 3 位)
    const s = computeStanding(staff, [
      E('Amy', 'manual_override', 0, { manualRank: 2, note: '延后接单' }),
    ]);
    expect(order(s)).toEqual(['Linh', 'Kim', 'Amy']);
    expect(s.entries.find((e) => e.name === 'Amy')!.position).toBe(2);
  });
});

describe('可解释性（技师质疑时前台要能说清）', () => {
  it('⭐ 每个人都能给出一句话解释', () => {
    const s = computeStanding(staff, [
      E('Amy', 'served', HALF_TURN),
      E('Linh', 'skipped_no_skill'),
    ]);
    const linh = s.entries.find((e) => e.name === 'Linh')!;
    const lines = explain(linh, DEFAULT_POLICY);
    expect(lines).toContain('被跳过 1 次，下次优先');
    expect(lines.some((l) => l.includes('已做 0 轮'))).toBe(true);

    const amy = s.entries.find((e) => e.name === 'Amy')!;
    expect(explain(amy, DEFAULT_POLICY).some((l) => l.includes('已做 0.5 轮'))).toBe(true);
  });

  it('手动调序的解释里带得出原因', () => {
    const s = computeStanding(staff, [
      E('Kim', 'manual_override', 0, { manualRank: 0, note: '客人指定' }),
    ]);
    const kim = s.entries.find((e) => e.name === 'Kim')!;
    expect(explain(kim, DEFAULT_POLICY).some((l) => l.includes('客人指定'))).toBe(true);
  });

  it('每个人都留有可追溯的事件流水', () => {
    const s = computeStanding(staff, [
      E('Amy', 'served', HALF_TURN, { note: '#1041' }),
      E('Amy', 'skipped_no_skill', 0, { note: '不会 Gel-X' }),
    ]);
    const amy = s.entries.find((e) => e.name === 'Amy')!;
    expect(amy.trail).toHaveLength(2);
    expect(amy.trail[0]!.reason).toBe('skipped_no_skill');  // 倒序，最新在前
    expect(amy.trail[1]!.note).toBe('#1041');
  });
});

describe('每日重置', () => {
  it('reset_daily 之后一切归零', () => {
    const s = computeStanding(staff, [
      E('Amy', 'served', FULL_TURN),
      E('Amy', 'skipped_no_skill'),
      E('Amy', 'reset_daily'),
    ]);
    const amy = s.entries.find((e) => e.name === 'Amy')!;
    expect(amy.turnsBp).toBe(0);
    expect(amy.owed).toBe(0);
    expect(amy.trail).toHaveLength(1);
  });
});

describe('稳定性', () => {
  it('事件乱序传入，结果一致（按时间重放）', () => {
    const evs = [E('Amy', 'served', FULL_TURN), E('Linh', 'served', HALF_TURN)];
    const a = computeStanding(staff, evs);
    const b = computeStanding(staff, [...evs].reverse());
    expect(order(a)).toEqual(order(b));
  });

  it('已离场的人的历史事件不会让引擎炸掉', () => {
    const s = computeStanding(staff, [E('已离职的人', 'served', FULL_TURN)]);
    expect(order(s)).toEqual(['Amy', 'Linh', 'Kim']);
  });
});

describe('上下牌与半天班（下午到店场景）', () => {
  it('下午才到的技师上午处于 not_arrived 状态，不进上午队列', () => {
    const mixedStaff: Participant[] = [
      P('Amy', 0),
      P('Linh', 1),
      { membershipId: 'Kim', name: 'Kim', inRotation: true, seedOrder: 2, shiftType: 'afternoon_only' },
    ];
    const s = computeStanding(mixedStaff, []);
    expect(order(s)).toEqual(['Amy', 'Linh']);
    const kim = s.entries.find((e) => e.name === 'Kim')!;
    expect(kim.state).toBe('not_arrived');
    expect(explain(kim, DEFAULT_POLICY)).toContain('上午未到店 / 待下午打卡上牌');
  });

  it('下午技师到店上牌后进入队列并记录到店时间', () => {
    const mixedStaff: Participant[] = [
      P('Amy', 0),
      P('Linh', 1),
      { membershipId: 'Kim', name: 'Kim', inRotation: true, seedOrder: 2, shiftType: 'afternoon_only' },
    ];
    const s = computeStanding(mixedStaff, [
      E('Amy', 'served', FULL_TURN),
      E('Kim', 'check_in', 0, { at: '2026-08-15T14:30:00Z', note: '下午打卡到店' }),
    ]);
    const kim = s.entries.find((e) => e.name === 'Kim')!;
    expect(kim.state).toBe('available');
    expect(kim.arrivedAt).toBe('2026-08-15T14:30:00Z');
    expect(order(s)).toEqual(['Linh', 'Kim', 'Amy']);
    expect(explain(kim, DEFAULT_POLICY).some((line) => line.includes('14:30 到店上牌'))).toBe(true);
  });

  it('技师下班离牌后退出队列并记录离店时间', () => {
    const s = computeStanding(staff, [
      E('Amy', 'check_out', 0, { at: '2026-08-15T21:00:00Z', note: '下班离开' }),
    ]);
    const amy = s.entries.find((e) => e.name === 'Amy')!;
    expect(amy.state).toBe('off');
    expect(amy.leftAt).toBe('2026-08-15T21:00:00Z');
    expect(order(s)).toEqual(['Linh', 'Kim']);
    expect(explain(amy, DEFAULT_POLICY).some((line) => line.includes('21:00 下班离牌'))).toBe(true);
  });
});

describe('首发技师与技能关联', () => {
  it('指定首发技师在轮次相同(0轮)时优先排在第一位', () => {
    const policy: RotationPolicy = {
      ...DEFAULT_POLICY,
      startingMode: 'designated_staff',
      startingStaffMembershipId: 'Kim',
    };
    const s = computeStanding(staff, [], policy);
    expect(order(s)).toEqual(['Kim', 'Amy', 'Linh']);
    expect(s.nextUp?.name).toBe('Kim');
  });

  it('技师技能与职级元数据能够正确挂载在 StandingEntry 上', () => {
    const staffWithSkills: Participant[] = [
      {
        membershipId: 'Amy',
        name: 'Amy',
        inRotation: true,
        seedOrder: 0,
        levelName: '资深总监',
        skills: [{ id: 's1', key: 'gel', name: '光疗美甲' }],
      },
    ];
    const s = computeStanding(staffWithSkills, []);
    const amy = s.entries.find((e) => e.name === 'Amy')!;
    expect(amy.levelName).toBe('资深总监');
    expect(amy.skills).toEqual([{ id: 's1', key: 'gel', name: '光疗美甲' }]);
  });
});
