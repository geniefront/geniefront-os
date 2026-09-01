/**
 * 运营台启用营销发件域名（sql/0089 + `platform.setMarketingEmail`）。
 *
 * 这一组盯住的是同一条线：**`locations.marketing_email_from` 的语义是
 * 「已就绪」**。写早了的后果不是报错，是营销邮件在 DNS 还没生效时发出去、
 * 整批退信 —— 而退信率同样计入发信域名信誉，当时没有任何人会察觉。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closeDb, withTenant, PLATFORM_OPS_USER_ID } from '@gf/db';
import {
  __setResendClientForTests, type ResendDomain,
} from './email/marketingDomain';
import { requirePlatformOperator } from './platform/auth';
import { setMarketingEmailForLocation } from './platform/commands';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let slug = '';
let operator: Awaited<ReturnType<typeof requirePlatformOperator>>;

/** 装一个只认得出一个域名的 Resend 替身。 */
function stubResend(domains: ResendDomain[]): void {
  __setResendClientForTests({
    create: async (name) => ({ id: 'dom_stub', name, status: 'not_started', records: [] }),
    verify: async (id) => ({ id }),
    get: async (id) => domains.find((d) => d.id === id)!,
    list: async () => ({ data: domains }),
  });
}

function domain(name: string, status: string): ResendDomain {
  return {
    id: 'dom_stub',
    name,
    status,
    records: [
      { record: 'DKIM', name: `resend._domainkey.${name.split('.')[0]}`, type: 'TXT', value: 'p=STUB' },
    ],
  };
}

async function currentFrom(): Promise<string | null> {
  const [row] = await withTenant(tenant, (tx) => tx<{ f: string | null }[]>`
    select marketing_email_from as f from locations where id = ${NAIL_LOC}`);
  return row?.f ?? null;
}

beforeAll(async () => {
  const [loc] = await withTenant(tenant, (tx) => tx<{ slug: string }[]>`
    select slug from locations where id = ${NAIL_LOC}`);
  slug = loc!.slug;
  operator = await requirePlatformOperator(PLATFORM_OPS_USER_ID);
});

afterAll(async () => {
  __setResendClientForTests(null);
  await withTenant(tenant, (tx) => tx`
    update locations set marketing_email_from = null where id = ${NAIL_LOC}`);
  await closeDb();
});

beforeEach(async () => {
  await withTenant(tenant, (tx) => tx`
    update locations set marketing_email_from = null where id = ${NAIL_LOC}`);
});

/** slug 去掉随机后缀、只留字母数字，就是子域标签。 */
const label = (): string => slug.replace(/-[0-9a-f]{6,}$/i, '').replace(/[^a-z0-9]/g, '');

describe('运营台启用营销发件域名', () => {
  it('🔴 Resend 里还没验证通过时，一个字都不写库', async () => {
    stubResend([domain(`${label()}.geniefront.com`, 'pending')]);

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });

    expect(res.marketingEmailFrom).toBeNull();
    expect(res.domainStatus).toBe('pending');
    // 没通过时把要加的 DNS 记录原样带回去，运营照着填
    expect(res.dnsInstructions).toContain('resend._domainkey');
    expect(await currentFrom()).toBeNull();
  });

  it('🔴 Resend 里根本没有这个域名时报明确原因，不写库', async () => {
    stubResend([domain('someone-else.geniefront.com', 'verified')]);

    await expect(setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' },
    )).rejects.toMatchObject({ details: { reason: 'domain_not_in_resend' } });

    expect(await currentFrom()).toBeNull();
  });

  it('验证通过才写库，写的是按 slug 推算的地址', async () => {
    const name = `${label()}.geniefront.com`;
    stubResend([domain(name, 'verified')]);

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });

    expect(res.marketingEmailFrom).toBe(`promo@${name}`);
    expect(await currentFrom()).toBe(`promo@${name}`);
  });

  /**
   * ⭐ 两家同名门店会算出同一个标签，而域名必须唯一。
   * 那时第二家叫什么由运营显式指定 —— 系统不自动加数字后缀，
   * `lotusspa2@…` 看起来就像仿冒。
   */
  it('可以显式指定子域标签', async () => {
    stubResend([domain('secondshop.geniefront.com', 'verified')]);

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug,
      { locationId: NAIL_LOC, action: 'check', label: 'secondshop' });

    expect(res.marketingEmailFrom).toBe('promo@secondshop.geniefront.com');
  });

  it('停用会清空该列，且不碰 Resend 上的域名', async () => {
    const name = `${label()}.geniefront.com`;
    let listCalls = 0;
    __setResendClientForTests({
      create: async (n) => ({ id: 'dom_stub', name: n, status: 'not_started', records: [] }),
      verify: async (id) => ({ id }),
      get: async () => domain(name, 'verified'),
      list: async () => { listCalls += 1; return { data: [domain(name, 'verified')] }; },
    });

    await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });
    expect(await currentFrom()).toBe(`promo@${name}`);

    const before = listCalls;
    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'disable' });

    expect(res.marketingEmailFrom).toBeNull();
    expect(await currentFrom()).toBeNull();
    // 停用是纯本地操作：不该再问 Resend 任何事
    expect(listCalls).toBe(before);
  });

  /**
   * ⚠️ `support` 是给客服看数据的那一档。这一条会改变一家店往外发商业邮件
   * 的能力，只有 `super_admin` 能按。
   */
  it('🔴 support 档的运营按不动这个按钮', async () => {
    stubResend([domain(`${label()}.geniefront.com`, 'verified')]);
    const support = { ...operator, role: 'support' as const };

    await expect(setMarketingEmailForLocation(
      support, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' },
    )).rejects.toMatchObject({ details: { reason: 'requires_super_admin' } });

    expect(await currentFrom()).toBeNull();
  });

  /**
   * 🔴 测试进程里禁止直连 Resend —— 忘了装替身要当场炸，
   * 而不是在真实账号里建出一批对不上任何门店的域名。
   */
  it('🔴 没装替身时不会真的打到 Resend', async () => {
    __setResendClientForTests(null);
    await expect(setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' },
    )).rejects.toThrow(/禁止直连 Resend/);
  });
});
