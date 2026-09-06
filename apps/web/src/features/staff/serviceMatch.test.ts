import { describe, expect, it } from 'vitest';
import { matchStaffServices } from './serviceMatch';

describe('matchStaffServices', () => {
  const catalog = [
    { id: 'a', name: '经络足道 60 分钟', requiredSkillIds: ['足底反射'] },
    { id: 'b', name: '日式光疗美甲', requiredSkillIds: ['日式光疗美甲'] },
    { id: 'c', name: '茶水', requiredSkillIds: [] },
  ];

  it('requires every required skill, not just one', () => {
    const services = [{ id: 'multi', name: 'Multi', requiredSkillIds: ['a', 'b'] }];
    expect(matchStaffServices(['a'], services).cannotDo).toEqual(services);
    expect(matchStaffServices(['a', 'b'], services).canDo).toEqual(services);
  });

  it('按本店技能匹配，足疗技师不会对上美甲目录而成 0 项', () => {
    const { canDo, cannotDo } = matchStaffServices(['足底反射'], catalog);
    expect(canDo.map((s) => s.id)).toEqual(['a', 'c']);
    expect(cannotDo.map((s) => s.id)).toEqual(['b']);
  });
});
