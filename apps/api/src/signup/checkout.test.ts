/**
 * Public marketing Checkout: browser may name a plan, never a Stripe Price.
 *
 * No live Stripe charges. Session create is swapped for a recorder.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { TRIAL_DAYS } from '@gf/payroll';
import { buildServer } from '../server';
import { __resetRateLimit } from '../public/rateLimit';
import { isSignupSession } from './webhook';
import {
  __setSignupCheckoutCreatorForTests,
  createSignupCheckout,
} from './checkout';
import type { Stripe } from '../stripe/client';

/** 种子里的美甲店。7b 那条用例要往 signup_intents 里放一行，得挂在真实门店上 */
const SEED_ORG = '11111111-1111-4111-8111-111111111111';
const SEED_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const ESSENTIAL_PRICE = 'price_test_essential_99';
const GROWTH_PRICE = 'price_test_growth_199';
const VOICE_BOOKING_PRICE = 'price_test_voice_booking_99';
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_test_signup';

let app: ReturnType<typeof buildServer>;
let created: Stripe.Checkout.SessionCreateParams[] = [];
let stripeShouldFail = false;
let stripeUrl: string | null = STRIPE_URL;

const originalEssential = process.env['STRIPE_PRICE_ESSENTIAL'];
const originalGrowth = process.env['STRIPE_PRICE_GROWTH'];
const originalVoiceBooking = process.env['STRIPE_PRICE_VOICE_BOOKING'];
const originalMarketing = process.env['MARKETING_BASE_URL'];
const originalAppBase = process.env['APP_BASE_URL'];

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  __setSignupCheckoutCreatorForTests(null);
  if (originalEssential === undefined) delete process.env['STRIPE_PRICE_ESSENTIAL'];
  else process.env['STRIPE_PRICE_ESSENTIAL'] = originalEssential;
  if (originalGrowth === undefined) delete process.env['STRIPE_PRICE_GROWTH'];
  else process.env['STRIPE_PRICE_GROWTH'] = originalGrowth;
  if (originalVoiceBooking === undefined) delete process.env['STRIPE_PRICE_VOICE_BOOKING'];
  else process.env['STRIPE_PRICE_VOICE_BOOKING'] = originalVoiceBooking;
  if (originalMarketing === undefined) delete process.env['MARKETING_BASE_URL'];
  else process.env['MARKETING_BASE_URL'] = originalMarketing;
  if (originalAppBase === undefined) delete process.env['APP_BASE_URL'];
  else process.env['APP_BASE_URL'] = originalAppBase;
  await app.close();
  await closeDb();
});

beforeEach(() => {
  created = [];
  stripeShouldFail = false;
  stripeUrl = STRIPE_URL;
  process.env['STRIPE_PRICE_ESSENTIAL'] = ESSENTIAL_PRICE;
  process.env['STRIPE_PRICE_GROWTH'] = GROWTH_PRICE;
  process.env['STRIPE_PRICE_VOICE_BOOKING'] = VOICE_BOOKING_PRICE;
  process.env['MARKETING_BASE_URL'] = 'https://www.geniefront.com';
  process.env['APP_BASE_URL'] = 'https://desk.geniefront.com';
  __resetRateLimit();
  __setSignupCheckoutCreatorForTests(async (params) => {
    created.push(params);
    if (stripeShouldFail) throw new Error('stripe_down');
    return { id: 'cs_test_signup', url: stripeUrl };
  });
});

afterEach(() => {
  __setSignupCheckoutCreatorForTests(null);
});

const valid = {
  shopName: 'Lotus Nails',
  ownerEmail: 'owner@maildrop.cc',
  plan: 'essential' as const,
};

function post(body: Record<string, unknown>, ip = '203.0.113.70') {
  return app.inject({
    method: 'POST',
    url: '/v1/public/signup-checkout',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: body,
  });
}

describe('POST /v1/public/signup-checkout', () => {
  it('1. essential maps to server-side Essential Stripe Price ID', async () => {
    const r = await post(valid);
    expect(r.statusCode).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0]?.line_items).toEqual([{ price: ESSENTIAL_PRICE, quantity: 1 }]);
  });

  it('2. growth maps to server-side Growth Stripe Price ID', async () => {
    const r = await post({ ...valid, plan: 'growth' });
    expect(r.statusCode).toBe(200);
    expect(created[0]?.line_items).toEqual([{ price: GROWTH_PRICE, quantity: 1 }]);
  });

  it('2b. voice_booking maps to server-side Voice Booking Stripe Price ID', async () => {
    const r = await post({ ...valid, plan: 'voice_booking' });
    expect(r.statusCode).toBe(200);
    expect(created[0]?.line_items).toEqual([{ price: VOICE_BOOKING_PRICE, quantity: 1 }]);
    expect(created[0]?.metadata?.['gf_plan']).toBe('voice_booking');
  });

  it('3. starter rejected', async () => {
    const r = await post({ ...valid, plan: 'starter' });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION_FAILED');
    expect(created).toHaveLength(0);
  });

  it('4. enterprise rejected', async () => {
    const r = await post({ ...valid, plan: 'enterprise' });
    expect(r.statusCode).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('5. arbitrary plan rejected', async () => {
    const r = await post({ ...valid, plan: 'platinum' });
    expect(r.statusCode).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('6. arbitrary Stripe price ID cannot be supplied', async () => {
    const r = await post({
      ...valid,
      plan: 'essential',
      priceId: 'price_attacker',
      price: 'price_attacker',
      stripePriceId: GROWTH_PRICE,
    });
    expect(r.statusCode).toBe(400);
    expect(created).toHaveLength(0);

    const ok = await createSignupCheckout(valid, { ip: '198.51.100.10' });
    expect(ok.url).toBe(STRIPE_URL);
    expect(JSON.stringify(created[0])).not.toContain('price_attacker');
    expect(created[0]?.line_items?.[0]).toEqual({ price: ESSENTIAL_PRICE, quantity: 1 });
  });

  it('7. required gf_* signup metadata is generated by server', async () => {
    const r = await post(valid);
    expect(r.statusCode).toBe(200);
    const meta = created[0]?.metadata ?? {};
    expect(meta['gf_signup']).toBe('1');
    expect(meta['gf_shop_name']).toBe('Lotus Nails');
    expect(meta['gf_owner_email']).toBe('owner@maildrop.cc');
    expect(meta['gf_plan']).toBe('essential');
    expect(meta['gf_location_id']).toBeUndefined();
    expect(meta['gf_org_id']).toBeUndefined();
    expect(created[0]?.subscription_data?.metadata?.['gf_signup']).toBe('1');
  });

  /**
   * ⭐ 七天试用**只给第一次**（sql/0085 的 `gf_signup_email_seen`）。
   *
   * 原来这条公开通道无条件给 `trial_period_days`，而「只给第一次」的判据
   * 只存在于站内那条路。于是同一个人退订之后再开一次又是七天，无限循环。
   *
   * ⚠️ 邮箱必须是**这次跑独有的**：判据落在 `signup_intents` 上，
   * 而那张表里的历史行（种子、别的用例开过的户）会让一个固定邮箱
   * 时而算首次、时而算老客 —— 那种用例会在别人改了别的文件之后莫名其妙地红。
   */
  it('7b. 首次开户给七天试用，同一个邮箱再来一次就不给', async () => {
    const fresh = `trial-${crypto.randomUUID()}@maildrop.cc`;
    const r = await post({ ...valid, ownerEmail: fresh });
    expect(r.statusCode).toBe(200);
    expect(created[0]?.subscription_data?.trial_period_days).toBe(TRIAL_DAYS);

    // 这个邮箱真的开过户之后（signup_intents 里有行），第二次不再给试用
    await withTenant(
      { orgId: SEED_ORG, locationId: SEED_LOC, membershipId: null },
      (tx) => tx`
        insert into signup_intents
          (checkout_session_id, org_id, location_id, owner_email, plan)
        values (${`cs_trial_${crypto.randomUUID()}`}, ${SEED_ORG}, ${SEED_LOC},
                ${fresh}, 'essential')`);

    created = [];
    const again = await post({ ...valid, ownerEmail: fresh });
    expect(again.statusCode).toBe(200);
    expect(created[0]?.subscription_data?.trial_period_days).toBeUndefined();
    // metadata 照旧完整 —— 少给试用不等于少给别的
    expect(created[0]?.subscription_data?.metadata?.['gf_signup']).toBe('1');

    /*
     * ⚠️ 这一行**不清理**：`signup_intents` 对 app_user 是禁止 delete 的
     * （sql/0030：付款留档只追加）。上面那个邮箱带了本次跑独有的 uuid，
     * 留在库里对任何其他用例都不可见；而每次跑测试都会重新种子，
     * 它也不会一直累积。
     */
  });

  it('8. customer_email equals canonical owner email', async () => {
    const r = await post({
      ...valid,
      ownerEmail: 'John.Doe+shop@gmail.com',
    });
    expect(r.statusCode).toBe(200);
    expect(created[0]?.customer_email).toBe('johndoe@gmail.com');
    expect(created[0]?.metadata?.['gf_owner_email']).toBe('johndoe@gmail.com');
    expect(created[0]?.customer_email).toBe(created[0]?.metadata?.['gf_owner_email']);
  });

  it('9. missing/invalid shop name rejected', async () => {
    expect((await post({ ...valid, shopName: '' })).statusCode).toBe(400);
    expect((await post({ ...valid, shopName: '   ' })).statusCode).toBe(400);
    expect((await post({ ownerEmail: valid.ownerEmail, plan: 'essential' })).statusCode).toBe(400);
    expect((await post({ ...valid, shopName: 'x'.repeat(81) })).statusCode).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('10. invalid email rejected', async () => {
    for (const ownerEmail of ['', 'not-an-email', 'a@b', 'owner@', '@x.com']) {
      expect((await post({ ...valid, ownerEmail })).statusCode).toBe(400);
    }
    expect(created).toHaveLength(0);
  });

  it('11. arbitrary metadata cannot be injected', async () => {
    const r = await post({
      ...valid,
      metadata: { gf_signup: '0', gf_plan: 'growth', gf_org_id: 'x' },
      gf_plan: 'growth',
      gf_location_id: 'loc_attacker',
    });
    expect(r.statusCode).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('12. arbitrary return URL cannot be injected', async () => {
    const r = await post({
      ...valid,
      successUrl: 'https://evil.example/phish',
      cancelUrl: 'https://evil.example/nope',
      success_url: 'https://evil.example/phish',
      cancel_url: 'https://evil.example/nope',
    });
    expect(r.statusCode).toBe(400);

    await createSignupCheckout(valid, { ip: '198.51.100.11' });
    expect(created[0]?.success_url).toBe(
      'https://www.geniefront.com/signup/success?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(created[0]?.cancel_url).toBe('https://www.geniefront.com/signup/cancel');
    expect(created[0]?.success_url).not.toContain('evil.example');
    expect(created[0]?.cancel_url).not.toContain('desk.geniefront.com');
    expect(created[0]?.success_url).not.toContain('geniefront.app');
  });

  it('13. Stripe failure does not produce fake success', async () => {
    stripeShouldFail = true;
    const r = await post(valid);
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('UPSTREAM_UNAVAILABLE');
    expect(r.json()).not.toMatchObject({ url: expect.any(String) });

    stripeShouldFail = false;
    stripeUrl = null;
    const missing = await post({ ...valid, shopName: 'No URL Shop' });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).not.toHaveProperty('url');
  });

  it('14. existing signed webhook/provisioning behavior remains unchanged', async () => {
    expect((await post({ ...valid, shopName: 'Webhook Contract' })).statusCode).toBe(200);
    const fake = {
      id: 'cs_test_marketing',
      mode: 'subscription',
      customer_email: created[0]?.customer_email,
      metadata: created[0]?.metadata,
    } as unknown as Stripe.Checkout.Session;
    expect(isSignupSession(fake)).toBe(true);

    const billed = {
      ...fake,
      metadata: { ...(created[0]?.metadata ?? {}), gf_location_id: 'already-a-tenant' },
    } as unknown as Stripe.Checkout.Session;
    expect(isSignupSession(billed)).toBe(false);

    const ghost = await app.inject({ method: 'POST', url: '/v1/public/signup-webhook' });
    expect(ghost.statusCode).toBe(404);

    const body = JSON.stringify(created[0] ?? {});
    expect(body).not.toContain('sk_');
    expect(body).not.toContain('whsec_');
    const response = await post({ ...valid, shopName: 'No Secrets' });
    const json = JSON.stringify(response.json());
    expect(json).not.toContain('sk_test');
    expect(json).not.toContain('whsec_');
    expect(json).not.toContain(ESSENTIAL_PRICE);
    expect(Object.keys(response.json())).toEqual(['url']);
  });

  it('does not require a login token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/public/signup-checkout',
      headers: { 'content-type': 'application/json' },
      payload: valid,
    });
    expect(r.statusCode).toBe(200);
  });

  it('trims shop name before writing metadata', async () => {
    const r = await post({ ...valid, shopName: '  Lotus   Nails  ' });
    expect(r.statusCode).toBe(200);
    expect(created[0]?.metadata?.['gf_shop_name']).toBe('Lotus Nails');
  });
});
