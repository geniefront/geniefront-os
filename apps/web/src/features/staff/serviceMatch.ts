/**
 * 员工「可接 / 不可接」必须对照本店真实项目，不能拿一份写死的美甲目录去套足疗技师。
 */

export interface MatchableService {
  id: string;
  name: string;
  requiredSkillNames: string[];
}

export function matchStaffServices<T extends MatchableService>(
  skills: string[],
  catalog: T[],
): { canDo: T[]; cannotDo: T[] } {
  const skillSet = new Set(skills);
  const canDo: T[] = [];
  const cannotDo: T[] = [];
  for (const service of catalog) {
    if (
      service.requiredSkillNames.length === 0
      || service.requiredSkillNames.some((name) => skillSet.has(name))
    ) {
      canDo.push(service);
    } else {
      cannotDo.push(service);
    }
  }
  return { canDo, cannotDo };
}
