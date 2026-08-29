import { describe, expect, it } from 'vitest';
import { rankStaffCandidates } from './assignment';
import type { DayService, DayStaff } from '@/features/schedule/types';

const skill = { id: 'skill-1', key: 'massage', name: 'Massage' };
const service: DayService = { id: 'svc', name: 'Massage', durationMin: 60, priceCents: 10000, staffCount: 1, requiredSkills: [skill] };
const makeStaff = (id: string, skills = [skill]): DayStaff => ({ membershipId: id, name: id, isBookable: true, inRotation: true, maxConcurrent: 1, color: null, levelName: null, skills });

describe('rankStaffCandidates', () => {
  it('hard-excludes staff who lack a required skill', () => {
    const [candidate] = rankStaffCandidates({ staff: [makeStaff('a', [])], service, rotationEntries: [{ membershipId: 'a', name: 'a', turns: 0, owed: 0, state: 'available', position: 1, manualRank: null, why: [], skills: [], arrivedAt: null, leftAt: null, trail: [] }], scheduledItems: [], onlineIds: new Set(['a']), nowMs: Date.now() });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.reasons).toContain('skill_missing');
  });

  it('uses online as a ranking signal, not an availability source of truth', () => {
    const entries = ['a', 'b'].map((membershipId, index) => ({ membershipId, name: membershipId, turns: 0, owed: 0, state: 'available' as const, position: index + 1, manualRank: null, why: [], skills: [], arrivedAt: null, leftAt: null, trail: [] }));
    const result = rankStaffCandidates({ staff: [makeStaff('a'), makeStaff('b')], service, rotationEntries: entries, scheduledItems: [], onlineIds: new Set(['b']), nowMs: Date.now() });
    expect(result[0]?.staff.membershipId).toBe('b');
    expect(result[1]?.eligible).toBe(true);
    expect(result[1]?.reasons).toContain('offline');
  });
});
