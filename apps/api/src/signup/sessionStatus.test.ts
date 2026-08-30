/**
 * Marketing success page must verify a Checkout Session server-side.
 * Visiting /signup/success by hand must not claim payment.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@gf/db';
import { buildServer } from '../server';
import { __resetRateLimit } from '../public/rateLimit';
import type { Stripe } from '../stripe/client';
import {
  __setSignupSessionRetrieverForTests,
  classifySignupSession,
  lookupSignupSession,
} from './sessionStatus';

let app: ReturnType<typeof buildServer>;

const SESSION_ID = 'cs_test_gfsuccesslookupabc123';

function session(over: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: SESSION_ID,
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'unpaid',
    subscription: 'sub_test_signup',
    metadata: {
      gf_signup: '1',
      gf_plan: 'essential',
      gf_shop_name: 'Lotus Nails',
      gf_owner_email: 'owner@example.test',
    },
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  __setSignupSessionRetrieverForTests(null);
  await app.close();
  await closeDb();
});

beforeEach(() => {
  __resetRateLimit();
  __setSignupSessionRetrieverForTests(async (id) => {
    if (id === SESSION_ID) return session();
    return null;
  });
});

afterEach(() => {
  __setSignupSessionRetrieverForTests(null);
});

describe('classifySignupSession', () => {
  it('complete GenieFront signup with subscription is confirmed', () => {
    expect(classifySignupSession(session())).toEqual({
      status: 'confirmed',
      plan: 'essential',
    });
  });

  it('open signup session is pending, not confirmed', () => {
    expect(classifySignupSession(session({
      status: 'open',
      subscription: null,
      payment_status: 'unpaid',
    }))).toEqual({ status: 'pending', plan: 'essential' });
  });

  it('complete without subscription is pending', () => {
    expect(classifySignupSession(session({ subscription: null }))).toEqual({
      status: 'pending',
      plan: 'essential',
    });
  });

  it('missing, expired, non-signup, or non-subscription is invalid', () => {
    expect(classifySignupSession(null).status).toBe('invalid');
    expect(classifySignupSession(session({ status: 'expired' })).status).toBe('invalid');
    expect(classifySignupSession(session({
      metadata: { gf_plan: 'essential' },
    })).status).toBe('invalid');
    expect(classifySignupSession(session({
      metadata: { gf_signup: '1', gf_location_id: 'already-a-tenant' },
    })).status).toBe('invalid');
    expect(classifySignupSession(session({ mode: 'setup' })).status).toBe('invalid');
  });
});

describe('GET /v1/public/signup-session', () => {
  function get(sessionId: string | undefined, ip = '203.0.113.80') {
    const url = sessionId === undefined
      ? '/v1/public/signup-session'
      : `/v1/public/signup-session?session_id=${encodeURIComponent(sessionId)}`;
    return app.inject({
      method: 'GET',
      url,
      headers: { 'x-forwarded-for': ip },
    });
  }

  it('confirmed signup returns coarse status only', async () => {
    const r = await get(SESSION_ID);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'confirmed', plan: 'essential' });
    const body = JSON.stringify(r.json());
    expect(body).not.toContain('sk_');
    expect(body).not.toContain('whsec_');
    expect(body).not.toContain('owner@example.test');
    expect(body).not.toContain('sub_test_signup');
  });

  it('malformed or missing session_id is invalid, not confirmed', async () => {
    expect((await get(undefined)).json()).toEqual({ status: 'invalid' });
    expect((await get('not-a-session')).json()).toEqual({ status: 'invalid' });
    expect((await get('cs_test_short')).json()).toEqual({ status: 'invalid' });
    expect((await get('cs_live_' + 'x'.repeat(24))).json()).toEqual({ status: 'invalid' });
  });

  it('unknown Checkout Session is invalid', async () => {
    const r = await get('cs_test_unknownsessionid999');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'invalid' });
  });

  it('Stripe retrieve failure is unavailable, not a fake confirmation', async () => {
    __setSignupSessionRetrieverForTests(async () => {
      throw new Error('stripe_down');
    });
    const r = await get(SESSION_ID);
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('UPSTREAM_UNAVAILABLE');
    expect(r.json()).not.toMatchObject({ status: 'confirmed' });
  });

  it('does not treat an arbitrary completed Checkout as a signup', async () => {
    __setSignupSessionRetrieverForTests(async () => session({
      metadata: { gf_location_id: 'loc_existing' },
    }));
    const r = await get(SESSION_ID);
    expect(r.json()).toEqual({ status: 'invalid' });
  });
});

describe('lookupSignupSession rate limit', () => {
  it('caps lookups per IP', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 30; i += 1) {
      await lookupSignupSession(SESSION_ID, { ip });
    }
    await expect(lookupSignupSession(SESSION_ID, { ip })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
