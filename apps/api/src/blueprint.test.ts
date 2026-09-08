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
import { withTenant, closeDb, jsonb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadBlueprint } from './queries/blueprint';
import './handlers/blueprint';
import { dispatchSystem } from './test/systemDispatch';

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
    await tx`delete from package_templates
      where location_id = ${NAIL_LOC} and name->>'en' = 'AI Test Package'`;
    const ids = await tx<{ applied_service_id: string }[]>`
      select i.applied_service_id from blueprint_items i
      join shop_blueprints b on b.id = i.blueprint_id
      where b.location_id = ${NAIL_LOC} and i.applied_service_id is not null`;

    await tx`delete from shop_blueprints where location_id = ${NAIL_LOC}`;

    if (ids.length > 0) {
      const svcIds = ids.map((r) => r.applied_service_id);
      // 分类要跟着清（回填现在会建 service_categories）。顺序同样被外键逼着：
      // 先记下分类 id → 删 services → 再删**已经没人用的**那些分类。
      // 直接按名字删会误伤老板手工建的同名分类。
      const cats = await tx<{ category_id: string }[]>`
        select distinct category_id from services
        where id = any(${svcIds}::uuid[]) and category_id is not null`;

      await tx`delete from services where id = any(${svcIds}::uuid[])`;

      if (cats.length > 0) {
        await tx`
          delete from service_categories c
          where c.id = any(${cats.map((r) => r.category_id)}::uuid[])
            and not exists (select 1 from services s where s.category_id = c.id)`;
      }
    }
  });
  await closeDb();
});

const run = async <T>(name: string, input: unknown, key = randomUUID()) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

/** 系统自有命令（AUD-01）：`blueprint.saveExtraction` 记的是一次已经发生的模型调用。 */
const runSystem = async <T>(name: string, input: unknown, key = randomUUID()) =>
  (await dispatchSystem<T>(name, input, ctx, { idempotencyKey: key })).result;

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
  await runSystem('blueprint.saveExtraction', extractionPayload(blueprintId));
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
    await runSystem('blueprint.saveExtraction', {
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
  it('官网草案把门店资料和勾选员工放在同一事务落地，即使没有项目也能完成', async () => {
    const [before] = await withTenant(tenant, (tx) => tx<{
      name: unknown; phone: string | null; address_street: string | null;
      business_hours: unknown; settings: unknown; business_type: string;
    }[]>`select name, phone, address_street, business_type, business_hours, settings
          from locations where id = ${NAIL_LOC}`);
    const { blueprintId } = await run<{ blueprintId: string }>('blueprint.createDraft', {
      label: 'Website import test',
      sources: [{ seq: 0, kind: 'website', sourceUrl: 'https://example.com', storagePath: null, widthPx: null, heightPx: null }],
    });
    await runSystem('blueprint.saveExtraction', {
      blueprintId, items: [], unresolved: [],
      locationProposal: {
        name: 'Imported Spa', phone: '+16175550123', addressStreet: '88 Test Street',
        businessType: 'massage', businessHours: { mon: { open: '09:00', close: '18:00' } },
        staff: [{ name: 'Amy', role: 'Massage Therapist' }],
      },
      usage: { tokens: 100, costMillicents: 10, imagesOk: 0, imagesFailed: 0, feature: 'website_onboarding' },
    });

    const out = await run<{ createdServiceIds: string[]; createdStaffIds: string[]; locationApplied: boolean }>(
      'blueprint.apply', { blueprintId, allowNoServices: true, applyLocationProposal: true, staffProposalIndexes: [0] });
    expect(out.createdServiceIds).toEqual([]);
    expect(out.createdStaffIds).toHaveLength(1);
    expect(out.locationApplied).toBe(true);

    const [after] = await withTenant(tenant, (tx) => tx<{
      phone: string; address_street: string; business_type: string; confirmed: boolean;
    }[]>`select phone, address_street, business_type,
          (settings ? 'profile_confirmed_at') as confirmed
          from locations where id = ${NAIL_LOC}`);
    expect(after).toMatchObject({ phone: '+16175550123', address_street: '88 Test Street', business_type: 'massage', confirmed: true });

    await withTenant(tenant, async (tx) => {
      await tx`delete from rotation_participants where membership_id = any(${out.createdStaffIds}::uuid[])`;
      await tx`delete from memberships where id = any(${out.createdStaffIds}::uuid[])`;
      await tx`update locations set name = ${jsonb(before!.name)}::jsonb, phone = ${before!.phone},
        address_street = ${before!.address_street}, business_type = ${before!.business_type},
        business_hours = ${jsonb(before!.business_hours)}::jsonb,
        settings = ${jsonb(before!.settings)}::jsonb where id = ${NAIL_LOC}`;
    });
  });

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

  it('确认页设的技师人数透传到 services.staff_count；没设的按 1', async () => {
    const id = await freshDraft();
    const view = await withTenant(tenant, (tx) => loadBlueprint(tx, ctx, id));
    const gel = view.items.find((i) => i.name['en'] === 'Gel Manicure')!;
    const ped = view.items.find((i) => i.name['en'] === 'Deluxe Pedicure')!;

    await run('blueprint.reviewItem', { itemId: gel.itemId, decision: 'accepted', staffCount: 2 });
    await run('blueprint.reviewItem', { itemId: ped.itemId, decision: 'accepted' });

    const out = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id, fallbackDurationMin: 60 });

    const rows = await withTenant(tenant, (tx) => tx<{
      name: Record<string, string>; staff_count: number;
    }[]>`
      select name, staff_count from services
      where id = any(${out.createdServiceIds}::uuid[])`);
    const byName = new Map(rows.map((r) => [r.name['en'], r.staff_count]));
    expect(byName.get('Gel Manicure')).toBe(2);
    expect(byName.get('Deluxe Pedicure')).toBe(1);
  });

  it('价目表上的分类跟着落地，同名只建一个', async () => {
    // 之前这里写死 category: null —— 分类只在确认页显示，一落地就丢了。
    // 结果是开单页面上三十几个项目排成一长条，前台滚半天才找到 Pedicure。
    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });
    const out = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id, fallbackDurationMin: 60 });

    const rows = await withTenant(tenant, (tx) => tx<{
      category_id: string | null; cat_name: unknown;
    }[]>`
      select s.category_id, c.name as cat_name
      from services s left join service_categories c on c.id = s.category_id
      where s.id = any(${out.createdServiceIds}::uuid[])`);

    expect(rows.every((r) => r.category_id !== null)).toBe(true);
    // 两个项目同属 MANICURE —— 建两个同名分类的话，开单页面会出现两个
    // 一模一样的分组，而老板分不清该往哪个里加项目
    expect(new Set(rows.map((r) => r.category_id)).size).toBe(1);
    expect((rows[0]!.cat_name as Record<string, string>)['en']).toBe('MANICURE');
  });

  it('⭐ 已经有同名分类时复用它，绝不再建一个', async () => {
    // 建两个同名分类的话，开单页面会出现两个一模一样的「MANICURE」分组，
    // 而老板分不清该往哪个里加项目 —— 而且这个错发现得很晚：
    // 要等他手工加第一个项目时才会看见两个分组。
    const countCats = () => withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from service_categories
      where location_id = ${NAIL_LOC} and name->>'en' = 'MANICURE'`)
      .then((r) => r[0]!.n);

    const before = await countCats();
    expect(before).toBeGreaterThan(0);   // 上一条用例已经建过

    const id = await freshDraft();
    await run('blueprint.reviewAll',
      { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500 });
    const out = await run<{ createdServiceIds: string[] }>(
      'blueprint.apply', { blueprintId: id, fallbackDurationMin: 60 });

    expect(await countCats()).toBe(before);   // 一个都没多建

    const rows = await withTenant(tenant, (tx) => tx<{ category_id: string | null }[]>`
      select category_id from services where id = any(${out.createdServiceIds}::uuid[])`);
    expect(rows.every((r) => r.category_id !== null)).toBe(true);
  });

  it('套餐在普通项目之后落地，并自动绑定同图识别出的项目', async () => {
    const { blueprintId } = await run<{ blueprintId: string }>('blueprint.createDraft', {
      sources: [{ seq: 0, storagePath: null, widthPx: 1200, heightPx: 900 }],
    });
    const base = extractionPayload(blueprintId);
    await runSystem('blueprint.saveExtraction', {
      ...base,
      items: [
        base.items[0],
        {
          ...base.items[0], kind: 'package', name: { en: 'AI Test Package' }, category: null,
          durationMin: null, priceCents: 18000, packageSessions: 5,
          packageServiceNames: ['Gel Manicure'], packageValidDays: 180,
        },
      ],
    });
    const draft = await view(blueprintId);
    for (const item of draft!.items) {
      await run('blueprint.reviewItem', { itemId: item.itemId, decision: 'accepted' });
    }
    const out = await run<{ createdServiceIds: string[]; createdPackageIds: string[] }>(
      'blueprint.apply', { blueprintId });
    expect(out.createdServiceIds).toHaveLength(1);
    expect(out.createdPackageIds).toHaveLength(1);
    const packageId = out.createdPackageIds[0]!;
    const packageRows = await withTenant(tenant, (tx) => tx<{
      sessions: number; service_ids: string[]; valid_days: number;
    }[]>`select sessions, service_ids, valid_days from package_templates
      where id = ${packageId}`);
    const pkg = packageRows[0]!;
    expect(pkg).toMatchObject({ sessions: 5, valid_days: 180 });
    expect(pkg!.service_ids).toEqual(out.createdServiceIds);
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
