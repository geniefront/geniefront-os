/**
 * Phase 2 验收：AI 拍照开店这条链路。
 *
 * 模型那一侧不可复现，所以这里**不调模型** —— 直接喂一份「模型返回了什么」，
 * 验的是它之后的每一步：草案落库、逐项复核、一键勾选、回填落地、封板。
 *
 * 覆盖的是「不这么做就会出事」的那几件：
 *   · AI 的产出在被人勾中之前，一个项目都建不出来
 *   · 一键勾选默认不碰说明文字（否则开单页面会多出「Prices subject to change」）
 *   · 落地是幂等的（网差的店里点两下不能建两套项目）
 *   · 落地之后草案封板，改不动了
 *   · 用量按次落进 usage_events（副驾额度包定价的计算基础）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadBlueprint } from './queries/blueprint';
import './handlers/blueprint';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;

beforeAll(async () => {
  // 店长（有 catalog.manage）
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager')
    limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
});

afterAll(async () => {
  // 测试建出来的 services 要一起清掉 —— 不清的话开发库里会一天天堆起一堆
  // Gel Manicure，下次跑测试的人会以为那是种子数据。
  //
  // ⚠️ 三步的顺序是被外键逼出来的，不能省：
  //   blueprint_items.applied_service_id 指着 services，所以先删 services 会被外键挡；
  //   而先删草案又会级联掉 items，那条「哪些 services 是测试建的」的线索就断了。
  //   所以：先把 id 记下来 → 删草案（级联 items）→ 再按 id 删 services。
  await withTenant(tenant, async (tx) => {
    const ids = await tx<{ applied_service_id: string }[]>`
      select i.applied_service_id from blueprint_items i
      join shop_blueprints b on b.id = i.blueprint_id
      where b.location_id = ${NAIL_LOC} and i.applied_service_id is not null`;

    await tx`delete from shop_blueprints where location_id = ${NAIL_LOC}`;

    if (ids.length > 0) {
      await tx`delete from services
               where id = any(${ids.map((r) => r.applied_service_id)}::uuid[])`;
    }
  });
  await closeDb();
});

const run = async <T>(name: string, input: unknown, key = randomUUID()) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

/** 一份「模型刚返回」的提取结果：两个能建的项目、一条说明、一行看不清的 */
function extractionPayload(blueprintId: string) {
  const item = (over: Record<string, unknown> = {}) => ({
    kind: 'service',
    name: { en: 'Gel Manicure' },
    category: 'MANICURE',
    durationMin: 45,
    priceCents: 4500,
    priceIsFrom: false,
    variants: [],
    confidenceBp: 9700,
    sourceSeq: 0,
    bbox: [10, 20, 300, 60],
    ...over,
  });

  return {
    blueprintId,
    items: [
      item(),
      item({ name: { en: 'Deluxe Pedicure' }, priceCents: 5500, durationMin: null }),
      item({ name: { en: 'Kids under 10' }, kind: 'note', priceCents: null, durationMin: null }),
      item({ name: { en: 'Dip Powder' }, priceCents: 4000, confidenceBp: 6000 }),
    ],
    unresolved: [{ field: 'duration', question: '每个项目大概做多久？' }],
    usage: { tokens: 12400, costMillicents: 5200, imagesOk: 1, imagesFailed: 0 },
  };
}

async function freshDraft(): Promise<string> {
  const { blueprintId } = await run<{ blueprintId: string }>('blueprint.createDraft', {
    sources: [{ seq: 0, storagePath: null, widthPx: 2000, heightPx: 1400 }],
  });
  await run('blueprint.saveExtraction', extractionPayload(blueprintId));
  return blueprintId;
}

const view = (id: string) =>
  withTenant(tenant, (tx) => loadBlueprint(tx, ctx, id));

describe('提取结果落进草案', () => {
  it('候选行进的是草案，一个 service 都没建', async () => {
    const before = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from services where location_id = ${NAIL_LOC}`);
    const id = await freshDraft();
    const after = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from services where location_id = ${NAIL_LOC}`);

    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));

    const v = await view(id);
    expect(v!.summary.total).toBe(4);
    // 默认全是 pending —— AI 不替老板做决定（05 §0）
    expect(v!.summary.accepted).toBe(0);
  });

  it('低置信度的行由服务端算好标记，前端不自己比阈值', async () => {
    const v = await view(await freshDraft());
    const dip = v!.items.find((i) => i.displayName === 'Dip Powder')!;
    expect(dip.confidenceBp).toBe(6000);
    expect(dip.lowConfidence).toBe(true);
    expect(v!.items.find((i) => i.displayName === 'Gel Manicure')!.lowConfidence).toBe(false);
  });

  it('AI 没法从图上知道的事进 unresolved，而不是被瞎猜一个值', async () => {
    const v = await view(await freshDraft());
    expect(v!.unresolved).toHaveLength(1);
    expect(v!.unresolved[0]!.field).toBe('duration');
  });

  it('⭐ 用量按次落进 usage_events，且 ai_assist 与电话分钟分开计（决策 8）', async () => {
    const id = await freshDraft();
    const [ev] = await withTenant(tenant, (tx) => tx<{
      kind: string; qty: number; cost_cents: number; meta: Record<string, unknown>;
    }[]>`
      select kind, qty, cost_cents, meta from usage_events
      where location_id = ${NAIL_LOC} and meta->>'blueprintId' = ${id}`);

    expect(ev!.kind).toBe('ai_assist');
    expect(ev!.qty).toBe(12400);
    expect(ev!.cost_cents).toBe(5);              // 5200 毫分 → 5 分
    expect(ev!.meta['costMillicents']).toBe(5200); // 精确值留在 meta，出账单用它
    expect(ev!.meta['feature']).toBe('price_list_vision');
  });

  it('重跑提取会覆盖上一次，不是叠加两份', async () => {
    const id = await freshDraft();
    await run('blueprint.saveExtraction', {
      ...extractionPayload(id),
      items: [extractionPayload(id).items[0]!],
    });
    expect((await view(id))!.summary.total).toBe(1);
  });
});

describe('逐项复核', () => {
  it('改价格会打上「已改」—— 之后它就不再算 AI 的产物（宪法第 6 条）', async () => {
    const id = await freshDraft();
    const target = (await view(id))!.items[0]!;
    await run('blueprint.reviewItem', { itemId: target.itemId, priceCents: 5000 });

    const after = (await view(id))!.items.find((i) => i.itemId === target.itemId)!;
    expect(after.priceCents).toBe(5000);
    expect(after.edited).toBe(true);
  });

  it('只勾选不改内容，不算「已改」', async () => {
    const id = await freshDraft();
    const target = (await view(id))!.items[0]!;
    await run('blueprint.reviewItem', { itemId: target.itemId, decision: 'accepted' });

    const after = (await view(id))!.items.find((i) => i.itemId === target.itemId)!;
    expect(after.decision).toBe('accepted');
    expect(after.edited).toBe(false);
  });

  it('⭐ 一键勾选默认只碰项目，不碰说明文字', async () => {
    // 「Kids under 10」被建成项目的话，前台开单页面天天看着它
    const id = await freshDraft();
    await run('blueprint.reviewAll', { blueprintId: id, decision: 'accepted' });

    const v = await view(id);
    expect(v!.items.find((i) => i.displayName === 'Kids under 10')!.decision).toBe('pending');
    expect(v!.summary.accepted).toBe(3);
  });

  it('按置信度筛：标黄的那行留给老板自己看', async () => {
    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });

    const v = await view(id);
    expect(v!.items.find((i) => i.displayName === 'Dip Powder')!.decision).toBe('pending');
    expect(v!.summary.accepted).toBe(2);
  });
});

describe('回填落地', () => {
  it('只建勾中的，且没印时长的按兜底值建', async () => {
    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });

    const out = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id, fallbackDurationMin: 60 });
    expect(out.createdServiceIds).toHaveLength(2);

    const rows = await withTenant(tenant, (tx) => tx<{
      name: Record<string, string>; duration_min: number; base_price_cents: number;
    }[]>`
      select name, duration_min, base_price_cents from services
      where id = any(${out.createdServiceIds}::uuid[]) order by base_price_cents`);

    expect(rows.map((r) => r.name['en'])).toEqual(['Gel Manicure', 'Deluxe Pedicure']);
    expect(rows[0]!.duration_min).toBe(45);   // 价目表印了 45
    expect(rows[1]!.duration_min).toBe(60);   // 没印，用兜底值
    expect(rows[1]!.base_price_cents).toBe(5500);
  });

  it('⭐ 幂等：网差的店里点两下「落地」，第二下什么都不做', async () => {
    // 不幂等的话项目库里会出现两套一模一样的 38 个项目，而老板分不清该删哪一套
    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });

    const key = randomUUID();
    const first = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id }, key);
    const second = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id }, key);

    expect(second.createdServiceIds).toEqual(first.createdServiceIds);
  });

  it('一行都没勾就落地 → 明确报错，不是静默建 0 个', async () => {
    const id = await freshDraft();
    await expect(run('blueprint.apply', { blueprintId: id }))
      .rejects.toMatchObject({ code: 'BLUEPRINT_NOTHING_ACCEPTED' });
  });

  it('⭐ 落地之后草案封板 —— 改价格要去项目那边改', async () => {
    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });
    await run('blueprint.apply', { blueprintId: id });

    const item = (await view(id))!.items[0]!;
    await expect(run('blueprint.reviewItem', { itemId: item.itemId, priceCents: 9900 }))
      .rejects.toMatchObject({ code: 'BLUEPRINT_FROZEN' });
    await expect(run('blueprint.discard', { blueprintId: id }))
      .rejects.toMatchObject({ code: 'BLUEPRINT_FROZEN' });
  });

  it('落地行指回它建出来的项目，可追溯', async () => {
    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });
    const out = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id });

    const linked = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from blueprint_items
      where blueprint_id = ${id} and applied_service_id = any(${out.createdServiceIds}::uuid[])`);
    expect(Number(linked[0]!.n)).toBe(2);
  });
});

describe('放弃', () => {
  it('丢掉的草案改不动了，但记录还在', async () => {
    const id = await freshDraft();
    await run('blueprint.discard', { blueprintId: id });

    expect((await view(id))!.status).toBe('discarded');
    await expect(run('blueprint.reviewAll', { blueprintId: id, decision: 'accepted' }))
      .rejects.toMatchObject({ code: 'BLUEPRINT_FROZEN' });
  });
});
