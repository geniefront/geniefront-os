import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@gf/contracts';
import { verifyCopilotProposal } from './proposalToken';
import { finalizeCopilotProposal } from './routes';

const ids = {
  org: '00000000-0000-4000-8000-000000000001',
  location: '00000000-0000-4000-8000-000000000002',
  member: '00000000-0000-4000-8000-000000000003',
  service: '00000000-0000-4000-8000-000000000004',
};

const ctx: CommandContext = {
  orgId: ids.org,
  locationId: ids.location,
  membershipId: ids.member,
  userId: '00000000-0000-4000-8000-000000000005',
  permissions: new Set(['appointment.write']),
  actorKind: 'user',
  locale: 'en',
  timezone: 'America/New_York',
};

const log = { warn: vi.fn() };
let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env['APP_JWT_SECRET'];
  process.env['APP_JWT_SECRET'] = 'copilot-route-test-secret-at-least-32-characters';
  log.warn.mockClear();
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env['APP_JWT_SECRET'];
  else process.env['APP_JWT_SECRET'] = previousSecret;
});

describe('finalizeCopilotProposal', () => {
  it('schema-validates, canonicalizes, signs and marks AI-created appointments', () => {
    const proposal = finalizeCopilotProposal({
      command: 'appointment.create',
      input: {
        customerId: null,
        walkInName: 'Test Guest',
        items: [{
          serviceId: ids.service,
          startsAt: '2026-09-05T10:00:00-04:00',
        }],
      },
      summary: 'Create test appointment',
    }, ctx, log);

    expect(proposal).toMatchObject({
      command: 'appointment.create',
      confirm: 'always',
      input: { source: 'ai_copilot' },
    });
    expect(verifyCopilotProposal(proposal!.proposalToken, ctx)).toMatchObject({
      input: { source: 'ai_copilot' },
    });
  });

  it('drops malformed and unauthorized model proposals before signing', () => {
    expect(finalizeCopilotProposal({
      command: 'appointment.create', input: {}, summary: 'bad',
    }, ctx, log)).toBeNull();
    expect(finalizeCopilotProposal({
      command: 'ticket.pay', input: {}, summary: 'forbidden',
    }, ctx, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
