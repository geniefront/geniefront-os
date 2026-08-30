/**
 * Narrow public lookup for marketing /signup/success.
 *
 * The success page is reachable by hand, so it must not claim payment
 * until Stripe says this Checkout Session is a completed GenieFront
 * signup. This endpoint retrieves one session by id, checks gf_signup
 * metadata, and returns a coarse status. It does not expose Stripe
 * objects, emails, Price IDs, or customer ids.
 */

import { z } from 'zod';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { isPlan, type Plan } from '@gf/payroll';
import { checkRateLimits } from '../public/rateLimit';
import { stripeClient, type Stripe } from '../stripe/client';
import { isSignupSession } from './webhook';

export const SignupSessionId = z
  .string()
  .trim()
  .regex(/^cs_(test|live)_[A-Za-z0-9]+$/)
  .min(20)
  .max(255);

export type PublicSignupStatus = 'confirmed' | 'pending' | 'invalid';

export interface SignupSessionLookup {
  status: PublicSignupStatus;
  plan?: Plan;
}

type SessionRetriever = (id: string) => Promise<Stripe.Checkout.Session | null>;

function isMissingSession(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number };
  return e.code === 'resource_missing' || e.statusCode === 404;
}

const defaultRetrieve: SessionRetriever = async (id) => {
  try {
    return await stripeClient().checkout.sessions.retrieve(id);
  } catch (e) {
    if (isMissingSession(e)) return null;
    throw e;
  }
};

let retrieveSignupSession: SessionRetriever = defaultRetrieve;

export function __setSignupSessionRetrieverForTests(fn: SessionRetriever | null): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__setSignupSessionRetrieverForTests 只能在测试环境用');
  }
  retrieveSignupSession = fn ?? defaultRetrieve;
}

function hasSubscription(session: Stripe.Checkout.Session): boolean {
  const sub = session.subscription;
  if (typeof sub === 'string') return sub.length > 0;
  return Boolean(sub && typeof sub === 'object' && 'id' in sub && sub.id);
}

function planOf(session: Stripe.Checkout.Session): Plan | undefined {
  const plan = session.metadata?.['gf_plan'];
  return isPlan(plan) ? plan : undefined;
}

/** Pure classification — used by tests without hitting Stripe. */
export function classifySignupSession(
  session: Stripe.Checkout.Session | null,
): SignupSessionLookup {
  if (!session) return { status: 'invalid' };
  if (session.mode !== 'subscription') return { status: 'invalid' };
  if (!isSignupSession(session)) return { status: 'invalid' };
  if (session.status === 'expired') return { status: 'invalid' };

  const plan = planOf(session);
  if (session.status === 'open') {
    return plan ? { status: 'pending', plan } : { status: 'pending' };
  }
  if (session.status === 'complete') {
    if (hasSubscription(session)) {
      return plan ? { status: 'confirmed', plan } : { status: 'confirmed' };
    }
    return plan ? { status: 'pending', plan } : { status: 'pending' };
  }
  return { status: 'invalid' };
}

export async function lookupSignupSession(
  sessionId: unknown,
  ctx: { ip: string; log?: { warn: (o: unknown, m: string) => void } },
): Promise<SignupSessionLookup> {
  const parsed = SignupSessionId.safeParse(sessionId);
  if (!parsed.success) return { status: 'invalid' };

  const verdict = await checkRateLimits([
    { scope: 'signup-status-ip', id: ctx.ip, limit: 30, windowSec: 3600 },
  ], ctx.log);
  if (!verdict.ok) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'too_many_attempts', retryAfterSec: verdict.retryAfterSec },
      messageKey: 'error.TOO_MANY_ATTEMPTS',
    });
  }

  let session: Stripe.Checkout.Session | null;
  try {
    session = await retrieveSignupSession(parsed.data);
  } catch (e) {
    ctx.log?.warn({ err: e }, 'signup session lookup: Stripe retrieve failed');
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'stripe', reason: 'session_lookup_failed' },
    });
  }

  return classifySignupSession(session);
}
