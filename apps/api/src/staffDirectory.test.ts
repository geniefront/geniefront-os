import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadStaffDirectory } from './queries/staffList';
import './handlers/staff';

const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
let ctx: Awaited<ReturnType<typeof buildContext>>;
beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id where m.location_id = ${tenant.locationId}
      and r.key in ('owner', 'manager') and m.user_id is not null limit 1`);
  ctx = await buildContext({ membershipId: owner!.id, userId: owner!.user_id });
});
afterAll(closeDb);

describe('staff directory persistence', () => {
  it('round-trips contacts and preserves omitted booking settings', async () => {
    const created = await dispatch<{ membershipId: string }>('staff.saveProfile', {
      name: 'Directory Regression', phone: '+16175550991', email: 'directory@example.test',
      isBookable: false, maxConcurrentAppointments: 3, inRotation: false,
      payroll: { kind: 'hourly', ratePercent: 42.25, hourlyRateDollars: 18.75, base: 'net' },
    }, ctx);
    await dispatch('staff.saveProfile', { membershipId: created.result.membershipId, name: 'Updated Directory' }, ctx);
    const { staff } = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    expect(staff.find((person) => person.id === created.result.membershipId)).toMatchObject({
      name: 'Updated Directory', phone: '+16175550991', email: 'directory@example.test',
      isBookable: false, maxConcurrentAppointments: 3,
      payroll: { ratePercent: 42.25, hourlyRateDollars: 18.75 },
    });
  });

  it('directory rename preserves skill IDs and inactive assignments', async () => {
    const skill = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'skill', name: 'Regression skill', sort: 17 }, ctx);
    const person = await dispatch<{ membershipId: string }>('staff.saveProfile', {
      name: 'Skill regression', skillIds: [skill.result.id], isBookable: false, inRotation: false,
    }, ctx);
    await dispatch('staff.saveDirectoryOption', { kind: 'skill', id: skill.result.id, name: 'Renamed skill', active: false, sort: 8 }, ctx);
    const directory = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    expect(directory.staff.find((row) => row.id === person.result.membershipId)?.skillIds).toEqual([skill.result.id]);
    expect(directory.skills.find((row) => row.id === skill.result.id)).toMatchObject({ name: 'Renamed skill', active: false, sort: 8 });
    await expect(dispatch('staff.saveProfile', { name: 'New unqualified staff', skillIds: [skill.result.id] }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('renaming a job title updates the assigned profiles', async () => {
    const job = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'job', name: 'Regression job' }, ctx);
    const person = await dispatch<{ membershipId: string }>('staff.saveProfile', { name: 'Job regression', jobTitle: 'Regression job', inRotation: false }, ctx);
    await dispatch('staff.saveDirectoryOption', { kind: 'job', id: job.result.id, name: 'Renamed job' }, ctx);
    const directory = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    const saved = directory.staff.find((row) => row.id === person.result.membershipId);
    expect(saved?.jobTitle).toBe('Renamed job');
    expect(saved?.jobTitleId).toBe(job.result.id);
  });
});

describe('staff directory ID contract (U02 / W2)', () => {
  it('rejects free-text job/level/skill values with no matching directory row', async () => {
    await expect(dispatch('staff.saveProfile', { name: 'Free job', jobTitle: 'Totally made up title', inRotation: false }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'unknown_job_title' } });
    await expect(dispatch('staff.saveProfile', { name: 'Free level', level: 'Invented tier', inRotation: false }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'unknown_level' } });
    await expect(dispatch('staff.saveProfile', { name: 'Free skill', skills: ['Invented technique'], inRotation: false }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'unknown_skill' } });
    // 拒绝后没有新建任何目录项
    const { jobs, levels, skills } = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    expect(jobs.some((j) => j.name === 'Totally made up title')).toBe(false);
    expect(levels.some((l) => l.name === 'Invented tier')).toBe(false);
    expect(skills.some((s) => s.name === 'Invented technique')).toBe(false);
  });

  it('accepts a directory id and stores it; round-trips via loadStaffDirectory', async () => {
    const job = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'job', name: 'Contract job' }, ctx);
    const level = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'level', name: 'Contract level' }, ctx);
    const skill = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'skill', name: 'Contract skill' }, ctx);
    const person = await dispatch<{ membershipId: string }>('staff.saveProfile', {
      name: 'ID contract staff', inRotation: false, isBookable: false,
      jobTitleId: job.result.id, levelId: level.result.id, skillIds: [skill.result.id],
    }, ctx);
    const { staff } = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    const row = staff.find((s) => s.id === person.result.membershipId);
    expect(row).toMatchObject({ jobTitleId: job.result.id, levelId: level.result.id, skillIds: [skill.result.id] });
    expect(row?.jobTitle).toBe('Contract job');
  });

  it('rejects a directory id that belongs to another location', async () => {
    const SPA = { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null };
    const [foreign] = await withTenant(SPA, (tx) => tx<{ id: string }[]>`
      insert into staff_job_titles (org_id, location_id, name, sort, active)
      values (${SPA.orgId}, ${SPA.locationId}, 'Foreign store job', 0, true) returning id`);
    await expect(dispatch('staff.saveProfile', { name: 'Cross store', jobTitleId: foreign!.id, inRotation: false }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'invalid_or_inactive_job_title' } });
  });

  it('blocks a deactivated option for a new hire but keeps it for the person already assigned', async () => {
    const job = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'job', name: 'Sunset job' }, ctx);
    const holder = await dispatch<{ membershipId: string }>('staff.saveProfile', {
      name: 'Sunset holder', inRotation: false, isBookable: false, jobTitleId: job.result.id,
    }, ctx);
    await dispatch('staff.saveDirectoryOption', { kind: 'job', id: job.result.id, name: 'Sunset job', active: false, sort: 0 }, ctx);
    // 新员工不能再选停用项
    await expect(dispatch('staff.saveProfile', { name: 'Late hire', jobTitleId: job.result.id, inRotation: false }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'invalid_or_inactive_job_title' } });
    // 已关联者改无关字段仍能保存，关联不丢
    await dispatch('staff.saveProfile', { membershipId: holder.result.membershipId, phone: '+16175550143' }, ctx);
    const { staff } = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    expect(staff.find((s) => s.id === holder.result.membershipId)).toMatchObject({ jobTitleId: job.result.id, phone: '+16175550143' });
  });

  it('reorderDirectoryOptions persists a stable order and rejects a partial / foreign list', async () => {
    const a = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'level', name: 'Reorder A' }, ctx);
    const b = await dispatch<{ id: string }>('staff.saveDirectoryOption', { kind: 'level', name: 'Reorder B' }, ctx);
    const before = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    const ids = before.levels.map((l) => l.id);
    const reversed = [...ids].reverse();
    await dispatch('staff.reorderDirectoryOptions', { kind: 'level', orderedIds: reversed }, ctx);
    const after = await withTenant(tenant, (tx) => loadStaffDirectory(tx, ctx));
    expect(after.levels.map((l) => l.id)).toEqual(reversed);
    await expect(dispatch('staff.reorderDirectoryOptions', { kind: 'level', orderedIds: [a.result.id, b.result.id] }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'directory_reorder_mismatch' } });
  });
});
