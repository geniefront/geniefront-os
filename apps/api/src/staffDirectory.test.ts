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
    expect(directory.staff.find((row) => row.id === person.result.membershipId)?.jobTitle).toBe('Renamed job');
  });
});
