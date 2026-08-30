/**
 * 自助开户链路的验收（docs/12 §3 的 A / B 两组验收标准）。
 *
 * 这一份里**没有一次真的 Stripe 调用，也没有一封真的邮件发出去** ——
 * 验签那一段由 stripe/verify.test.ts 盯着，真事件由 `stripe listen` 兜底。
 * 这里验的是钱到了之后、老板进来之前那一段，而那恰恰是出错代价最大的：
 *
 *   · Stripe 重投会不会建出第二家店（老板会看到两个空店铺，只有一个能用）
 *   · 付款邮箱和 metadata 邮箱不一致时会不会照样开店（= 把店送给别人）
 *   · 别人能不能认领一家我付了钱的店
 *   · 认领两次会不会静默成功（第二个人会以为自己也是老板）
 *
 * ⚠️ 用固定的 checkout session id：跑一次测试建一家店的话，开发库里
 * 很快就是几十家没人认领的空店。固定之后**第二次跑走的是幂等那条路**，
 * 顺带把幂等本身又验了一遍。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb, provisionTenant, claimableIntentFor } from '@gf/db';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { provisionFromSession } from './signup/webhook';
import type { Stripe } from './stripe/client';
import './handlers/setup';

/** 固定的自测 session。真实的 session id 长这样：cs_test_a1B2… */
const SESSION = 'cs_test_gf_selftest_signup';
/** 认领用的账号：种子里的足疗店老板（auth.users 里邮箱已验证） */
const OWNER_EMAIL = 'owner@example.test';
const OWNER_USER = '196f0ab4-cd94-45cc-8109-2c414e966828';
/** 「另一个人」：拿他的 user id 去认领同一家店，必须什么都拿不到 */
const OTHER_USER = 'd84f499d-4100-4791-a0ae-dca645aa2661'; // mia@example.test

const log = (): { logger: FastifyBaseLogger; errors: unknown[] } => {
  const errors: unknown[] = [];
  const noop = (): void => {};
  const logger = {
    error: (o: unknown) => { errors.push(o); },
    info: noop, warn: noop, debug: noop, trace: noop, fatal: noop,
    child: () => logger,
  } as unknown as FastifyBaseLogger;
  return { logger, errors };
};

const session = (over: Record<string, unknown> = {}): Stripe.Checkout.Session => ({
  id: SESSION,
  mode: 'subscription',
  customer_email: OWNER_EMAIL,
  metadata: {
    gf_signup: '1',
    gf_plan: 'growth',
    gf_shop_name: 'Selftest Nails',
    gf_owner_email: OWNER_EMAIL,
    gf_business_type: 'nail',
    gf_timezone: 'America/Chicago',
    gf_locale: 'zh-Hans',
    gf_phone: '+15125550142',
  },
  ...over,
} as unknown as Stripe.Checkout.Session);

let tenant: { orgId: string; locationId: string };

/**
 * 把这家自测门店退回「刚建好、还没人认领」的状态。
 *
 * ⚠️ signup_intents 的 delete 是收回的（付款留档不删），所以这里只能
 * 把 claimed_at 清掉 —— 而这恰好也是客服真要「重发一次激活链接」时
 * 会做的事，顺带说明了那条路是通的。
 */
async function unclaim(): Promise<void> {
  const t = { ...tenant, membershipId: null };
  await withTenant(t, async (tx) => {
    await tx`delete from membership_roles where membership_id in (
               select id from memberships where location_id = ${tenant.locationId})`;
    await tx`delete from staff_profiles where location_id = ${tenant.locationId}`;
    await tx`delete from services where location_id = ${tenant.locationId}`;
    await tx`delete from memberships where location_id = ${tenant.locationId}`;
    await tx`delete from role_permissions where role_id in (
               select id from roles where location_id = ${tenant.locationId})`;
    await tx`delete from roles where location_id = ${tenant.locationId}`;
    await tx`update signup_intents set claimed_at = null, claimed_user_id = null
             where location_id = ${tenant.locationId}`;
    /**
     * 门店本身也要退回刚建好的样子 —— 不只是 status。
     *
     * 下面那几个用例会真的改时区和业态（那正是要验的东西），
     * 而这家店是**跨次复用**的：不还原的话，第二次跑测试看到的是
     * 上一次改完的状态，然后在一个和被测代码毫无关系的断言上失败。
     */
    await tx`update locations set
               status = 'setup', timezone = 'America/Chicago', business_type = 'nail',
               business_hours = '{}'::jsonb,
               settings = settings - 'profile_confirmed_at'
             where id = ${tenant.locationId}`;
    await tx`delete from command_idempotency where location_id = ${tenant.locationId}`;
    await tx`update organizations set owner_user_id = '00000000-0000-4000-8000-000000000000'
             where id = ${tenant.orgId}`;
  });
}

beforeAll(async () => {
  const out = await provisionTenant({
    checkoutSessionId: SESSION,
    shopName: 'Selftest Nails',
    ownerEmail: OWNER_EMAIL,
    businessType: 'nail',
    timezone: 'America/Chicago',
    locale: 'zh-Hans',
    plan: 'growth',
  });
  tenant = { orgId: out.orgId, locationId: out.locationId };
  await unclaim();
});

afterAll(async () => {
  // 跑完把这家店退回未认领：不然种子账号的选店器里会多出一家自测门店
  await unclaim();
  await closeDb();
});

describe('A · 建租户', () => {
  it('同一个 checkout session 建两次，只建出一家店', async () => {
    const again = await provisionTenant({
      checkoutSessionId: SESSION,
      shopName: '换个名字也没用',
      ownerEmail: OWNER_EMAIL,
      businessType: 'massage',
      timezone: 'America/Los_Angeles',
      locale: 'en',
      plan: 'essential',
    });

    expect(again.already).toBe(true);
    expect(again.orgId).toBe(tenant.orgId);
    expect(again.locationId).toBe(tenant.locationId);

    // 重投也不会改掉已经建好的那一家（老板已经在用了）
    const rows = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from locations where org_id = ${tenant.orgId}`);
    expect(rows[0]!.n).toBe('1');
  });

  it('新店落在 setup 状态，且带得上时区和业态', async () => {
    const [loc] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ status: string; timezone: string; business_type: string; name: Record<string, string> }[]>`
        select status, timezone, business_type, name from locations where id = ${tenant.locationId}`);
    expect(loc!.status).toBe('setup');
    expect(loc!.timezone).toBe('America/Chicago');
    expect(loc!.business_type).toBe('nail');
    // 店名同时写进 en 和母语：只写母语的话英文界面下顶栏是空的
    expect(loc!.name['en']).toBe('Selftest Nails');
    expect(loc!.name['zh-Hans']).toBe('Selftest Nails');
  });

  it('计费账户跟着建出来，套餐是官网传的那一个', async () => {
    const [acct] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ plan: string }[]>`
        select plan from billing_accounts where location_id = ${tenant.locationId}`);
    expect(acct!.plan).toBe('growth');
  });

  it('🔴 gf_owner_email 和 customer_email 不一致 → 拒绝，一行都不写', async () => {
    const { logger, errors } = log();
    const evil = session({
      id: 'cs_test_gf_selftest_mismatch',
      customer_email: 'attacker@example.test',
    });

    const out = await provisionFromSession(evil, logger);

    expect(out).toBeNull();
    // 必须告警：这是这条链路上最不该被静默吞掉的一件事
    expect(errors.length).toBe(1);

    // 而且真的什么都没写：那个 session 不存在于任何一家店
    const rows = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from signup_intents
                          where checkout_session_id = 'cs_test_gf_selftest_mismatch'`);
    expect(rows[0]!.n).toBe('0');
  });

  it('认不出的时区/业态/语言一律回退，并把原值留档', async () => {
    const s = 'cs_test_gf_selftest_fallback';
    const out = await provisionTenant({
      checkoutSessionId: s,
      shopName: '  水疗小店  ',
      ownerEmail: 'NOBODY@Example.test',
      businessType: '按摩',            // 不在五个值里
      timezone: 'Mars/Olympus',        // 不是 IANA
      locale: 'fr',                    // 不在六个值里
      plan: 'platinum',                // 不是我们的套餐
    });

    const t = { orgId: out.orgId, locationId: out.locationId, membershipId: null };
    const [loc] = await withTenant(t, (tx) =>
      tx<{ timezone: string; business_type: string }[]>`
        select timezone, business_type from locations where id = ${out.locationId}`);
    const [si] = await withTenant(t, (tx) =>
      tx<{ owner_email: string; plan: string; metadata: Record<string, unknown> }[]>`
        select owner_email, plan, metadata from signup_intents where checkout_session_id = ${s}`);

    // ⚠️ 拒绝不是选项：钱已经收了。回退 + 留档，向导第一步让老板确认
    expect(loc!.timezone).toBe('America/New_York');
    expect(loc!.business_type).toBe('nail');
    expect(si!.plan).toBe('essential');
    expect(si!.metadata['timezone_fallback']).toBe('Mars/Olympus');
    expect(si!.metadata['business_type_fallback']).toBe('按摩');
    expect(si!.metadata['locale_fallback']).toBe('fr');
    // 邮箱一律小写存：比对时不区分大小写
    expect(si!.owner_email).toBe('nobody@example.test');
  });
});

describe('B · 认领门店', () => {
  /** 认领那一步用的上下文：他还没有 membership，这条命令就是去造那一条 */
  const claimCtx = (userId: string) => ({
    orgId: tenant.orgId,
    locationId: tenant.locationId,
    userId,
    membershipId: null,
    permissions: new Set(['settings.manage' as const]),
    actorKind: 'user' as const,
    locale: 'en' as const,
    timezone: 'UTC',
  });

  it('⭐ 只有邀请邮箱那个人能查到这家店', async () => {
    const mine = await claimableIntentFor(OWNER_USER);
    expect(mine?.locationId).toBe(tenant.locationId);

    // 换一个登录用户 → 什么都查不到。判定在数据库函数里，
    // 比的是 auth.users 那一行的邮箱，应用插不上话
    const theirs = await claimableIntentFor(OTHER_USER);
    expect(theirs).toBeNull();
  });

  it('认领之后能进 desk，而且拿到的是 owner 的全部权限', async () => {
    const intent = await claimableIntentFor(OWNER_USER);
    const out = await dispatch<{ membershipId: string }>(
      'setup.claimLocation', { intentId: intent!.intentId }, claimCtx(OWNER_USER));

    const ctx = await buildContext({ userId: OWNER_USER, membershipId: out.result.membershipId });
    expect(ctx.locationId).toBe(tenant.locationId);
    expect(ctx.permissions.has('billing.manage')).toBe(true);
    expect(ctx.permissions.has('settings.manage')).toBe(true);
    expect(ctx.permissions.has('catalog.manage')).toBe(true);

    // 建店时那个占位的 owner_user_id 换成了真人
    const [org] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ owner_user_id: string }[]>`
        select owner_user_id from organizations where id = ${tenant.orgId}`);
    expect(org!.owner_user_id).toBe(OWNER_USER);
  });

  it('⭐ 认领过的 intent 不能再认领 —— 明确报错，不是静默成功', async () => {
    const [si] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ id: string }[]>`select id from signup_intents where location_id = ${tenant.locationId}`);

    await expect(
      dispatch('setup.claimLocation', { intentId: si!.id }, claimCtx(OTHER_USER)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 而且没有第二条 membership 被造出来
    const rows = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from memberships
                          where location_id = ${tenant.locationId}`);
    expect(rows[0]!.n).toBe('1');
  });

  it('认领之后这家店就从「可认领」列表里消失', async () => {
    /**
     * ⚠️ 断言的是「**这一家**不在里面」，不是「一家都没有」。
     *
     * 一个邮箱可以买两家店 —— 那时候这个函数本来就该返回下一家。
     * 写成 `toBeNull()` 的话，开发库里多一条别的待认领记录就会让它红，
     * 而那和被测的行为毫无关系。
     */
    const next = await claimableIntentFor(OWNER_USER);
    expect(next?.locationId).not.toBe(tenant.locationId);
  });
});

describe('C · 向导完成', () => {
  it('资料没齐时拒绝开店；齐全后变 active，再点一次也不报错', async () => {
    const [m] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ id: string }[]>`select id from memberships where location_id = ${tenant.locationId}`);
    const ctx = await buildContext({ userId: OWNER_USER, membershipId: m!.id });

    await expect(dispatch('location.finishSetup', {}, ctx)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'setup_incomplete' },
    });

    await withTenant({ ...tenant, membershipId: m!.id }, async (tx) => {
      await tx`update locations set
        settings = jsonb_set(settings, '{profile_confirmed_at}', to_jsonb(now()::text)),
        business_hours = '{"mon":{"open":"09:00","close":"18:00"}}'::jsonb
        where id = ${tenant.locationId}`;
      await tx`update staff_profiles set is_bookable = true
        where location_id = ${tenant.locationId}`;
      await tx`insert into services
        (org_id, location_id, name, duration_min, base_price_cents, active)
        values (${tenant.orgId}, ${tenant.locationId}, '{"en":"Test service"}'::jsonb, 60, 5000, true)`;
    });

    const first = await dispatch<{ status: string }>('location.finishSetup', {}, ctx);
    expect(first.result.status).toBe('active');

    // 老板在两台设备上各点一次「完成」，不该看到一个错误
    const again = await dispatch<{ status: string }>('location.finishSetup', {}, ctx);
    expect(again.result.status).toBe('active');
  });

  it('时区认不出来的话，宁可当场拒绝也不写进去', async () => {
    const [m] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ id: string }[]>`select id from memberships where location_id = ${tenant.locationId}`);
    const ctx = await buildContext({ userId: OWNER_USER, membershipId: m!.id });

    await expect(
      dispatch('location.saveProfile', { timezone: 'Mars/Olympus' }, ctx),
    ).rejects.toBeInstanceOf(AppError);

    const ok = await dispatch<{ locationId: string }>(
      'location.saveProfile',
      { timezone: 'America/Los_Angeles', businessType: 'foot_spa' }, ctx);
    expect(ok.result.locationId).toBe(tenant.locationId);
  });
});

/**
 * D · Google 账号登录（sql/0047）
 *
 * JWT 那一侧什么都不用测 —— `auth.ts` 验的是 Supabase 的 JWKS，
 * 会话是密码登的、magic link 登的还是 Google 登的，它一视同仁。
 *
 * 会出事的是**认领门店**：那一步比对的是邮箱字符串，而 Gmail
 * 忽略本地部分里的点、也忽略 `+` 之后的部分。老板在官网手打
 * `john.doe@gmail.com`，Google 回来的是 `johndoe@gmail.com` ——
 * 字符串不等，他付了钱却拿到一句「没有可认领的门店」。
 *
 * ⚠️ 这里测的是规范化函数本身，不是端到端：端到端要一个邮箱是 gmail
 * 的 `auth.users` 行，而那个 schema 测试用的 app_user 写不了。
 * 谓词接线由上面 B 组那两条（本人能认领 / 别人认领不到）盯着。
 */
describe('D · Google 登录：邮箱规范化', () => {
  const canon = async (v: string | null) => {
    const [r] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ v: string | null }[]>`select public.gf_canonical_email(${v}) as v`);
    return r!.v;
  };

  it('⭐ Gmail：忽略点、剥掉 +tag、googlemail 收敛成 gmail', async () => {
    expect(await canon('John.Doe@gmail.com')).toBe('johndoe@gmail.com');
    expect(await canon('johndoe+geniefront@GMAIL.com')).toBe('johndoe@gmail.com');
    expect(await canon('john.doe@googlemail.com')).toBe('johndoe@gmail.com');
    // 官网手打的和 Google 回来的，规范化之后必须是同一个字符串
    expect(await canon('John.Doe+shop@GMail.com')).toBe(await canon('johndoe@gmail.com'));
  });

  it('⭐ Workspace 自建域名**不去点** —— 去了就是把 A 的店送给 B', async () => {
    /*
     * 点号规则只有 gmail.com / googlemail.com 成立。
     * `john.doe@corp.com` 和 `johndoe@corp.com` 在自建域名下是两个人，
     * 一视同仁地去点会让后者认领到前者付钱的店 ——
     * 比原来那个「付了钱进不去」严重得多。
     */
    expect(await canon('John.Doe@corp.com')).toBe('john.doe@corp.com');
    expect(await canon('John.Doe@corp.com')).not.toBe(await canon('johndoe@corp.com'));
    // +tag 同样只在 Gmail 上剥：别的域名剥掉会把老板故意分开的两家店折叠成一条
    expect(await canon('owner+store1@corp.com')).toBe('owner+store1@corp.com');
    expect(await canon('owner+store1@corp.com')).not.toBe(await canon('owner+store2@corp.com'));
  });

  it('喂进去的东西不成形也不能炸 —— 这个函数在认领那条路的 where 里', async () => {
    expect(await canon(null)).toBeNull();
    expect(await canon('nonsense')).toBe('nonsense');
    expect(await canon('  Mixed@Example.TEST ')).toBe('mixed@example.test');
  });

  it('可认领的那一家要带店名 —— 登录后那一屏要写「你有一家 XX 等着开通」', async () => {
    /*
     * 这一条同时守着 `gf_signup_intent_for_user` 的返回列：
     * 0047 给它加了 shop_name，加错了这里会拿到 undefined 而不是报错。
     */
    const [si] = await withTenant({ ...tenant, membershipId: null }, (tx) =>
      tx<{ id: string }[]>`
        select id from signup_intents where location_id = ${tenant.locationId}`);
    expect(si).toBeTruthy();

    // 上面 B 组已经认领过了，先放回未认领再问一次，问完还原
    await withTenant({ ...tenant, membershipId: null }, (tx) => tx`
      update signup_intents set claimed_at = null where id = ${si!.id}`);
    try {
      const intent = await claimableIntentFor(OWNER_USER);
      expect(intent?.locationId).toBe(tenant.locationId);
      expect(typeof intent?.shopName).toBe('string');
      expect(intent!.shopName.length).toBeGreaterThan(0);
    } finally {
      await withTenant({ ...tenant, membershipId: null }, (tx) => tx`
        update signup_intents set claimed_at = now() where id = ${si!.id}`);
    }
  });
});
