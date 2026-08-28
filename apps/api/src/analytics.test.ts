/**
 * 经营分析与绩效报表测试（P1 经营报表）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { loadRevenueTrends, loadCustomerAnalytics, loadStaffAnalytics } from './queries/analytics';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });
});

afterAll(async () => {
  await closeDb();
});

describe('多维经营报表', () => {
  const from = '2026-08-01';
  const to = '2026-08-28';

  it('loadRevenueTrends 返回走势与分类汇总', async () => {
    const rev = await withTenant(tenant, (tx) => loadRevenueTrends(tx, ownerCtx, from, to));
    expect(rev).toHaveProperty('trends');
    expect(rev).toHaveProperty('byCategory');
    expect(rev).toHaveProperty('byPaymentMethod');
    expect(Array.isArray(rev.trends)).toBe(true);
    expect(Array.isArray(rev.byCategory)).toBe(true);
    expect(rev.byPaymentMethod).toHaveProperty('cashCents');
    expect(rev.byPaymentMethod).toHaveProperty('cardCents');
  });

  it('loadCustomerAnalytics 返回留存与客流结构', async () => {
    const cust = await withTenant(tenant, (tx) => loadCustomerAnalytics(tx, ownerCtx, from, to));
    expect(cust).toHaveProperty('totalVisits');
    expect(cust).toHaveProperty('retentionRateBp');
    expect(cust).toHaveProperty('averageTicketCents');
    expect(cust).toHaveProperty('satisfactionScore');
    expect(cust).toHaveProperty('timeline');
    expect(typeof cust.totalVisits).toBe('number');
    expect(typeof cust.satisfactionScore).toBe('number');
  });

  it('loadStaffAnalytics 返回技师业绩与提成汇总大表', async () => {
    const staff = await withTenant(tenant, (tx) => loadStaffAnalytics(tx, ownerCtx, from, to));
    expect(staff).toHaveProperty('rows');
    expect(Array.isArray(staff.rows)).toBe(true);
    if (staff.rows.length > 0) {
      const first = staff.rows[0]!;
      expect(first).toHaveProperty('membershipId');
      expect(first).toHaveProperty('serviceCount');
      expect(first).toHaveProperty('salesCents');
      expect(first).toHaveProperty('tipsCents');
      expect(first).toHaveProperty('commissionCents');
    }
  });
});
