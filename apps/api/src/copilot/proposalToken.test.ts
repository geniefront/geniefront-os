import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueCopilotProposal, verifyCopilotProposal } from './proposalToken';

const ctx = { orgId: 'org-a', locationId: 'loc-a', membershipId: 'member-a' };
let previous: string | undefined;

beforeEach(() => {
  previous = process.env['APP_JWT_SECRET'];
  process.env['APP_JWT_SECRET'] = 'copilot-proposal-test-secret-at-least-32-chars';
});

afterEach(() => {
  if (previous === undefined) delete process.env['APP_JWT_SECRET'];
  else process.env['APP_JWT_SECRET'] = previous;
});

describe('copilot proposal token', () => {
  it('binds the immutable command input to the actor and location', () => {
    const issued = issueCopilotProposal(ctx, 'appointment.cancel', {
      appointmentId: '00000000-0000-4000-8000-000000000001',
      reason: 'customer_request', keepStaffTurn: false,
    }, '取消预约', new Date('2026-09-04T12:00:00Z'));

    expect(verifyCopilotProposal(issued.token, ctx, new Date('2026-09-04T12:01:00Z')))
      .toMatchObject({ command: 'appointment.cancel', input: { keepStaffTurn: false } });
    expect(() => verifyCopilotProposal(issued.token, { ...ctx, locationId: 'loc-b' }))
      .toThrow();
  });

  it('rejects tampering and expired proposals', () => {
    const issued = issueCopilotProposal(ctx, 'resource.setStatus', {
      resourceId: '00000000-0000-4000-8000-000000000001', status: 'maintenance',
    }, '维护房间', new Date('2026-09-04T12:00:00Z'));
    const parts = issued.token.split('.');
    const tamperedBody = `${parts[1]!.slice(0, -1)}${parts[1]!.endsWith('A') ? 'B' : 'A'}`;
    const tampered = `${parts[0]}.${tamperedBody}.${parts[2]}`;
    expect(() => verifyCopilotProposal(tampered, ctx)).toThrow();
    expect(() => verifyCopilotProposal(issued.token, ctx, new Date('2026-09-04T12:11:00Z')))
      .toThrow();
  });
});
