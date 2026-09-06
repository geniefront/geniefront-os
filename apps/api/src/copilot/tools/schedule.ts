/**
 * 员工与排班领域只读工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { pickText } from '@gf/contracts';
import { loadStaffDirectory } from '../../queries/staffList.js';
import { loadRoster } from '../../queries/roster.js';

export async function getStaffDirectory(
  ctx: CommandContext,
  _input: Record<string, unknown>,
): Promise<unknown> {
  const result = await withTenant(ctx, (tx) => loadStaffDirectory(tx, ctx));
  return {
    staff: result.staff.map((s) => ({
      membershipId: s.membershipId,
      name: s.name,
      jobTitle: s.jobTitle,
      level: s.level,
      isBookable: s.isBookable,
      skills: s.skills,
      maxConcurrent: s.maxConcurrentAppointments,
      status: s.status,
    })),
  };
}

export async function getStaffSchedules(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const from = String(input['from'] ?? input['date'] ?? new Date().toISOString().slice(0, 10));
  const days = Math.max(1, Math.min(30, Number(input['days'] ?? 7)));

  const roster = await withTenant(ctx, (tx) => loadRoster(tx, ctx, from, days));
  const staffNameMap = new Map(roster.staff.map((s) => [s.membershipId, s.name]));
  return {
    from: roster.fromDate,
    to: roster.toDate,
    shifts: roster.shifts.map((s) => ({
      membershipId: s.membershipId,
      staffName: staffNameMap.get(s.membershipId) ?? '未知',
      date: s.businessDate,
      startMin: s.startMin,
      endMin: s.endMin,
      status: s.status,
      isOff: s.status === 'off',
    })),
  };
}
