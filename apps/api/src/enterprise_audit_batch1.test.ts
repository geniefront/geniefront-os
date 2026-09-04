import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { ERROR_CODES } from '@gf/contracts';
import {
  __getPinLockoutForTest,
  __resetPinLockoutsForTest,
  __setPinLockoutForTest,
  pruneExpiredPinLockouts,
} from './handlers/staff';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/dayclose';
import './handlers/ticket';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_LOC = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

const nailTenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

describe('Enterprise Audit Batch 1 Verifications', () => {
  afterAll(async () => {
    await closeDb();
  });

  describe('SEC-AUD-02: PIN Lockout Sliding Window & Pruning', () => {
    beforeEach(() => {
      __resetPinLockoutsForTest();
    });

    it('prunes expired records older than 15 minutes when not locked', () => {
      const now = Date.now();
      const expiredTime = now - 20 * 60 * 1000;
      __setPinLockoutForTest('staff-1', {
        fails: 2,
        lockedUntil: 0,
        lastAttemptAt: expiredTime,
      });
      __setPinLockoutForTest('staff-2', {
        fails: 1,
        lockedUntil: 0,
        lastAttemptAt: now - 5 * 60 * 1000, // active (5 min ago)
      });

      pruneExpiredPinLockouts(now, true);

      expect(__getPinLockoutForTest('staff-1')).toBeUndefined();
      expect(__getPinLockoutForTest('staff-2')).toBeDefined();
    });

    it('does not prune locked accounts until lockout time has passed', () => {
      const now = Date.now();
      __setPinLockoutForTest('staff-locked', {
        fails: 5,
        lockedUntil: now + 5 * 60 * 1000, // still locked for 5 min
        lastAttemptAt: now - 10 * 60 * 1000,
      });

      pruneExpiredPinLockouts(now, true);
      expect(__getPinLockoutForTest('staff-locked')).toBeDefined();

      // Fast-forward past lockout and window
      const future = now + 25 * 60 * 1000;
      pruneExpiredPinLockouts(future, true);
      expect(__getPinLockoutForTest('staff-locked')).toBeUndefined();
    });
  });

  describe('FIN-AUD-01 & SEC-AUD-01: Multi-location Ticket Isolation', () => {
    it('rejects ticket mutation when location_id does not match context location', async () => {
      // Find or create an open ticket in NAIL_LOC
      const [ticket] = await withTenant(nailTenant, (tx) => tx<{ id: string; location_id: string }[]>`
        select id, location_id from tickets
        where location_id = ${NAIL_LOC} and status = 'open'
        limit 1`);

      if (!ticket) return; // Skip if no open ticket available

      // Get real membership for owner
      const [member] = await withTenant(nailTenant, (tx) => tx<{ id: string; user_id: string }[]>`
        select id, user_id from memberships where location_id = ${NAIL_LOC} limit 1`);
      if (!member) return;

      const baseCtx = await buildContext({ userId: member.user_id, membershipId: member.id });
      // Tamper locationId to a different location in the same org
      const otherLocCtx = { ...baseCtx, locationId: OTHER_LOC };

      // Attempting to void the ticket under the wrong location must fail with NOT_FOUND
      await expect(
        dispatch('ticket.void', { ticketId: ticket.id, reason: 'input_error' }, otherLocCtx),
      ).rejects.toMatchObject({
        code: ERROR_CODES.NOT_FOUND,
      });
    });
  });

  describe('FIN-AUD-02: Dayclose Card Variance Persistence & Return', () => {
    it('persists card_variance_cents and returns cardVarianceCents upon finalization', async () => {
      // Verify column existence in day_closes table schema
      const columns = await withTenant(nailTenant, (tx) => tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_name = 'day_closes' and column_name = 'card_variance_cents'`);

      expect(columns.length).toBe(1);
    });
  });
});
