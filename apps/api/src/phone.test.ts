/**
 * Phase 2 验收：AI 电话接单这条链路。
 *
 * 不打真电话 —— 直接构造「Telnyx 会发来什么」，验的是它之后的每一步。
 * 每一条都在问同一个问题：**这一行检查没有的话，会出什么事？**
 *
 *   · 伪造签名能不能往复核队列灌预约
 *   · AI 能不能建出一条真预约（不能，它只有 call.draft）
 *   · AI 编一个「明天四点」能不能蒙混过关（不能，排期引擎会驳回）
 *   · 同号多客户会不会被自动挑一个（不会，决策 21）
 *   · webhook 重投会不会把通话分钟数记两遍（不会，那是多收钱）
 *   · 号码没绑门店时会不会落到一个猜出来的租户上（不会，404）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { withTenant, closeDb, tenantForPhoneNumber } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadCallDrafts } from './queries/callDrafts';
import { buildServer } from './server';
import './handlers/phone';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const AI_LINE = '+15125550199';

let ctx: Awaited<ReturnType<typeof buildContext>>;
let app: ReturnType<typeof buildServer>;

/** 冒充 Telnyx 需要它的私钥；测试里我们自己生成一对，公钥喂给服务端 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublicB64 = publicKey.export({ type: 'spki', format: 'der' })
  .subarray(12).toString('base64');

beforeAll(async () => {
  process.env['TELNYX_PUBLIC_KEY'] = rawPublicB64;

  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  await run('location.savePhoneLine', { e164: AI_LINE, purpose: 'ai_voice' });

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  // beforeAll 挂了的话 app 还是 undefined，这里再抛一次会把真正的报错盖掉
  await app?.close();
  await withTenant(tenant, async (tx) => {
    await tx`delete from call_drafts where location_id = ${NAIL_LOC}`;
    await tx`delete from phone_lines where location_id = ${NAIL_LOC}`;
  });
  await closeDb();
});

const run = async <T>(name: string, input: unknown, key: string = randomUUID()) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

/**
 * 电话 AI 那个系统上下文 —— 和 telnyx/routes.ts 的 systemContext 一致。
 *
 * `membershipId: null`（电话背后没有人）、`actorKind: 'api'`、
 * 权限只有 call.draft + 三个只读。用它跑才是真实路径；
 * 拿店长的上下文跑 call.record 会因为店长权限更大而【通过】，
 * 那就等于没测到「AI 的权限有多窄」。
 */
const sysCtx = (): typeof ctx => ({
  ...ctx,
  membershipId: null,
  actorKind: 'api',
  permissions: new Set(['call.draft', 'appointment.read', 'customer.read', 'schedule.read']),
});

const runAsPhone = async <T>(name: string, input: unknown, key: string = randomUUID()) =>
  (await dispatch<T>(name, input, sysCtx(), { idempotencyKey: key })).result;

/** 造一条带合法签名的 Telnyx 请求 */
function telnyxCall(url: string, payload: unknown, opts: { badSig?: boolean; skewSec?: number } = {}) {
  const raw = JSON.stringify(payload);
  const tsSec = Math.floor(Date.now() / 1000) + (opts.skewSec ?? 0);
  const sig = opts.badSig
    ? Buffer.from('forged-signature-that-looks-plausible').toString('base64')
    : edSign(null, Buffer.from(`${tsSec}|${raw}`, 'utf8'), privateKey).toString('base64');

  return app.inject({
    method: 'POST', url,
    headers: {
      'content-type': 'application/json',
      'telnyx-signature-ed25519': sig,
      'telnyx-timestamp': String(tsSec),
    },
    payload: raw,
  });
}

const drafts = (status = 'pending') =>
  withTenant(tenant, (tx) => loadCallDrafts(tx, ctx, status));

// ═══════════════════════════════════════════════════════════════════════════

describe('号码 → 门店', () => {
  it('绑过的号码解析得出门店，且不需要绕过 RLS', async () => {
    const t = await tenantForPhoneNumber(AI_LINE);
    expect(t?.locationId).toBe(NAIL_LOC);
    expect(t?.orgId).toBe(NAIL_ORG);
  });

  it('⭐ 没绑过的号码解析不出来 —— 别把电话落到一个猜出来的租户上', async () => {
    expect(await tenantForPhoneNumber('+15125550000')).toBeNull();
  });

  it('⭐ 号码维度的上下文只能看到那一行，翻不出整张号码表', async () => {
    // 策略是 `e164 = app_phone_lookup()`：要先说出完整号码才查得到它
    const { withPhoneLine } = await import('@gf/db');
    const all = await withPhoneLine(AI_LINE, (tx) => tx<{ e164: string }[]>`
      select e164 from phone_lines`);
    expect(all).toHaveLength(1);
    expect(all[0]!.e164).toBe(AI_LINE);
  });

  it('同一个号码不能同时绑两家店', async () => {
    // 绑重了 webhook 会随机落到其中一家 —— 无从复现的串店
    const [other] = await withTenant(
      { orgId: NAIL_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        select id from locations where id <> ${NAIL_LOC} and org_id = ${NAIL_ORG} limit 1`);
    if (!other) return;   // 种子里只有一家店时跳过
    const otherCtx = { ...ctx, locationId: other.id };
    await expect(dispatch('location.savePhoneLine',
      { e164: AI_LINE, purpose: 'ai_voice' }, otherCtx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});

describe('验签：这条链路唯一的安全要害', () => {
  it('⭐ 伪造签名灌不进复核队列', async () => {
    const before = (await drafts()).pendingCount;
    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', service_heard: 'gel manicure',
    }, { badSig: true });

    expect(res.statusCode).toBe(401);
    expect((await drafts()).pendingCount).toBe(before);
  });

  it('⭐ 过期签名同样被拒（防重放）', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: AI_LINE, from: '+15125551234' }, { skewSec: -3600 });
    expect(res.statusCode).toBe(401);
  });

  it('⭐ 这几条路由不吃 Bearer token —— 只认签名', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/telnyx/tools/lookup_customer',
      headers: { 'content-type': 'application/json', authorization: 'Bearer whatever' },
      payload: JSON.stringify({ to: AI_LINE }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('真签名通过', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: AI_LINE, from: '+15125551234' });
    expect(res.statusCode).toBe(200);
  });

  it('号码没绑门店 → 404，不是落到某个默认租户', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: '+15125550000', from: '+15125551234' });
    expect(res.statusCode).toBe(404);
  });
});

describe('tool：查空档', () => {
  it('返回的是排期引擎算出来的真空档，并附一句「不许自己推算」', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/find_slots', {
      to: AI_LINE, duration_min: 45,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('slots');
    expect(body.guidance).toMatch(/不要自己推算|不要自己另报/);
    // 每个空档都必须带具体是谁有空 —— 「有空」而说不出是谁，前台没法派单
    for (const s of body.slots) expect(s.staff.length).toBeGreaterThan(0);
  });
});

describe('tool：放进复核队列', () => {
  it('AI 只写草案，一条真预约都建不出来', async () => {
    const before = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from appointments where location_id = ${NAIL_LOC}`);

    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234',
      call_session_id: `test-${randomUUID()}`,
      service_heard: 'gel manicure', time_heard: '明天下午四点',
      caller_name: 'Chen',
    });
    expect(res.statusCode).toBe(200);

    const after = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from appointments where location_id = ${NAIL_LOC}`);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    expect((await drafts()).drafts.length).toBeGreaterThan(0);
  });

  it('⭐ AI 的权限里根本没有 appointment.write', async () => {
    // 就算验签被绕过，攻击面也只到「往待办里塞垃圾」为止。
    //
    // ⚠️ 入参必须是**形状合法**的：总线是先校验 Zod 再查权限，
    // 传 `items: []` 会先撞上 VALIDATION_FAILED，那就没验到权限这一步 ——
    // 一个看起来通过、其实什么都没证明的测试。
    await expect(dispatch('appointment.create', {
      customerId: null,
      items: [{ serviceId: randomUUID(), startsAt: new Date().toISOString() }],
    }, sysCtx(), { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('⭐ AI 编的时间过不了排期引擎 —— 会被清空并标低置信度', async () => {
    // 模型很擅长说出一个听起来合理、但那天店里没人在班的时间。
    // 客人在电话里已经听到了肯定答复，前台看到「16:00」也不会觉得有问题
    const madeUp = new Date(Date.now() + 90 * 24 * 3600_000);  // 三个月后，肯定没排班
    madeUp.setUTCHours(20, 0, 0, 0);

    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234',
      call_session_id: `made-up-${randomUUID()}`,
      service_heard: 'gel manicure',
      slot_starts_at: madeUp.toISOString(), duration_min: 45,
      confidence_bp: 9800,
    });
    expect(res.statusCode).toBe(200);

    const d = (await drafts()).drafts[0]!;
    expect(d.time.slotStartsAt).toBeNull();          // 时间被清掉了
    expect(d.lowConfidence).toBe(true);              // 而且标黄
    expect(d.notes).toMatch(/并不空闲/);              // 前台看得懂为什么
    expect(d.readyToBook).toBe(false);
  });

  it('⭐ 幂等：同一通电话重投两次只进一条待办', async () => {
    // 不去重前台会看到两条一模一样的，而她分不清是客人打了两次还是系统重了
    const callId = `dup-${randomUUID()}`;
    const payload = {
      to: AI_LINE, from: '+15125551234', call_session_id: callId,
      service_heard: 'pedicure',
    };
    const a = await telnyxCall('/v1/telnyx/tools/draft_appointment', payload);
    const b = await telnyxCall('/v1/telnyx/tools/draft_appointment', payload);

    expect(a.json().draftId).toBe(b.json().draftId);
  });

  it('AI 要说的那句话由我们定死，不让模型自己发挥', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', call_session_id: `say-${randomUUID()}`,
      service_heard: 'manicure',
    });
    // 模型会倾向于说「已经帮您约好了」，而它其实只是放进了待办
    expect(res.json().say).toMatch(/前台确认/);
    expect(res.json().say).not.toMatch(/约好|预约成功/);
  });

  it('听不出的项目名留空，但原话一定留着', async () => {
    // 猜一个「最像的」比留空危险：屏幕上会写着一个看起来完全正常的项目名
    await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', call_session_id: `unk-${randomUUID()}`,
      service_heard: '那个什么来着，弄脚的那个',
    });
    const d = (await drafts()).drafts[0]!;
    expect(d.service.matchedId).toBeNull();
    expect(d.service.heard).toBe('那个什么来着，弄脚的那个');
  });
});

describe('复核', () => {
  it('忽略必须给原因 —— 否则「AI 准不准」永远说不清', async () => {
    await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', call_session_id: `dis-${randomUUID()}`,
      service_heard: 'manicure',
    });
    const d = (await drafts()).drafts[0]!;

    await expect(run('call.reviewDraft', { draftId: d.draftId, decision: 'dismissed' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await run('call.reviewDraft', {
      draftId: d.draftId, decision: 'dismissed', dismissReason: 'not_a_booking',
    });
    expect((await drafts('dismissed')).drafts.some((x) => x.draftId === d.draftId)).toBe(true);
  });

  it('复核过的不能再复核一次', async () => {
    const dismissed = (await drafts('dismissed')).drafts[0]!;
    await expect(run('call.reviewDraft', {
      draftId: dismissed.draftId, decision: 'confirmed',
    })).rejects.toMatchObject({ code: 'ALREADY_CANCELLED' });
  });

  it('三要素缺哪个就明说缺哪个 —— 灰掉按钮不说原因，前台只会以为系统坏了', async () => {
    await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+19995550000', call_session_id: `miss-${randomUUID()}`,
      service_heard: 'unknown thing',
    });
    const d = (await drafts()).drafts[0]!;
    expect(d.readyToBook).toBe(false);
    expect(d.missing).toContain('项目');
    expect(d.missing).toContain('时间');
  });
});

describe('店家的两个号码（09 §2 接入方式）', () => {
  const STOREFRONT = '+15125550001';
  const HUMAN_DESK = '+15125550002';

  it('存下两个号，并告诉前端还没开通', async () => {
    const out = await run<{ aiVoiceE164: string | null; storefrontE164: string }>(
      'location.requestAiVoice',
      { storefrontE164: STOREFRONT, transferTargetE164: HUMAN_DESK });

    expect(out.storefrontE164).toBe(STOREFRONT);
    // 这家店的 ai_voice 是 beforeAll 里绑好的，所以这里拿得到
    expect(out.aiVoiceE164).toBe(AI_LINE);

    const rows = await withTenant(tenant, (tx) => tx<{ purpose: string; e164: string }[]>`
      select purpose, e164 from phone_lines
      where location_id = ${NAIL_LOC} and purpose in ('main','transfer_target')
      order by purpose`);
    expect(rows.map((r) => r.purpose)).toEqual(['main', 'transfer_target']);
  });

  it('⭐ 两个号相同要拒绝 —— 否则转人工会转回自己形成死循环', async () => {
    await expect(run('location.requestAiVoice',
      { storefrontE164: STOREFRONT, transferTargetE164: STOREFRONT }))
      .rejects.toThrow();
  });

  it('⭐ 不许把我们的落地号填进去 —— 那是 AI 转给 AI', async () => {
    // 客人会听见同一句开场白第二遍，而前台永远等不到那通电话
    await expect(run('location.requestAiVoice',
      { storefrontE164: STOREFRONT, transferTargetE164: AI_LINE }))
      .rejects.toThrow();
  });

  it('⭐ 同一个手机号可以在两家店都当人工客服号', async () => {
    // 这正是把 e164 唯一约束收窄到「会被反查的 purpose」的理由（sql/0025）：
    // 人工客服号常常是老板的手机，而一个老板开两三家店在这行很普遍。
    // 全局唯一的话，第二家店会撞一个看起来毫无道理的约束错误。
    const [other] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from locations where id <> ${NAIL_LOC} and org_id = ${NAIL_ORG} limit 1`);
    if (!other) return;   // 种子数据只有一家店时跳过

    const otherCtx = { ...ctx, locationId: other.id };
    await dispatch('location.requestAiVoice',
      { storefrontE164: '+15125550003', transferTargetE164: HUMAN_DESK },
      otherCtx, { idempotencyKey: randomUUID() });

    const rows = await withTenant({ ...tenant, locationId: other.id },
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from phone_lines
        where e164 = ${HUMAN_DESK} and purpose = 'transfer_target'`);
    expect(rows[0]!.n).toBe(2);

    await withTenant({ ...tenant, locationId: other.id }, (tx) =>
      tx`delete from phone_lines where location_id = ${other.id}`);
  });
});

describe('通话计费', () => {
  it('分钟数向上取整，落进 ai_call_min（与 ai_assist 分开，决策 8）', async () => {
    const callId = `bill-${randomUUID()}`;
    const out = await runAsPhone<{ billedMinutes: number }>('call.record', {
      providerCallId: callId, durationSeconds: 95, outcome: 'completed',
    }, `rec-${callId}`);

    expect(out.billedMinutes).toBe(2);   // 95 秒 = 2 分钟

    const [ev] = await withTenant(tenant, (tx) => tx<{ kind: string; qty: number }[]>`
      select kind, qty from usage_events
      where location_id = ${NAIL_LOC} and meta->>'providerCallId' = ${callId}`);
    expect(ev!.kind).toBe('ai_call_min');
    expect(ev!.qty).toBe(2);
  });

  it('⭐ webhook 重投不会把分钟数记两遍 —— 那是直接给客户多收钱', async () => {
    const callId = `dup-bill-${randomUUID()}`;
    const key = `rec-${callId}`;
    await runAsPhone('call.record', { providerCallId: callId, durationSeconds: 120 }, key);
    await runAsPhone('call.record', { providerCallId: callId, durationSeconds: 120 }, key);

    const evs = await withTenant(tenant, (tx) => tx<{ qty: number }[]>`
      select qty from usage_events
      where location_id = ${NAIL_LOC} and meta->>'providerCallId' = ${callId}`);
    expect(evs).toHaveLength(1);
  });

  /** 单价从环境读，所以这两条自己设/还原，不依赖跑测试时的 .env */
  async function recordWithRate(rate: string | undefined, durationSeconds: number) {
    const prev = process.env['TELNYX_RATE_PER_MIN_MILLICENTS'];
    if (rate === undefined) delete process.env['TELNYX_RATE_PER_MIN_MILLICENTS'];
    else process.env['TELNYX_RATE_PER_MIN_MILLICENTS'] = rate;
    const callId = `rate-${randomUUID()}`;
    try {
      await runAsPhone('call.record', {
        providerCallId: callId, durationSeconds, outcome: 'completed',
      }, `rec-${callId}`);
    } finally {
      if (prev === undefined) delete process.env['TELNYX_RATE_PER_MIN_MILLICENTS'];
      else process.env['TELNYX_RATE_PER_MIN_MILLICENTS'] = prev;
    }
    const [ev] = await withTenant(tenant, (tx) => tx<{
      cost_cents: number; meta: Record<string, unknown>;
    }[]>`
      select cost_cents, meta from usage_events
      where location_id = ${NAIL_LOC} and meta->>'providerCallId' = ${callId}`);
    return ev!;
  }

  it('单价配好之后，cost_cents 按毫分折算（口径与 ai_assist 一致）', async () => {
    const ev = await recordWithRate('6200', 150);
    // 150 秒 → 3 分钟 × 6200 毫分 = 18600 毫分 = 18.6 分 → 19 分
    expect(ev.meta['costMillicents']).toBe(18600);
    expect(ev.cost_cents).toBe(19);
    expect(ev.meta['unitPricePending']).toBeUndefined();
  });

  it('⭐ 把当时用的单价一起记下来 —— 否则事后无法重算历史毛利', async () => {
    // 单价会变（Telnyx 调价 / 换套餐 / 换供应商）。不记的话，
    // 一行 19 分的账既可能是 6200×3 也可能是别的组合，谁也说不清。
    const ev = await recordWithRate('6200', 60);
    expect(ev.meta['ratePerMinMillicents']).toBe(6200);
  });

  it('单价没配时记 0 + unitPricePending，而不是一个估算值', async () => {
    // 填成估算值更糟：那会被当成真数字拿去算单位经济（09 §6）
    const ev = await recordWithRate(undefined, 60);
    expect(ev.cost_cents).toBe(0);
    expect(ev.meta['unitPricePending']).toBe(true);
  });
});
