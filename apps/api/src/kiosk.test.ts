/**
 * Phase 2 验收：Kiosk 门口端。
 *
 * 门口那台 iPad 前面站的是**客人**，不是员工 —— 所以这一份里
 * 大半的用例都在问同一个问题：**捡到这台 iPad 的人能拿它干什么？**
 *
 *   · 能不能拿它翻客户名单（不能：签到只认当天预约，只返回打码的名字）
 *   · 能不能拿它看预约表、看钱（不能：权限只有 queue.join + form.submit）
 *   · 令牌吊销之后还能不能用（不能）
 *   · 能不能一个个试号码（限频）
 *   · 健康表答案在库里是不是明文（不是，密文）
 *   · 两个人同时取号会不会拿到同一个号（不会，advisory lock）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { buildServer } from './server';
import { loadQueue } from './queries/queue';
import { maskName, __resetRateLimit } from './kiosk/routes';
import { decryptAnswers, loadFormKey } from './kiosk/crypto';
import './handlers/kiosk';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const spaTenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let app: ReturnType<typeof buildServer>;
let deviceToken = '';
let deviceId = '';
let templateId = '';
let templateVersion = 0;
let formQueueId = '';

beforeAll(async () => {
  process.env['FORM_ENCRYPTION_KEY'] ??= randomBytes(32).toString('hex');

  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  const issued = await run<{ deviceId: string; token: string }>(
    'device.issueToken', { label: '测试用门口 iPad' });
  deviceId = issued.deviceId;
  deviceToken = issued.token;

  const tpl = await run<{ templateId: string; version: number }>('catalog.saveFormTemplate', {
    key: 'intake',
    title: { 'zh-Hans': '健康与免责声明', en: 'Health & Liability Waiver', vi: 'Miễn trừ trách nhiệm' },
    questions: [
      { id: 'pregnant', type: 'bool', required: true,
        label: { 'zh-Hans': '是否怀孕？', en: 'Are you pregnant?', vi: 'Bạn có thai không?' } },
      { id: 'conditions', type: 'multi', required: false,
        label: { 'zh-Hans': '身体状况', en: 'Health conditions' },
        options: [
          { value: 'hbp', label: { 'zh-Hans': '高血压', en: 'High blood pressure' } },
          { value: 'surgery', label: { 'zh-Hans': '近期手术', en: 'Recent surgery' } },
        ] },
      { id: 'note', type: 'text', required: false,
        label: { 'zh-Hans': '其他要说明的', en: 'Anything else' } },
    ],
    requiresSignature: true,
    validDays: 365,
    serviceIds: [],
  });
  templateId = tpl.templateId;
  templateVersion = tpl.version;

  app = buildServer();
  await app.ready();
  const queue = await kiosk('POST', '/v1/kiosk/walk-in', {
    name: '健康表测试', idempotencyKey: randomUUID(),
  });
  formQueueId = queue.json().queueId;
});

afterAll(async () => {
  await app?.close();
  await withTenant(tenant, async (tx) => {
    // 健康表不可删除（sql/0016 的触发器）—— 测试数据同样只能匿名化。
    // 这正好也验证了那条触发器是活的
    await tx`update form_submissions set answers_encrypted = null, anonymized_at = now(), queue_id = null
             where location_id = ${NAIL_LOC}`;
    await tx`delete from walkin_queue where location_id = ${NAIL_LOC}`;
    await tx`delete from device_tokens where location_id = ${NAIL_LOC}`;
  });
  await closeDb();
});

const run = async <T>(name: string, input: unknown, key: string = randomUUID()) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

const kiosk = (method: 'GET' | 'POST', url: string, payload?: unknown, token = deviceToken) =>
  app.inject({
    method, url,
    headers: { 'content-type': 'application/json', 'x-device-token': token },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

const kioskForm = (payload: Record<string, unknown>, idempotencyKey = randomUUID()) =>
  kiosk('POST', '/v1/kiosk/forms/submit', {
    ...payload, queueId: formQueueId, idempotencyKey,
  });

describe('Kiosk 健康表选择', () => {
  it('只返回门店业态对应的 Web 已发布模板', async () => {
    const res = await kiosk('GET', `/v1/kiosk/forms/required?queueId=${formQueueId}`);
    expect(res.statusCode).toBe(200);
    const forms = res.json().forms as Array<{ key: string }>;
    expect(forms.length).toBeLessThanOrEqual(1);
    expect(forms.every((form) => form.key === 'nail_pedicure_intake')).toBe(true);
  });

  it('顾客预约签到时弹出健康表，签署后不再重复弹出', async () => {
    const [appt] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from appointments where location_id = ${NAIL_LOC} limit 1`);
    const apptId = appt!.id;

    const apptRes = await kiosk('GET', `/v1/kiosk/forms/required?appointmentId=${apptId}`);
    expect(apptRes.statusCode).toBe(200);
    const forms = apptRes.json().forms as Array<{ templateId: string; key: string }>;
    expect(forms.length).toBe(1);
    expect(forms[0]!.key).toBe('nail_pedicure_intake');

    // 模拟顾客签到时提交健康表
    const submitRes = await kiosk('POST', '/v1/kiosk/forms/submit', {
      templateId: forms[0]!.templateId,
      appointmentId: apptId,
      answers: { pregnant: false, allergies: ['无'] },
      signerName: 'Emily Watson',
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      idempotencyKey: randomUUID(),
    });
    expect(submitRes.statusCode).toBe(200);

    // 提交后再次请求，不再重复弹出
    const recheckRes = await kiosk('GET', `/v1/kiosk/forms/required?appointmentId=${apptId}`);
    expect(recheckRes.statusCode).toBe(200);
    expect(recheckRes.json().forms.length).toBe(0);
  });

  it('关闭后不再派发且队列不提醒，但跨店对象仍先按 404 拒绝', async () => {
    const [foreignAppointment] = await withTenant(spaTenant, (tx) => tx<{ id: string }[]>`
      select id from appointments where location_id = ${SPA_LOC} limit 1`);
    await withTenant(tenant, (tx) => tx`
      update locations set settings = jsonb_set(
        settings, '{features,health_forms_enabled}', 'false'::jsonb, true
      ) where id = ${NAIL_LOC}`);
    try {
      const own = await kiosk('GET', `/v1/kiosk/forms/required?queueId=${formQueueId}`);
      expect(own.statusCode).toBe(200);
      expect(own.json().forms).toEqual([]);

      const queue = await withTenant(tenant, (tx) => loadQueue(tx, ctx, todayDate()));
      expect(queue.waiting.find((item) => item.queueId === formQueueId)?.pendingForms).toBe(0);

      const foreign = await kiosk(
        'GET', `/v1/kiosk/forms/required?appointmentId=${foreignAppointment!.id}`,
      );
      expect(foreign.statusCode).toBe(404);
    } finally {
      await withTenant(tenant, (tx) => tx`
        update locations set settings = jsonb_set(
          settings, '{features,health_forms_enabled}', 'true'::jsonb, true
        ) where id = ${NAIL_LOC}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('打码', () => {
  it('中文留姓，西文留首尾', () => {
    // 够本人一眼认出「这是我」，不够旁边排队的人认出他是谁
    expect(maskName('张丽华')).toBe('张**');
    expect(maskName('Amy Chen')).toBe('A***n');
    expect(maskName('Li')).toBe('L*');
  });

  it('长名字不会泄露中间那一大段', () => {
    expect(maskName('Alexandria Vasquez')).toBe('A***z');
  });
});

describe('设备令牌', () => {
  it('明文只在签发那一次给，库里只有摘要', async () => {
    const [row] = await withTenant(tenant, (tx) => tx<{ token_hash: string }[]>`
      select token_hash from device_tokens where id = ${deviceId}`);
    expect(row!.token_hash).not.toContain(deviceToken);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('真令牌能开机自检', async () => {
    const res = await kiosk('GET', '/v1/kiosk/hello');
    expect(res.statusCode).toBe(200);
    expect(res.json().deviceLabel).toBe('测试用门口 iPad');
    expect(res.json().deviceConfig).toMatchObject({
      requireSignature: expect.any(Boolean),
      suggestedTipPercentages: expect.any(Array),
    });
    // 项目名要整份多语言给出去 —— 客人看的是自己的语言
    expect(Array.isArray(res.json().services)).toBe(true);
  });

  it('⭐ 假令牌进不来', async () => {
    expect((await kiosk('GET', '/v1/kiosk/hello', undefined, 'gfk_totally-made-up')).statusCode)
      .toBe(401);
    expect((await kiosk('GET', '/v1/kiosk/hello', undefined, '')).statusCode).toBe(401);
  });

  it('⭐ 这些路由不吃 Bearer token —— 只认设备令牌', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/kiosk/hello',
      headers: { authorization: 'Bearer whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('心跳会上报遥测、领取后台命令并回执', async () => {
    const queued = await run<{ commandId: string }>('device.queueCommand', {
      deviceId, kind: 'reset_home',
    });
    const heartbeat = await kiosk('POST', '/v1/kiosk/heartbeat', {
      model: 'Test Tablet', batteryLevel: 81, wifiSignalDbm: -48, appVersion: '2.5.0',
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().commands).toContainEqual(expect.objectContaining({
      commandId: queued.commandId, kind: 'reset_home',
    }));

    const ack = await kiosk('POST', `/v1/kiosk/commands/${queued.commandId}/ack`, {
      status: 'acknowledged',
    });
    expect(ack.statusCode).toBe(200);
    const [row] = await withTenant(tenant, (tx) => tx<{
      model: string; battery_level: number; status: string;
    }[]>`
      select d.model, d.battery_level, c.status
      from device_tokens d join device_commands c on c.device_id = d.id
      where d.id = ${deviceId} and c.id = ${queued.commandId}`);
    expect(row).toMatchObject({ model: 'Test Tablet', battery_level: 81, status: 'acknowledged' });
  });

  it('⭐ 吊销之后立刻用不了 —— iPad 丢了就是靠这个', async () => {
    const tmp = await run<{ deviceId: string; token: string }>(
      'device.issueToken', { label: '临时设备' });
    expect((await kiosk('GET', '/v1/kiosk/hello', undefined, tmp.token)).statusCode).toBe(200);

    await run('device.revokeToken', { deviceId: tmp.deviceId });
    expect((await kiosk('GET', '/v1/kiosk/hello', undefined, tmp.token)).statusCode).toBe(401);
  });

  it('⭐ 设备令牌维度只看得到自己那一行，翻不出设备表', async () => {
    const { withDeviceToken } = await import('@gf/db');
    const { hashDeviceToken } = await import('./kiosk/deviceAuth');
    const row = await withDeviceToken(hashDeviceToken(deviceToken));
    expect(row?.id).toBe(deviceId);
  });
});

describe('⭐ 签到不是一个客户查询接口', () => {
  it('只在【当天有预约】的人里面找 —— 翻不出老客户', async () => {
    __resetRateLimit();
    // 种子库里有客户，但今天多半没预约。查不到才是对的：
    // 能查到的话，站在门口输一串号码就能知道谁是这家店的客人
    const res = await kiosk('POST', '/v1/kiosk/check-in/lookup', { phone: '5125550000' });
    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toEqual([]);
  });

  it('号码太短直接拒 —— 后四位太好枚举', async () => {
    __resetRateLimit();
    const res = await kiosk('POST', '/v1/kiosk/check-in/lookup', { phone: '1234' });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('phone_too_short');
  });

  it('⭐ 限频：一分钟 20 次以上就是有人在试号码', async () => {
    __resetRateLimit();
    let blocked = false;
    for (let i = 0; i < 25; i++) {
      const res = await kiosk('POST', '/v1/kiosk/check-in/lookup', { phone: '5125551234' });
      if (res.statusCode === 400 && res.json().details?.reason === 'too_many_attempts') {
        blocked = true; break;
      }
    }
    expect(blocked).toBe(true);
    __resetRateLimit();
  }, 120_000);
});

describe('⭐ Kiosk 的权限窄到只有两条', () => {
  const kioskCtx = () => ({
    ...ctx, membershipId: null, actorKind: 'system' as const,
    permissions: new Set(['queue.join', 'form.submit'] as const),
  });

  it('建不了预约', async () => {
    await expect(dispatch('appointment.create', {
      customerId: null,
      items: [{ serviceId: randomUUID(), startsAt: new Date().toISOString() }],
    }, kioskCtx() as typeof ctx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('⭐ 叫不了号 —— 客人不能把自己叫到前面去', async () => {
    await expect(dispatch('queue.update',
      { queueId: randomUUID(), status: 'called' },
      kioskCtx() as typeof ctx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('⭐ 配不了新设备 —— 不然一台失窃的 iPad 能繁殖', async () => {
    await expect(dispatch('device.issueToken', { label: 'evil' },
      kioskCtx() as typeof ctx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('⭐ queue.join 的 requestedStaffId 是 membership id', () => {
  /*
   * 契约上只写着 `requestedStaffId: uuid`，没说是 membership 还是
   * staff_profile 的 id —— 前端问过这个。答案是 **membership id**，
   * 而且这不是约定俗成：`staff_profiles` 的主键**就是** `membership_id`
   * （它没有自己的 id 列），`walkin_queue.requested_staff_id` 的外键也直接
   * 指向 `memberships.id`。日程快照 `staff[].membershipId` 可以原样传。
   *
   * 这一组同时守着「传错不能是 500」：在这之前，一个不存在的 uuid 会撞外键，
   * 整条命令抛成 500 INTERNAL —— 前端看到「系统炸了」，而真相是
   * 「这个技师不存在」，一个它自己能修的错。
   */
  const joinWith = (requestedStaffId: string | null) => run<{ queueId: string }>(
    'queue.join',
    { walkInName: `点名测试 ${randomUUID().slice(0, 8)}`, requestedStaffId,
      partySize: 1, source: 'desk' });

  it('传日程快照里的 membershipId → 成功，而且原样落库', async () => {
    const [linh] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select membership_id as id from staff_profiles
      where location_id = ${NAIL_LOC} and display_name->>'en' = 'Linh'`);

    const out = await joinWith(linh!.id);
    const [row] = await withTenant(tenant, (tx) => tx<{ s: string | null }[]>`
      select requested_staff_id as s from walkin_queue where id = ${out.queueId}`);
    expect(row!.s).toBe(linh!.id);
  });

  it('⭐ 不存在的 uuid → NOT_FOUND，不是 500', async () => {
    await expect(joinWith('11111111-2222-4333-8444-555555555555'))
      .rejects.toMatchObject({ code: 'NOT_FOUND', details: { entity: 'staff' } });
  });

  it('⭐ 同一个 org 里**另一家店**的技师也要拒 —— 外键拦不住这个', async () => {
    /*
     * 外键只认 `memberships.id`，不认 location。不自己验一道的话，
     * 这条 walk-in 会点上一个今天根本不在这家店的技师，
     * 一直到前台准备派单才发现。
     */
    const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const [yan] = await withTenant(
      { orgId: '22222222-2222-4222-8222-222222222222', locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        select membership_id as id from staff_profiles where location_id = ${SPA_LOC} limit 1`);

    await expect(joinWith(yan!.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND', details: { entity: 'staff' } });
  });

  it('不点名（null）照常进队列', async () => {
    await expect(joinWith(null)).resolves.toBeTruthy();
  });
});

describe('走单队列', () => {
  it('取号从 1 开始，按营业日重新数', async () => {
    __resetRateLimit();
    const res = await kiosk('POST', '/v1/kiosk/walk-in',
      { name: '陈女士', partySize: 2, idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketNumber).toBeGreaterThanOrEqual(1);
    expect(res.json().quotedWaitMin).toBeGreaterThanOrEqual(0);
    expect(res.json().appointmentId).toMatch(/^[0-9a-f-]{36}$/i);

    const [visit] = await withTenant(tenant, (tx) => tx<{
      appointment_id: string; source: string; status: string;
    }[]>`
      select q.appointment_id, a.source, a.status
      from walkin_queue q
      join appointments a on a.id = q.appointment_id
      where q.id = ${res.json().queueId}`);
    expect(visit).toMatchObject({
      appointment_id: res.json().appointmentId,
      source: 'walkin',
      status: 'checked_in',
    });
  });

  it('⭐ 号码不重复 —— 同时取号不会拿到同一个号', async () => {
    // 不加锁的话两个人同时点「取号」会拿到同一个号，
    // 唯一索引挡住其中一个，而客人看到的是一个莫名其妙的错误
    __resetRateLimit();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) =>
      kiosk('POST', '/v1/kiosk/walk-in', { name: `并发${i}`, idempotencyKey: randomUUID() })));

    const numbers = results.map((r) => r.json().ticketNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('⭐ 幂等：网差重试不会变成两个号', async () => {
    // 客人手上会拿到两张纸，前台会喊两次 —— 门口那台 iPad 的网是店里最差的
    __resetRateLimit();
    const key = randomUUID();
    const a = await kiosk('POST', '/v1/kiosk/walk-in', { name: '重试测试', idempotencyKey: key });
    const b = await kiosk('POST', '/v1/kiosk/walk-in', { name: '重试测试', idempotencyKey: key });
    expect(a.json().ticketNumber).toBe(b.json().ticketNumber);
    expect(a.json().appointmentId).toBe(b.json().appointmentId);
  });

  it('客人能查自己前面还有几位', async () => {
    __resetRateLimit();
    const joined = await kiosk('POST', '/v1/kiosk/walk-in',
      { name: '查询测试', idempotencyKey: randomUUID() });
    const res = await kiosk('GET', `/v1/kiosk/queue/${joined.json().queueId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('waiting');
    expect(typeof res.json().aheadCount).toBe('number');
  });

  it('前台看得到队列，并且能叫号', async () => {
    const before = await withTenant(tenant, (tx) => loadQueue(tx, ctx, todayDate()));
    expect(before.waiting.length).toBeGreaterThan(0);

    const first = before.waiting[0]!;
    await run('queue.update', { queueId: first.queueId, status: 'called' });

    const after = await withTenant(tenant, (tx) => loadQueue(tx, ctx, todayDate()));
    expect(after.called.some((e) => e.queueId === first.queueId)).toBe(true);
  });

  it('⭐ Kiosk 选中的项目价格与时长原样进入前台队列', async () => {
    __resetRateLimit();
    const [service] = await withTenant(tenant, (tx) => tx<{
      id: string; duration_min: number; base_price_cents: number;
    }[]>`
      select id, duration_min, base_price_cents from services
      where location_id = ${NAIL_LOC} and active
      order by sort limit 1`);
    const joined = await kiosk('POST', '/v1/kiosk/walk-in', {
      name: '价格时长透传测试', serviceId: service!.id, idempotencyKey: randomUUID(),
    });
    expect(joined.statusCode).toBe(200);

    const queue = await withTenant(tenant, (tx) => loadQueue(tx, ctx, todayDate()));
    const entry = queue.waiting.find((item) => item.queueId === joined.json().queueId);
    expect(entry).toMatchObject({
      serviceId: service!.id,
      serviceDurationMin: service!.duration_min,
      servicePriceCents: service!.base_price_cents,
    });
    expect(entry!.items?.[0]).toMatchObject({
      serviceId: service!.id,
      durationMin: service!.duration_min,
      basePriceCents: service!.base_price_cents,
    });
  });

  it('⭐ 标记「走了」必须给原因 —— 等太久走的是老板最该看到的数', async () => {
    const q = await withTenant(tenant, (tx) => loadQueue(tx, ctx, todayDate()));
    const target = q.waiting[0]!;

    await expect(run('queue.update', { queueId: target.queueId, status: 'left' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await run('queue.update', {
      queueId: target.queueId, status: 'left', leftReason: 'waited_too_long',
    });
  });
});

describe('健康表', () => {
  const answers = {
    pregnant: true,
    conditions: ['surgery'],
    note: '腰部两个月前动过手术，避开',
  };

  it('⭐ 答案在库里是密文 —— 拖库也拿不到健康数据', async () => {
    __resetRateLimit();
    const res = await kioskForm({
      templateId, answers,
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      signerName: '陈女士', locale: 'zh-Hans',
    });
    expect(res.statusCode).toBe(200);

    const [row] = await withTenant(tenant, (tx) => tx<{
      answers_encrypted: Buffer; signature_encrypted: Buffer; signature_url: string | null;
      enc_alg: string; locale: string; source: string;
    }[]>`
      select answers_encrypted, signature_encrypted, signature_url, enc_alg, locale, source
      from form_submissions
      where id = ${res.json().submissionId}`);

    const blob = Buffer.from(row!.answers_encrypted);
    expect(blob.toString('latin1')).not.toContain('腰部');
    expect(blob.toString('latin1')).not.toContain('pregnant');
    expect(row!.enc_alg).toBe('aes-256-gcm.v1');
    expect(row!.signature_url).toBeNull();
    expect(Buffer.from(row!.signature_encrypted).toString('latin1')).not.toContain('iVBORw0KGgo');

    // 有钥匙才解得开
    expect(decryptAnswers(blob, loadFormKey(process.env['FORM_ENCRYPTION_KEY'])))
      .toEqual(answers);
    expect(decryptAnswers(
      Buffer.from(row!.signature_encrypted),
      loadFormKey(process.env['FORM_ENCRYPTION_KEY']),
    )).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('⭐ 留下他当时看的是哪种语言 ——「我看不懂英文」是最常见的抗辩', async () => {
    const [row] = await withTenant(tenant, (tx) => tx<{ locale: string; source: string }[]>`
      select locale, source from form_submissions
      where location_id = ${NAIL_LOC} order by created_at desc limit 1`);
    expect(row!.locale).toBe('zh-Hans');
    expect(row!.source).toBe('kiosk');
  });

  it('⭐ 必答题漏答被服务端挡下，不只靠前端', async () => {
    // 「怀孕了吗」漏答和答「否」在法律上完全不是一回事
    __resetRateLimit();
    const res = await kioskForm({
      templateId, answers: { note: '什么都没答' },
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      signerName: '张先生', locale: 'en',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.missing).toContain('pregnant');
  });

  it('要签字的表没签字交不了', async () => {
    __resetRateLimit();
    const res = await kioskForm({
      templateId, answers: { pregnant: false }, signerName: '张先生', locale: 'en',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('signature_required');
  });

  it('⭐ 审计里留动作不留内容', async () => {
    // 前面辛辛苦苦加了密，审计里再存一份明文等于白做
    const [log] = await withTenant(tenant, (tx) => tx<{ after: Record<string, unknown> }[]>`
      select after from audit_log
      where location_id = ${NAIL_LOC} and command = 'form.submit'
      order by at desc limit 1`);

    expect(log!.after['templateKey']).toBe('intake');
    expect(log!.after['locale']).toBe('zh-Hans');
    expect(JSON.stringify(log!.after)).not.toContain('腰部');
    expect(log!.after['answers']).toBeUndefined();
  });

  it('⭐ Kiosk 健康表重试幂等，并关联队列与设备审计', async () => {
    __resetRateLimit();
    const key = randomUUID();
    const payload = {
      templateId, answers: { pregnant: false },
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      signerName: '幂等测试', locale: 'zh-Hans',
    };
    const first = await kioskForm(payload, key);
    const replay = await kioskForm(payload, key);
    expect(replay.json().submissionId).toBe(first.json().submissionId);

    const [row] = await withTenant(tenant, (tx) => tx<{
      queue_id: string; actor_device_id: string;
    }[]>`
      select s.queue_id, a.actor_device_id
      from form_submissions s
      join audit_log a on a.entity_id = s.id and a.command = 'form.submit'
      where s.id = ${first.json().submissionId}`);
    expect(row).toMatchObject({ queue_id: formQueueId, actor_device_id: deviceId });
  });

  it('模板改内容会发新版本，老签名仍指向他当时签的那一版', async () => {
    const v2 = await run<{ version: number }>('catalog.saveFormTemplate', {
      key: 'intake',
      title: { 'zh-Hans': '健康与免责声明（第二版）', en: 'Waiver v2' },
      questions: [{ id: 'pregnant', type: 'bool', required: true,
                    label: { 'zh-Hans': '是否怀孕？', en: 'Pregnant?' } }],
      requiresSignature: true, validDays: 365, serviceIds: [],
    });
    expect(v2.version).toBeGreaterThan(1);

    // ⚠️ 不能写死成 1：这个测试反复跑，每次 beforeAll 都会发一个新版本。
    // 要断言的是「老提交仍然指向它当时签的那一版」，不是「那一版号是 1」
    expect(v2.version).toBe(templateVersion + 1);

    const [old] = await withTenant(tenant, (tx) => tx<{ template_version: number }[]>`
      select template_version from form_submissions
      where location_id = ${NAIL_LOC} and template_id = ${templateId} limit 1`);
    expect(old!.template_version).toBe(templateVersion);
  });

  it('⭐ 已发布的模板改不动 —— 证据链不能就地改', async () => {
    await expect(withTenant(tenant, (tx) => tx`
      update form_templates set schema = '[]'::jsonb
      where id = ${templateId}`)).rejects.toThrow();
  });

  it('⭐ 健康表删不掉，只能匿名化（宪法第 9 条）', async () => {
    await expect(withTenant(tenant, (tx) => tx`
      delete from form_submissions where location_id = ${NAIL_LOC}`)).rejects.toThrow();
  });
});

/**
 * 门店此刻的营业日。
 *
 * ⚠️ **必须用和生产同一个 `businessDateOf`**（宪法第 2 条：一份实现）。
 *
 * 上一版是自己拼的：
 * ```ts
 * new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
 *   .toISOString().slice(0, 10)
 * ```
 * 它在**东部时间 20:00 之后就多算一天** —— `toISOString()` 把 ET 的晚上
 * 换回 UTC，日期就翻了。于是「前台看得到队列」那两条用例
 * **只在下午之前跑得过**，晚上跑或者 CI 排在晚上就红，
 * 而报错是「队列是空的」，看起来完全像是取号那条路坏了。
 *
 * 时间的事只信 `@gf/scheduling`（宪法第 8 条）。
 */
function todayDate(): string {
  return businessDateOf(new Date(), STORE_TZ, STORE_CUTOFF);
}

/** 种子数据里两家店都在东部时间，营业日切换点凌晨四点（见 packages/db/src/seed.ts） */
const STORE_TZ = 'America/New_York';
const STORE_CUTOFF = '04:00:00';
