/**
 * GET 只读、POST 才退订。预取确认页不得改订阅状态。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { buildServer } from '../server';
import { mintUnsubscribeToken } from './unsubscribe';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let app: ReturnType<typeof buildServer>;
let customerId = '';
let secretWasSet = false;

beforeAll(async () => {
  if (!process.env['APP_JWT_SECRET']) {
    process.env['APP_JWT_SECRET'] = 'unsubscribe-test-secret-at-least-32-chars';
    secretWasSet = true;
  }
  app = buildServer();
  await app.ready();
  await withTenant(tenant, async (tx) => {
    const [c] = await tx<{ id: string }[]>`
      insert into customers
        (org_id, primary_location_id, display_name, email, marketing_email_opt_in)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'Unsub Test', 'unsub-test@maildrop.cc', true)
      returning id`;
    customerId = c!.id;
  });
});

afterAll(async () => {
  await app.close();
  await withTenant(tenant, (tx) => tx`delete from customers where id = ${customerId}`);
  await closeDb();
  if (secretWasSet) delete process.env['APP_JWT_SECRET'];
});

async function optedIn(): Promise<boolean> {
  const [row] = await withTenant(tenant, (tx) => tx<{ on: boolean }[]>`
    select marketing_email_opt_in as on from customers where id = ${customerId}`);
  return row?.on === true;
}

describe('营销邮件退订路由', () => {
  it('GET 与 POST 一律返回 { ok: true }，无效令牌也不暴露区别', async () => {
    const get = await app.inject({ method: 'GET', url: '/public/v1/email/unsubscribe?t=nope' });
    const post = await app.inject({ method: 'POST', url: '/public/v1/email/unsubscribe?t=nope' });
    expect(get.statusCode).toBe(200);
    expect(post.statusCode).toBe(200);
    expect(get.json()).toEqual({ ok: true });
    expect(post.json()).toEqual({ ok: true });
  });

  it('GET 不执行退订，POST 才关掉营销邮件', async () => {
    const token = mintUnsubscribeToken({ customerId, orgId: NAIL_ORG });
    expect(token).toBeTruthy();
    const url = `/public/v1/email/unsubscribe?t=${encodeURIComponent(token!)}`;

    expect(await optedIn()).toBe(true);
    await app.inject({ method: 'GET', url });
    expect(await optedIn()).toBe(true);

    await app.inject({ method: 'POST', url });
    expect(await optedIn()).toBe(false);

    await app.inject({ method: 'POST', url });
    expect(await optedIn()).toBe(false);
  });
});
