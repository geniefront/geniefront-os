/**
 * 建站工单（批 8）。
 *
 * 盯的是状态机那几条边，尤其：
 *   · draft 阶段不进队列（老板才敢存半成品）
 *   · 必填校验在**提交**那一步，不是保存那一步
 *   · 已提交的不让改（团队可能已经在照着做了）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/storefront';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;

const run = async <T>(name: string, input: unknown = {}): Promise<T> =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: crypto.randomUUID() })).result;

/** 每条用例开头复位 —— 一店一张工单，用例之间会互相看见 */
const reset = () => withTenant(tenant, async (tx) => {
  await tx`delete from storefront_drafts where location_id = ${SPA_LOC}`;
  await tx`delete from storefront_briefs where location_id = ${SPA_LOC}`;
});

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active' and r.key = 'owner' limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
});

afterAll(async () => { await reset(); await closeDb(); });

describe('草稿', () => {
  it('第一次保存自动建出那一张 —— 不需要先点「新建」', async () => {
    await reset();
    const out = await run<{ briefId: string; status: string }>('storefront.saveDraft',
      { voice: 'warm' });
    expect(out.status).toBe('draft');
    expect(out.briefId).toBeTruthy();
  });

  it('⭐ 局部更新：分节保存不会把上一节清空', async () => {
    await reset();
    await run('storefront.saveDraft', { usp: '三十年临床经验', voice: 'traditional' });
    await run('storefront.saveDraft', { sections: ['hero', 'services'] });

    const [row] = await withTenant(tenant, (tx) => tx<{
      usp: string; voice: string; sections: unknown;
    }[]>`select usp, voice, sections from storefront_briefs where location_id = ${SPA_LOC}`);
    expect(row!.usp).toBe('三十年临床经验');
    expect(row!.voice).toBe('traditional');
    expect(row!.sections).toEqual(['hero', 'services']);
  });

  it('⭐ 保存不校验必填 —— 填到一半想存一下不该被三个红字拦住', async () => {
    await reset();
    // 什么都没填也能存
    await expect(run('storefront.saveDraft', { painFreeText: '现在这个太慢了' }))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('客群和最常问的三件事存得下（竞品没问这两节）', async () => {
    await reset();
    await run('storefront.saveDraft', {
      audience: ['seniors', 'chinese_community'],
      topQuestions: ['门口能停车吗', '收不收现金', '有会说中文的师傅吗'],
    });
    const [row] = await withTenant(tenant, (tx) => tx<{ a: unknown; q: unknown }[]>`
      select audience as a, top_questions as q from storefront_briefs
      where location_id = ${SPA_LOC}`);
    expect(row!.a).toEqual(['seniors', 'chinese_community']);
    expect((row!.q as string[])).toHaveLength(3);
  });
});

describe('提交', () => {
  it('⭐ 必填校验在提交这一步，缺什么说清楚', async () => {
    await reset();
    await run('storefront.saveDraft', { voice: 'warm' });
    await expect(run('storefront.submit'))
      .rejects.toMatchObject({ details: { reason: 'brief_incomplete' } });
  });

  it('填全了就能提交，状态和时间戳都落库', async () => {
    await reset();
    await run('storefront.saveDraft', {
      usp: '只做深层，不做精油推背', sections: ['hero', 'services', 'contact'],
    });
    const out = await run<{ status: string; submittedAt: string }>('storefront.submit');
    expect(out.status).toBe('submitted');
    expect(new Date(out.submittedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('⭐ 已提交的不让改 —— 团队可能已经在照着做了', async () => {
    await reset();
    await run('storefront.saveDraft', { usp: 'x', sections: ['hero'] });
    await run('storefront.submit');

    await expect(run('storefront.saveDraft', { usp: '改主意了' }))
      .rejects.toMatchObject({ details: { reason: 'brief_not_editable' } });
  });

  it('撤回之后又能改了', async () => {
    await reset();
    await run('storefront.saveDraft', { usp: 'x', sections: ['hero'] });
    await run('storefront.submit');
    await run('storefront.withdraw');

    await expect(run('storefront.saveDraft', { usp: '改好了' }))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('提交两次不是静默成功，而是说清已经交过了', async () => {
    await reset();
    await run('storefront.saveDraft', { usp: 'x', sections: ['hero'] });
    await run('storefront.submit');
    await expect(run('storefront.submit'))
      .rejects.toMatchObject({ details: { reason: 'brief_already_submitted' } });
  });

  it('⭐ 已上线的撤不回来 —— public_url 还在外面挂着', async () => {
    await reset();
    await run('storefront.saveDraft', { usp: 'x', sections: ['hero'] });
    await run('storefront.submit');
    await withTenant(tenant, (tx) => tx`
      update storefront_briefs set status = 'live', public_url = 'https://x.test'
      where location_id = ${SPA_LOC}`);

    await expect(run('storefront.withdraw'))
      .rejects.toMatchObject({ details: { reason: 'brief_already_live' } });
  });
});

describe('选版', () => {
  it('⭐ 选了新的就把旧的清掉 —— 两版同时 chosen 的话做的人不知道做哪个', async () => {
    await reset();
    const brief = await run<{ briefId: string }>('storefront.saveDraft',
      { usp: 'x', sections: ['hero'] });

    const ids = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into storefront_drafts (org_id, location_id, brief_id, variant, content)
      values (${SPA_ORG}, ${SPA_LOC}, ${brief.briefId}, 1, '{"v":1}'::jsonb),
             (${SPA_ORG}, ${SPA_LOC}, ${brief.briefId}, 2, '{"v":2}'::jsonb)
      returning id`);

    await run('storefront.chooseDraft', { draftId: ids[0]!.id });
    const out = await run<{ status: string }>('storefront.chooseDraft', { draftId: ids[1]!.id });
    expect(out.status).toBe('chosen');

    const rows = await withTenant(tenant, (tx) => tx<{ id: string; chosen_at: Date | null }[]>`
      select id, chosen_at from storefront_drafts where brief_id = ${brief.briefId}`);
    expect(rows.filter((r) => r.chosen_at !== null)).toHaveLength(1);
    expect(rows.find((r) => r.chosen_at !== null)!.id).toBe(ids[1]!.id);
  });

  it('别家店的版本选不了', async () => {
    await reset();
    await expect(run('storefront.chooseDraft',
      { draftId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
