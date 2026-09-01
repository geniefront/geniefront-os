/**
 * 运营台启用营销发件地址（sql/0089 + `platform.setMarketingEmail`）。
 *
 * 这一组盯住的是同一条线：**`locations.marketing_email_from` 的语义是
 * 「已就绪」**。写早了的后果不是报错，是营销邮件从一个不可用的域发出去、
 * 整批退信 —— 而退信率同样计入发信域名信誉，当时没有任何人会察觉。
 *
 * 2026-09-02 起营销域是**所有门店共用的一个固定域**（`mkt.geniefront.com`），
 * 门店身份体现在本地部分上（`spasite1@mkt.geniefront.com`）。因此这里核验的
 * 是「营销通道整体是否可用」，而不再是「这家店的子域验过没有」。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closeDb, withTenant, PLATFORM_OPS_USER_ID } from '@gf/db';
import {
  __setSendingDomainClientForTests, marketingDomain, type SendingDomain,
} from './email/marketingDomain';
import { requirePlatformOperator } from './platform/auth';
import { setMarketingEmailForLocation } from './platform/commands';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let slug = '';
let operator: Awaited<ReturnType<typeof requirePlatformOperator>>;

/** 装一个只会回答营销域状态的供应商替身，并记下被问了几次。 */
let statusCalls = 0;
function stubProvider(status: string): void {
  statusCalls = 0;
  __setSendingDomainClientForTests({
    status: async (name: string): Promise<SendingDomain> => {
      statusCalls += 1;
      return { name, status };
    },
  });
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
  __setSendingDomainClientForTests(null);
  await withTenant(tenant, (tx) => tx`
    update locations set marketing_email_from = null where id = ${NAIL_LOC}`);
  await closeDb();
});

beforeEach(async () => {
  await withTenant(tenant, (tx) => tx`
    update locations set marketing_email_from = null where id = ${NAIL_LOC}`);
});

/** slug 去掉随机后缀、只留字母数字，就是发件地址的本地部分。 */
const label = (): string => slug.replace(/-[0-9a-f]{6,}$/i, '').replace(/[^a-z0-9]/g, '');

describe('运营台启用营销发件地址', () => {
  it('🔴 营销域没验证通过时，一个字都不写库', async () => {
    stubProvider('pending');

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });

    expect(res.marketingEmailFrom).toBeNull();
    expect(res.domainStatus).toBe('pending');
    expect(await currentFrom()).toBeNull();
  });

  /**
   * ⚠️ 域名在供应商账号里根本不存在，和「存在但没验过」是两回事：前者通常是
   * `EMAIL_PROVIDER` 或密钥指错了账号，后者才是 DNS 问题。说明文案必须能把
   * 这两条分开，否则排查方向会跑偏。
   */
  it('域名不存在时给出的是「指错账号」那一类排查方向，且不写库', async () => {
    stubProvider('not_found');

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });

    expect(res.marketingEmailFrom).toBeNull();
    expect(res.dnsInstructions).toContain('EMAIL_PROVIDER');
    expect(res.dnsInstructions).toContain('MARKETING_EMAIL_DOMAIN');
    expect(await currentFrom()).toBeNull();
  });

  it('验证通过才写库，写的是「按 slug 推算的本地部分 @ 共用营销域」', async () => {
    stubProvider('verified');

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });

    const expected = `${label()}@${marketingDomain()}`;
    expect(res.marketingEmailFrom).toBe(expected);
    expect(await currentFrom()).toBe(expected);
  });

  /**
   * ⭐ 两家同名门店会算出同一个本地部分，而同一个域下的本地部分必须唯一。
   * 那时第二家叫什么由运营显式指定 —— 系统不自动加数字后缀，
   * `lotusspa2@…` 看起来就像仿冒。
   */
  it('可以显式指定本地部分', async () => {
    stubProvider('verified');

    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug,
      { locationId: NAIL_LOC, action: 'check', label: 'secondshop' });

    expect(res.marketingEmailFrom).toBe(`secondshop@${marketingDomain()}`);
  });

  /**
   * ⚠️ 每次启用都要重新核验一遍，不能因为「上一家刚验过」就跳过 ——
   * 域名可能在两次之间被供应商停用（欠费、投诉率超标），而停用不会有任何通知。
   */
  it('⭐ 每次启用都重新核验一次，不吃缓存', async () => {
    stubProvider('verified');

    await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });
    await withTenant(tenant, (tx) => tx`
      update locations set marketing_email_from = null where id = ${NAIL_LOC}`);
    await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });

    expect(statusCalls).toBe(2);
  });

  it('停用会清空该列，且不问供应商任何事', async () => {
    stubProvider('verified');

    await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' });
    expect(await currentFrom()).toBe(`${label()}@${marketingDomain()}`);

    const before = statusCalls;
    const res = await setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'disable' });

    expect(res.marketingEmailFrom).toBeNull();
    expect(await currentFrom()).toBeNull();
    // 停用是纯本地操作：不该再问供应商任何事
    expect(statusCalls).toBe(before);
  });

  /**
   * ⚠️ `support` 是给客服看数据的那一档。这一条会改变一家店往外发商业邮件
   * 的能力，只有 `super_admin` 能按。
   */
  it('🔴 support 档的运营按不动这个按钮', async () => {
    stubProvider('verified');
    const support = { ...operator, role: 'support' as const };

    await expect(setMarketingEmailForLocation(
      support, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' },
    )).rejects.toMatchObject({ details: { reason: 'requires_super_admin' } });

    expect(await currentFrom()).toBeNull();
  });

  /**
   * 🔴 测试进程里禁止直连任何邮件供应商 —— 忘了装替身要当场炸，
   * 而不是往真实账号打请求。
   */
  it('🔴 没装替身时不会真的打到供应商', async () => {
    __setSendingDomainClientForTests(null);
    await expect(setMarketingEmailForLocation(
      operator, NAIL_ORG, slug, { locationId: NAIL_LOC, action: 'check' },
    )).rejects.toThrow(/禁止直连邮件供应商/);
  });
});
