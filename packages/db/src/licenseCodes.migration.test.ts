/**
 * Evidence: sql/0120 建起订阅码这条第二计费权威，其不变量是**数据库约束**
 * 而不是应用侧的自觉，两张码表对 `app_user` 完全不可见，窄口函数各自
 * 自己判身份，且整份迁移可重放。
 *
 * ⚠️ 需要隔离库（`DATABASE_TEST_TARGET=isolated` + `TEST_*` 连接串）。
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, withUser, closeDb } from './client';
import { adminSql } from './admin';
import {
  PLATFORM_OPS_USER_ID, PLATFORM_EXOPS_USER_ID, PLATFORM_SUPPORT_USER_ID,
} from './platform';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../sql');
const M120 = 'sql/0120_license_codes.sql';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** 本文件自己造的码一律用这个前缀，收尾时按它清理 */
const TEST_PREFIX = 'GF-MIGT';
const hashOf = (plain: string): string => createHash('sha256').update(plain).digest('hex');

async function applySqlFile(key: string): Promise<void> {
  const body = await readFile(join(SQL_DIR, key.replace(/^sql\//, '')), 'utf8');
  await adminSql.unsafe(body);
  await adminSql`insert into _migrations (name) values (${key}) on conflict (name) do nothing`;
}

async function cleanup(): Promise<void> {
  await adminSql`
    delete from license_redemptions
    where code_id in (select id from license_codes where code_prefix = ${TEST_PREFIX})`;
  await adminSql`
    update billing_accounts set license_code_id = null
    where license_code_id in (select id from license_codes where code_prefix = ${TEST_PREFIX})`;
  await adminSql`delete from license_codes where code_prefix = ${TEST_PREFIX}`;
}

/** 直接以运营身份插一张码（绕过 gf_license_issue，好单独测约束） */
async function seedCode(over: Record<string, unknown> = {}): Promise<string> {
  const [op] = await adminSql<{ id: string }[]>`
    select id from platform_operators where user_id = ${PLATFORM_OPS_USER_ID}`;
  const row = {
    kind: 'subscription',
    code_hash: hashOf(`${TEST_PREFIX}-${Math.random()}`),
    code_prefix: TEST_PREFIX,
    plan: 'growth',
    duration_days: 30,
    payment_note: 'wechat migration test',
    valid_until: new Date(Date.now() + 86_400_000).toISOString(),
    issued_by_operator_id: op!.id,
    ...over,
  };
  const [ins] = await adminSql<{ id: string }[]>`
    insert into license_codes ${adminSql(row as never)} returning id`;
  return ins!.id;
}

beforeAll(async () => {
  await applySqlFile(M120);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closeDb();
  await adminSql.end({ timeout: 5 });
});

describe('sql/0120 · 账户上的第二条权威', () => {
  /**
   * ⚠️ 断言的是**列与默认值**，不是某一行现在的值。
   *
   * 这一条第一版读的是种子店那一行，于是它的绿灯取决于「上一个测试文件
   * 有没有把这家店挂上订阅码」—— 而 `@gf/db` 这个包的测试**不重跑种子**
   * （只有 apps/api 的 setupFiles 会）。表现是单独跑绿、跟在 api 套件后面跑红，
   * 而代码一个字都没改。
   */
  it('billing_accounts 加了四列，billing_source 默认 none', async () => {
    const cols = await adminSql<{ column_name: string; column_default: string | null }[]>`
      select column_name, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'billing_accounts'
        and column_name in ('billing_source', 'license_period_end',
                            'license_code_id', 'license_expiry_notified_at')
      order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'billing_source', 'license_code_id', 'license_expiry_notified_at', 'license_period_end',
    ]);
    const source = cols.find((c) => c.column_name === 'billing_source');
    expect(source?.column_default).toContain("'none'");
  });

  it('billing_source 只认三个值', async () => {
    await expect(adminSql`
      update billing_accounts set billing_source = 'paypal'
      where location_id = ${SPA_LOC}`).rejects.toThrow(/billing_source_known/);
  });

  /**
   * ⭐ 这一条挡的是「忘了填到期日」。
   *
   * 没有它的话，一行 `license` 权威 + 到期日为空 = 一家**永久免费**的店，
   * 而且不会有任何报错 —— sweep 那边的 `license_period_end <= now()`
   * 对 null 恒为假。
   */
  it('license 权威必须带到期时刻（约束在库里，不靠应用自觉）', async () => {
    await expect(adminSql`
      update billing_accounts set billing_source = 'license', license_period_end = null
      where location_id = ${SPA_LOC}`).rejects.toThrow(/billing_license_needs_period/);
  });
});

describe('sql/0120 · 码的条款完整性由约束保证', () => {
  it('订阅码缺 duration_days 直接被拒', async () => {
    await expect(seedCode({ duration_days: null }))
      .rejects.toThrow(/license_terms_complete/);
  });

  it('额度包码缺 unit / amount 直接被拒', async () => {
    await expect(seedCode({
      kind: 'quota_pack', plan: null, duration_days: null, unit: 'credit', amount: null,
    })).rejects.toThrow(/license_terms_complete/);
  });

  it('额度包码不许同时带套餐（两种条款混在一行 = 兑换时不知道该干什么）', async () => {
    await expect(seedCode({
      kind: 'quota_pack', plan: 'growth', duration_days: 30, unit: 'credit', amount: 500,
    })).rejects.toThrow(/license_terms_complete/);
  });

  it('收款说明不能为空 —— 没有出处的码事后查不清', async () => {
    await expect(seedCode({ payment_note: '   ' })).rejects.toThrow(/payment_note/);
  });

  it('撤销必须同时写时刻和原因', async () => {
    const id = await seedCode();
    await expect(adminSql`
      update license_codes set status = 'revoked' where id = ${id}`)
      .rejects.toThrow(/license_revoke_reason/);
  });

  it('兑换次数不能超过上限', async () => {
    const id = await seedCode({ max_redemptions: 1 });
    await expect(adminSql`
      update license_codes set redeemed_count = 2 where id = ${id}`)
      .rejects.toThrow(/license_redeemed_within_max/);
  });
});

describe('sql/0120 · 码表对租户的可见性', () => {
  /**
   * `license_codes` 对 `app_user` 是一张空表 —— 能查它就能枚举别人的码。
   */
  it('租户会话里连一行码都查不到', async () => {
    await seedCode();
    await expect(withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`select 1 from license_codes limit 1`,
    )).rejects.toThrow(/permission denied/i);
  });

  /**
   * `license_redemptions` 相反：门店对**自己那几行**有正当知情权
   * （「我的服务为什么到这一天」）。但只读 —— 能自己插一行就是能自己续期。
   */
  it('兑换记录：本店只读可见，别家的读不到，而且插不进去', async () => {
    const plain = `${TEST_PREFIX}-RLS`;
    await seedCode({ code_hash: hashOf(plain) });
    await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`select gf_license_claim(${hashOf(plain)})`);

    const own = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from license_redemptions`);
    expect(own[0]!.n).toBeGreaterThan(0);

    // 别家店的会话里，同样一条查询是空的（tenant_isolation）
    const other = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from license_redemptions
        where location_id = ${SPA_LOC}`);
    expect(other[0]!.n).toBe(0);

    await expect(withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`
        insert into license_redemptions (code_id, org_id, location_id)
        values (gen_random_uuid(), ${SPA_ORG}, ${SPA_LOC})`,
    )).rejects.toThrow(/permission denied/i);
  });
});

describe('sql/0120 · 窄口函数自己判身份', () => {
  it('签发限 super_admin：活着的 support 也被拒（能看不能发）', async () => {
    await expect(withUser(PLATFORM_SUPPORT_USER_ID, (tx) => tx`
      select gf_license_issue('subscription', ${hashOf('x')}, ${TEST_PREFIX},
        'note', now() + interval '1 day', 'growth', 30)`))
      .rejects.toThrow(/license_issue_requires_super_admin/);
  });

  it('support 读得到列表 —— 拒绝的只有「发」这个动作', async () => {
    const rows = await withUser(PLATFORM_SUPPORT_USER_ID, (tx) => tx<{ d: unknown }[]>`
      select gf_platform_list_licenses(null, null, null, 5, 0) as d`);
    expect(rows[0]?.d).toBeTruthy();
  });

  it('被撤销的运营连列表都读不到（和 support 被拒是两件事）', async () => {
    await expect(withUser(PLATFORM_EXOPS_USER_ID, (tx) => tx`
      select gf_platform_list_licenses(null, null, null, 5, 0)`))
      .rejects.toThrow(/not_platform_operator/);
  });

  it('非运营用户连列表都读不到', async () => {
    const [owner] = await adminSql<{ user_id: string }[]>`
      select user_id from memberships where location_id = ${SPA_LOC}
        and user_id is not null limit 1`;
    await expect(withUser(owner!.user_id, (tx) => tx`
      select gf_platform_list_licenses(null, null, null, 10, 0)`))
      .rejects.toThrow(/not_platform_operator/);
  });

  it('兑换必须有租户上下文 —— 不接受 org 入参', async () => {
    const id = await seedCode();
    expect(id).toBeTruthy();
    // withUser 只设 app.user_id，没有 org/location → 函数自己拒绝
    await expect(withUser(PLATFORM_OPS_USER_ID, (tx) => tx`
      select gf_license_claim(${hashOf('whatever')})`))
      .rejects.toThrow(/tenant_context_required/);
  });
});

describe('sql/0120 · 兑换的并发与定向', () => {
  it('定向到别家 org 的码，本店兑不了（且不告诉他为什么）', async () => {
    const plain = `${TEST_PREFIX}-CROSS`;
    await seedCode({ code_hash: hashOf(plain), target_org_id: NAIL_ORG, target_location_id: NAIL_LOC });
    await expect(withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`select gf_license_claim(${hashOf(plain)})`,
    )).rejects.toThrow(/license_invalid/);
  });

  it('过了可兑换期限的码兑不了（和不存在的码同一句话）', async () => {
    const plain = `${TEST_PREFIX}-STALE`;
    const id = await seedCode({ code_hash: hashOf(plain) });
    await adminSql`
      update license_codes set valid_until = now() - interval '1 day' where id = ${id}`;
    await expect(withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`select gf_license_claim(${hashOf(plain)})`,
    )).rejects.toThrow(/license_invalid/);
  });

  it('同一张码在同一家店只能生效一次', async () => {
    const plain = `${TEST_PREFIX}-ONCE`;
    await seedCode({ code_hash: hashOf(plain) });
    const claim = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ t: { redemptionId: string } }[]>`
        select gf_license_claim(${hashOf(plain)}) as t`);
    expect(claim[0]?.t.redemptionId).toBeTruthy();

    await expect(withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`select gf_license_claim(${hashOf(plain)})`,
    )).rejects.toThrow(/license_invalid/);
  });

  it('兑换记录不许被 app_user 删（append-only），但迁移与种子删得动', async () => {
    const plain = `${TEST_PREFIX}-APPEND`;
    await seedCode({ code_hash: hashOf(plain) });
    const [row] = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ t: { redemptionId: string } }[]>`
        select gf_license_claim(${hashOf(plain)}) as t`);
    const redemptionId = row!.t.redemptionId;

    // app_user 只有 select 权限，delete 直接被权限挡下（append-only 触发器
    // 是第二道保险，防的是「哪天有人手滑 grant 了 delete」）
    await expect(withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx`delete from license_redemptions where id = ${redemptionId}`,
    )).rejects.toThrow();

    // postgres（迁移 / 种子）删得动：不然 db:seed 删门店时会撞外键
    const del = await adminSql`delete from license_redemptions where id = ${redemptionId}`;
    expect(del.count).toBe(1);
  });
});

describe('sql/0120 · 可重放', () => {
  it('整份迁移再跑一遍不报错，且不改动已有的行', async () => {
    const plain = `${TEST_PREFIX}-REPLAY`;
    const id = await seedCode({ code_hash: hashOf(plain) });
    await applySqlFile(M120);
    const [row] = await adminSql<{ status: string; note: string }[]>`
      select status, payment_note as note from license_codes where id = ${id}`;
    expect(row?.status).toBe('active');
    expect(row?.note).toBe('wechat migration test');
  });
});
