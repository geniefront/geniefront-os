import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';

const NAMESPACE = 'gf-copilot-proposal:v1';
const TTL_MS = 10 * 60_000;

export interface CopilotProposalPayload {
  v: 1;
  proposalId: string;
  orgId: string;
  locationId: string;
  membershipId: string | null;
  command: string;
  input: Record<string, unknown>;
  summary: string;
  issuedAt: string;
  expiresAt: string;
}

function secret(): string {
  const value = process.env['APP_JWT_SECRET'] ?? '';
  if (value.length < 32) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'copilot_proposal_signing' },
    });
  }
  return value;
}

function mac(body: string): Buffer {
  return createHmac('sha256', `${NAMESPACE}:${secret()}`).update(body).digest();
}

export function issueCopilotProposal(
  ctx: Pick<CommandContext, 'orgId' | 'locationId' | 'membershipId'>,
  command: string,
  input: Record<string, unknown>,
  summary: string,
  now = new Date(),
  ttlMs = TTL_MS,
): { token: string; payload: CopilotProposalPayload } {
  const payload: CopilotProposalPayload = {
    v: 1,
    proposalId: randomUUID(),
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    membershipId: ctx.membershipId,
    command,
    input,
    summary,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `cp1.${body}.${mac(body).toString('base64url')}`, payload };
}

export function verifyCopilotProposal(
  token: string,
  ctx: Pick<CommandContext, 'orgId' | 'locationId' | 'membershipId'>,
  now = new Date(),
): CopilotProposalPayload {
  const [prefix, body, signature, extra] = token.split('.');
  if (prefix !== 'cp1' || !body || !signature || extra) return invalid('malformed');

  const got = Buffer.from(signature, 'base64url');
  const expected = mac(body);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return invalid('signature');

  let payload: CopilotProposalPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CopilotProposalPayload;
  } catch {
    return invalid('payload');
  }

  if (payload.v !== 1 || !payload.proposalId || !payload.command || !payload.input
      || payload.orgId !== ctx.orgId || payload.locationId !== ctx.locationId
      || payload.membershipId !== ctx.membershipId) {
    return invalid('binding');
  }
  if (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= now.getTime()) {
    return invalid('expired');
  }
  return payload;
}

function invalid(reason: string): never {
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
    details: { reason: `copilot_proposal_${reason}` },
  });
}
