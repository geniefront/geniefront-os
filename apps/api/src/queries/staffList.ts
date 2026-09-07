/**
 * 员工花名册聚合查询（EmployeePerformance.tsx，员工中台管理）
 */

import type postgres from 'postgres';
import { pickText, type CommandContext, asCents } from '@gf/contracts';

export interface DirectoryOption { id: string; key: string; name: string; active: boolean; sort: number }

export interface StaffDirectoryItem {
  id: string;
  membershipId: string;
  employeeNo: string;
  isBookable: boolean;
  maxConcurrentAppointments: number;
  name: string;
  phone: string;
  email?: string | null | undefined;
  jobTitle: string;
  jobTitleId: string | null;
  level: string;
  levelId: string | null;
  skills: string[];
  skillIds: string[];
  status: 'active' | 'on_leave' | 'resigned';
  hireDate: string;
  payroll: {
    kind: 'commission' | 'hourly' | 'commission_vs_hourly' | 'booth_rent';
    ratePercent: number;
    hourlyRateDollars: number;
    base: 'net' | 'gross';
  };
  note?: string | null | undefined;
}

export async function loadStaffDirectory(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ staff: StaffDirectoryItem[]; skills: DirectoryOption[]; levels: DirectoryOption[]; jobs: DirectoryOption[] }> {
  const rows = await tx<{
    membership_id: string;
    employee_no: string | null;
    is_bookable: boolean;
    max_concurrent_appointments: number;
    display_name: unknown;
    phone_e164: string | null;
    job_title: string | null;
    job_title_id: string | null;
    notes: string | null;
    hire_date: string | null;
    level_id: string | null;
    level_name: unknown;
    status: string;
    user_email: string | null;
  }[]>`
    select sp.membership_id,
           sp.employee_no, sp.is_bookable, sp.max_concurrent_appointments,
           sp.display_name,
           sp.phone_e164,
           sp.job_title,
           sp.job_title_id,
           sp.notes,
           sp.hire_date::text as hire_date,
           sp.level_id,
           sl.name as level_name,
           m.status,
           coalesce(sp.contact_email, u.email) as user_email
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id
    left join staff_levels sl on sl.id = sp.level_id
    left join users u on u.id = m.user_id
    where sp.location_id = ${ctx.locationId}
    order by sp.employee_no nulls last, sp.display_name->>'en'`;

  // 技能标签
  const skillRows = await tx<{
    membership_id: string;
    id: string;
    key: string;
    name: unknown;
  }[]>`
    select ss.membership_id, sk.id, sk.key, sk.name
    from staff_skills ss
    join skills sk on sk.id = ss.skill_id
    where sk.location_id = ${ctx.locationId}`;

  const skillsByMember = new Map<string, string[]>();
  for (const s of skillRows) {
    const list = skillsByMember.get(s.membership_id) ?? [];
    list.push(pickText(s.name, ctx.locale, s.key));
    skillsByMember.set(s.membership_id, list);
  }

  // 薪酬方案
  const planRows = await tx<{
    membership_id: string | null;
    config: Record<string, unknown>;
  }[]>`
    select distinct on (membership_id) membership_id, config
    from compensation_plans
    where location_id = ${ctx.locationId}
    order by membership_id, version desc`;

  const plansByMember = new Map<string | null, Record<string, unknown>>();
  for (const p of planRows) {
    plansByMember.set(p.membership_id, p.config);
  }

  const defaultPlanConfig = plansByMember.get(null) ?? {};

  const staff: StaffDirectoryItem[] = rows.map((r) => {
    const rawStatus = r.status;
    let mappedStatus: 'active' | 'on_leave' | 'resigned' = 'active';
    if (rawStatus === 'left' || rawStatus === 'resigned') {
      mappedStatus = 'resigned';
    } else if (rawStatus === 'suspended' || rawStatus === 'on_leave') {
      mappedStatus = 'on_leave';
    }

    const memberPlan = plansByMember.get(r.membership_id) ?? defaultPlanConfig;
    const rateBp = Number(memberPlan['rateBp'] ?? memberPlan['rate_bp'] ?? 0);
    const hourlyCents = asCents(memberPlan['hourlyRateCents'] ?? memberPlan['hourly_rate_cents'] ?? 0);
    const kind = (memberPlan['kind'] as any) || 'commission';
    const base = ((memberPlan['base'] as any) || 'net') as 'net' | 'gross';

    const empNo = r.employee_no ?? '';
    const name = pickText(r.display_name, ctx.locale, '员工');
    const level = r.level_name ? pickText(r.level_name, ctx.locale, '') : '';
    const jobTitle = r.job_title ?? '';

    return {
      id: r.membership_id,
      membershipId: r.membership_id,
      employeeNo: empNo,
      isBookable: r.is_bookable,
      maxConcurrentAppointments: r.max_concurrent_appointments,
      name,
      phone: r.phone_e164 ?? '',
      ...(r.user_email ? { email: r.user_email } : {}),
      jobTitle,
      jobTitleId: r.job_title_id,
      level,
      levelId: r.level_id,
      skills: skillsByMember.get(r.membership_id) ?? [],
      skillIds: skillRows.filter((skill) => skill.membership_id === r.membership_id).map((skill) => skill.id),
      status: mappedStatus,
      hireDate: r.hire_date ?? '',
      payroll: {
        kind,
        ratePercent: rateBp / 100,
        hourlyRateDollars: hourlyCents / 100,
        base,
      },
      ...(r.notes ? { note: r.notes } : {}),
    };
  });

  const catalog = await tx<Array<Omit<DirectoryOption, 'name'> & { name: unknown }>>`
    select id, key, name, active, sort from skills where location_id = ${ctx.locationId} order by sort, key`;
  const levels = await tx<Array<Omit<DirectoryOption, 'name'> & { name: unknown }>>`
    select id, key, name, active, sort from staff_levels where location_id = ${ctx.locationId} order by sort, key`;
  const jobs = await tx<DirectoryOption[]>`
    select id, name as key, name, active, sort from staff_job_titles where location_id = ${ctx.locationId} order by sort, name`;
  return { staff, jobs, levels: levels.map((level) => ({ ...level, name: pickText(level.name, ctx.locale, level.key) })), skills: catalog.map((skill) => ({ ...skill, name: pickText(skill.name, ctx.locale, skill.key) })) };
}
