import { describe, expect, it } from 'vitest';
import { rankStaffCandidates } from './assignment';
import type { DayService, DayStaff } from '@/features/schedule/types';
import type { RotationEntry } from '@/features/rotation/types';

const skill = { id: 'skill-1', key: 'massage', name: 'Massage' };
const service: DayService = { id: 'svc', name: 'Massage', durationMin: 60, priceCents: 10000, staffCount: 1, requiredSkills: [skill] };
const makeStaff = (id: string, skills = [skill]): DayStaff => ({ membershipId: id, name: id, isBookable: true, inRotation: true, maxConcurrent: 1, color: null, levelName: null, skills });

/** ⚠️ 引擎里的 position 是 0 基：0 就是「下一位轮到他」。 */
const entryAt = (membershipId: string, position: number | null): RotationEntry => ({
  membershipId, name: membershipId, turns: 0, owed: 0, state: 'available',
  position, manualRank: null, why: [], skills: [], arrivedAt: null, leftAt: null, trail: [],
});

const rank = (args: Partial<Parameters<typeof rankStaffCandidates>[0]> & { staff: DayStaff[] }) =>
  rankStaffCandidates({
    service, rotationEntries: [], scheduledItems: [], onlineIds: new Set<string>(),
    nowMs: Date.now(), ...args,
  });

describe('rankStaffCandidates', () => {
  it('hard-excludes staff who lack a required skill', () => {
    const [candidate] = rank({ staff: [makeStaff('a', [])], rotationEntries: [entryAt('a', 0)], onlineIds: new Set(['a']) });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.reasons).toContain('skill_missing');
  });

  /*
   * 轮牌决定谁接单，也就决定谁挣钱。「技师端 app 有没有连上」不该改变这个顺序 ——
   * Desk-Only 的店里根本没人开 app。此前 online 是 300 分而轮牌总跨度只有 200 分，
   * 一个在线的末位能压过离线的首位。
   */
  it('手机在线不再压过轮牌顺位', () => {
    const result = rank({
      staff: [makeStaff('a'), makeStaff('b')],
      rotationEntries: [entryAt('a', 0), entryAt('b', 1)],
      onlineIds: new Set(['b']),
    });
    expect(result[0]?.staff.membershipId).toBe('a');
    expect(result[0]?.reasons).toContain('offline');
    expect(result[1]?.eligible).toBe(true);
  });

  it('顺位并列时（都不在轮牌里）在线才起作用', () => {
    const result = rank({ staff: [makeStaff('a'), makeStaff('b')], onlineIds: new Set(['b']) });
    expect(result[0]?.staff.membershipId).toBe('b');
  });

  /*
   * 调用方传的 requestedStaffId 是「预约排给谁」。此前它被当成「顾客指定」，
   * 拿 2000 分压过一切，候选卡上还写着「顾客指定」—— 而客人根本没点钟。
   */
  it('只排班未点钟：算 assigned，不算 requested', () => {
    const result = rank({
      staff: [makeStaff('a'), makeStaff('b')],
      rotationEntries: [entryAt('a', 0), entryAt('b', 1)],
      requestedStaffId: 'b',
    });
    const b = result.find((c) => c.staff.membershipId === 'b');
    expect(b?.reasons).toContain('assigned');
    expect(b?.reasons).not.toContain('requested');
  });

  it('排班归属有分量但压不过整个轮牌：差两位能赢，差五位不能', () => {
    const near = rank({
      staff: [makeStaff('a'), makeStaff('b')],
      rotationEntries: [entryAt('a', 0), entryAt('b', 2)],
      requestedStaffId: 'b',
    });
    expect(near[0]?.staff.membershipId).toBe('b');

    const far = rank({
      staff: [makeStaff('a'), makeStaff('b')],
      rotationEntries: [entryAt('a', 0), entryAt('b', 5)],
      requestedStaffId: 'b',
    });
    expect(far[0]?.staff.membershipId).toBe('a');
  });

  it('真点钟绝对优先，轮牌末位也排第一', () => {
    const result = rank({
      staff: [makeStaff('a'), makeStaff('b')],
      rotationEntries: [entryAt('a', 0), entryAt('b', 19)],
      requestedStaffId: 'b',
      isRequest: true,
    });
    expect(result[0]?.staff.membershipId).toBe('b');
    expect(result[0]?.reasons).toContain('requested');
    expect(result[0]?.reasons).not.toContain('assigned');
  });

  it('不在轮牌队列的专属技师，被预约排到就算在岗', () => {
    const [only] = rank({ staff: [makeStaff('a')], requestedStaffId: 'a' });
    expect(only?.eligible).toBe(true);
    expect(only?.reasons).toContain('available');
  });

  it('没有排班归属时不会把 null 当成命中', () => {
    const [only] = rank({ staff: [makeStaff('a')], rotationEntries: [entryAt('a', 0)], requestedStaffId: null });
    expect(only?.reasons).not.toContain('assigned');
    expect(only?.reasons).not.toContain('requested');
  });
});
