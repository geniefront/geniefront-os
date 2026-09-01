/**
 * 健康表：生成 / 存储 / 同步 / 分享（`docs/15`）。
 *
 * 这一份里的每个用例都在问同一类问题 —— **捡到这条链接的人能干什么**，
 * 以及**谁看过这张表**：
 *
 *   · 明文令牌是不是只出现一次（是，库里只有摘要）
 *   · 过期 / 吊销 / 已填完的链接还能不能用（不能，而且报的是同一句）
 *   · 请求体里塞一个别人的 customerId 有没有用（没有，客人由链接决定）
 *   · 链接没点名的模板能不能借它签一份（不能）
 *   · 读一份已签的表会不会留痕（会，而且先留痕再解密）
 *   · 回填客户档案会不会把健康明细搬出加密表（不会，只有部位和一个布尔）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { buildServer } from './server';
import { readSubmission, loadForms } from './queries/forms';
import './handlers/kiosk';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let app: ReturnType<typeof buildServer>;
let templateId = '';
let otherTemplateId = '';
let customerId = '';

beforeAll(async () => {
  process.env['FORM_ENCRYPTION_KEY'] ??= randomBytes(32).toString('hex');

  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  const [c] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from customers where org_id = ${NAIL_ORG} limit 1`);
  customerId = c!.id;

  // ⭐ 带 sync 映射的模板：这正是「同步」那一段要验的
  const tpl = await run<{ templateId: string }>('catalog.saveFormTemplate', {
    key: 'share_intake',
    title: { 'zh-Hans': '健康问卷', en: 'Health Intake' },
    questions: [
      { id: 'pregnant', type: 'bool', required: true, sync: 'health_flag',
        label: { 'zh-Hans': '是否怀孕？', en: 'Are you pregnant?' } },
      { id: 'avoid', type: 'multi', required: false, sync: 'avoid_areas',
        label: { 'zh-Hans': '哪里不要按', en: 'Areas to avoid' },
        options: [
          { value: 'left_knee', label: { 'zh-Hans': '左膝', en: 'Left knee' } },
          { value: 'lower_back', label: { 'zh-Hans': '下背', en: 'Lower back' } },
        ] },
      { id: 'note', type: 'text', required: false,
        label: { 'zh-Hans': '其他', en: 'Anything else' } },
      { id: 'internal_only', type: 'text', required: true, hidden: true,
        label: { 'zh-Hans': '内部预留题', en: 'Internal reserved question' } },
    ],
    requiresSignature: false,
    validDays: 365,
    serviceIds: [],
  });
  templateId = tpl.templateId;

  const other = await run<{ templateId: string }>('catalog.saveFormTemplate', {
    key: 'share_consent',
    title: { 'zh-Hans': '刮痧留痕同意', en: 'Gua Sha Marking Consent' },
    questions: [{ id: 'agree', type: 'bool', required: true,
                  label: { 'zh-Hans': '已告知并同意', en: 'Informed and agree' } }],
    requiresSignature: false,
    validDays: null,
    serviceIds: [],
  });
  otherTemplateId = other.templateId;

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await withTenant(tenant, async (tx) => {
    // 健康表不可删除（sql/0016 的触发器）—— 测试数据同样只能匿名化
    await tx`update form_submissions set answers_encrypted = null, anonymized_at = now()
             where location_id = ${NAIL_LOC}`;
    await tx`update form_share_links set revoked_at = now()
             where location_id = ${NAIL_LOC} and revoked_at is null`;
    await tx`update customer_preferences set profile = profile - 'health_flag' - 'avoid_areas'
             where customer_id = ${customerId}`;
  });
  await closeDb();
});

const run = async <T>(name: string, input: unknown, key: string = randomUUID()) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

const link = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
  app.inject({
    method, url,
    headers: { 'content-type': 'application/json', 'x-gf-form-token': token },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

interface Share { shareId: string; token: string; url: string; qrSvg: string; emailQueued: boolean }

const share = (input: Record<string, unknown> = {}) =>
  run<Share>('form.share', { templateIds: [templateId], customerId, ...input });

// ═══════════════════════════════════════════════════════════════════════════

describe('分享：令牌', () => {
  it('明文只在生成那一次给，库里只有摘要', async () => {
    const s = await share();
    expect(s.token).toMatch(/^fs_[A-Za-z0-9_-]+$/);

    const [row] = await withTenant(tenant, (tx) => tx<{ token_hash: string }[]>`
      select token_hash from form_share_links where id = ${s.shareId}`);
    expect(row!.token_hash).not.toContain(s.token);
    expect(row!.token_hash).toBe(createHash('sha256').update(s.token).digest('hex'));
  });

  it('二维码是自足的 SVG —— 不引外部图床，也不带脚本', async () => {
    const s = await share();
    expect(s.qrSvg).toContain('<svg');
    expect(s.qrSvg).not.toContain('<script');
    // 只有 xmlns 那一处 http（那是命名空间，不是一次请求）——
    // 没有 <image>、没有外链、没有脚本
    expect(s.qrSvg).not.toContain('<image');
    expect(s.qrSvg).not.toContain('href');
    expect(s.url).toContain(s.token);
  });

  it('⭐ 假令牌进不来', async () => {
    expect((await link('GET', '/public/v1/forms', 'fs_totally-made-up-token-xxxxxxxxxx'))
      .statusCode).toBe(404);
    expect((await link('GET', '/public/v1/forms', '')).statusCode).toBe(404);
  });

  it('⭐ 吊销之后立刻用不了', async () => {
    const s = await share();
    expect((await link('GET', '/public/v1/forms', s.token)).statusCode).toBe(200);
    await run('form.revokeShare', { shareId: s.shareId });
    expect((await link('GET', '/public/v1/forms', s.token)).statusCode).toBe(404);
  });

  it('⭐ 过期之后用不了 —— 而且报的和「不存在」是同一句', async () => {
    const s = await share();
    await withTenant(tenant, (tx) => tx`
      update form_share_links set expires_at = now() - interval '1 hour'
      where id = ${s.shareId}`);
    const res = await link('GET', '/public/v1/forms', s.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().details.reason).toBe('link_unusable');
  });
});

describe('分享：客人那一页看得到什么', () => {
  it('只给打码的名字 —— 捡到链接的人不该知道这家店有个叫什么的客人', async () => {
    const s = await share();
    const body = (await link('GET', '/public/v1/forms', s.token)).json();
    expect(body.maskedName).toMatch(/\*/);
    expect(body.forms).toHaveLength(1);
    expect(body.forms[0].templateId).toBe(templateId);
    // 题目整份多语言给出去 —— 客人在自己手机上还能再换语言
    expect(body.forms[0].title['zh-Hans']).toBe('健康问卷');
  });

  it('⭐ 只给这条链接点名的那几份，不是这家店的全部模板', async () => {
    const s = await share({ templateIds: [otherTemplateId] });
    const body = (await link('GET', '/public/v1/forms', s.token)).json();
    expect(body.forms.map((f: { templateId: string }) => f.templateId)).toEqual([otherTemplateId]);
  });

  it('点开会记 opened_at，前台靠它分辨「没收到」和「收到了没填」', async () => {
    const s = await share();
    await link('GET', '/public/v1/forms', s.token);
    const [row] = await withTenant(tenant, (tx) => tx<{ opened_at: Date | null }[]>`
      select opened_at from form_share_links where id = ${s.shareId}`);
    expect(row!.opened_at).not.toBeNull();
  });

  it('隐藏题保留在模板版本中，但不会下发给顾客', async () => {
    const s = await share();
    const res = await link('GET', '/public/v1/forms', s.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().forms[0].questions.map((q: { id: string }) => q.id))
      .not.toContain('internal_only');
  });
});

describe('分享：交表', () => {
  it('填完落成 source=link 的一份，并把链接封掉', async () => {
    const s = await share();
    const res = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: { pregnant: false }, signerName: 'Amy Chen', locale: 'en',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().done).toBe(true);

    const [sub] = await withTenant(tenant, (tx) => tx<{ source: string; customer_id: string }[]>`
      select source, customer_id from form_submissions
      where id = ${res.json().submissionId}`);
    expect(sub!.source).toBe('link');
    expect(sub!.customer_id).toBe(customerId);

    // 填完即失效 —— 一条链接不能签两遍
    expect((await link('GET', '/public/v1/forms', s.token)).statusCode).toBe(404);
  });

  it('⭐ 请求体里塞别人的 customerId 没有用 —— 客人由链接决定', async () => {
    const s = await share();
    const res = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId,
      customerId: '99999999-9999-4999-8999-999999999999',
      answers: { pregnant: false }, signerName: 'Amy Chen',
    });
    expect(res.statusCode).toBe(200);
    const [sub] = await withTenant(tenant, (tx) => tx<{ customer_id: string }[]>`
      select customer_id from form_submissions where id = ${res.json().submissionId}`);
    expect(sub!.customer_id).toBe(customerId);
  });

  it('⭐ 两条**匿名**链接互不影响 —— A 填完不会把 B 也标成填完了', async () => {
    // 匿名链接的 customer_id 都是 null。按 (customer_id, 时间) 去凑「还剩几份」
    // 的话，`null is not distinct from null` 为真，A 交表会顺手把 B 封掉 ——
    // 而 B 那位客人还没动过手，他点开只会看到「这个链接不能用了」
    const a = await share({ customerId: null, templateIds: [templateId] });
    const b = await share({ customerId: null, templateIds: [templateId] });

    const res = await link('POST', '/public/v1/forms/submit', a.token, {
      templateId, answers: { pregnant: false }, signerName: '匿名甲',
    });
    expect(res.json().done).toBe(true);

    // A 用完了
    expect((await link('GET', '/public/v1/forms', a.token)).statusCode).toBe(404);
    // ⭐ B 还好好的，而且那份表在 B 眼里**还没签**
    const stillOpen = await link('GET', '/public/v1/forms', b.token);
    expect(stillOpen.statusCode).toBe(200);
    expect(stillOpen.json().forms[0].done).toBe(false);
  });

  it('签进来的每一份都记着是从哪条链接来的（证据链）', async () => {
    const s = await share();
    const res = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: { pregnant: false }, signerName: 'Amy Chen',
    });
    const [row] = await withTenant(tenant, (tx) => tx<{ share_link_id: string }[]>`
      select share_link_id from form_submissions where id = ${res.json().submissionId}`);
    expect(row!.share_link_id).toBe(s.shareId);
  });

  it('⭐ 借一条合法链接签它没点名的模板 —— 不行', async () => {
    const s = await share({ templateIds: [templateId] });
    const res = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId: otherTemplateId, answers: { agree: true }, signerName: 'Amy Chen',
    });
    expect(res.statusCode).toBe(404);
  });

  it('必答题漏答照样被服务端挡下 —— 前端挡一次不算数', async () => {
    const s = await share();
    const res = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: {}, signerName: 'Amy Chen',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.missing).toContain('pregnant');
  });
});

describe('⭐ 同步：回填客户档案只搬部位和一个布尔', () => {
  it('勾了部位就并进 avoid_areas；答「否」不置禁忌标记', async () => {
    await withTenant(tenant, (tx) => tx`
      update customer_preferences set profile = profile - 'health_flag' - 'avoid_areas'
      where customer_id = ${customerId}`);

    const s = await share();
    await link('POST', '/public/v1/forms/submit', s.token, {
      templateId,
      answers: { pregnant: false, avoid: ['left_knee'], note: '上个月做过右膝手术' },
      signerName: 'Amy Chen',
    });

    const [pref] = await withTenant(tenant, (tx) => tx<{ profile: Record<string, unknown> }[]>`
      select profile from customer_preferences where customer_id = ${customerId}`);
    expect(pref!.profile['avoid_areas']).toEqual(['left_knee']);
    // 答「没有怀孕」的人不该被标成有禁忌 —— 满屏都是标记的话它就没人看了
    expect(pref!.profile['health_flag']).toBeUndefined();
    // ⭐ 自由文本里的健康明细**没有**被搬出加密表
    expect(JSON.stringify(pref!.profile)).not.toContain('手术');
  });

  it('公共页人体图和健康排查区会同步为操作标记，不搬健康明细', async () => {
    await withTenant(tenant, (tx) => tx`
      update customer_preferences set profile = profile - 'health_flag' - 'avoid_areas'
      where customer_id = ${customerId}`);

    const s = await share();
    const res = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId,
      answers: {
        pregnant: false,
        bodyMapAvoid: ['right_shoulder'],
        conditions: { pacemaker: true },
      },
      signerName: 'Amy Chen',
    });
    expect(res.statusCode).toBe(200);

    const [pref] = await withTenant(tenant, (tx) => tx<{ profile: Record<string, unknown> }[]>`
      select profile from customer_preferences where customer_id = ${customerId}`);
    expect(pref!.profile['avoid_areas']).toContain('right_shoulder');
    expect(pref!.profile['health_flag']).toBe(true);
    expect(JSON.stringify(pref!.profile)).not.toContain('pacemaker');
  });

  it('⭐ 勾了「以上都没有」不算有禁忌 —— 否则满屏标记等于没有标记', async () => {
    await withTenant(tenant, (tx) => tx`
      update customer_preferences set profile = profile - 'health_flag' - 'avoid_areas'
      where customer_id = ${customerId}`);

    const s = await share();
    await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: { pregnant: false, avoid: ['none'] }, signerName: 'Amy Chen',
    });

    const [pref] = await withTenant(tenant, (tx) => tx<{ profile: Record<string, unknown> }[]>`
      select profile from customer_preferences where customer_id = ${customerId}`);
    expect(pref!.profile['health_flag']).toBeUndefined();
    expect(pref!.profile['avoid_areas'] ?? []).toEqual([]);
  });

  it('答「是」置禁忌标记，而且只有一个布尔 —— 明细留在加密表里', async () => {
    await withTenant(tenant, (tx) => tx`
      update customer_preferences set profile = profile - 'health_flag' - 'avoid_areas'
      where customer_id = ${customerId}`);

    const first = await share();
    await link('POST', '/public/v1/forms/submit', first.token, {
      templateId, answers: { pregnant: false, avoid: ['left_knee'] }, signerName: 'Amy Chen',
    });

    const s = await share();
    await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: { pregnant: true, avoid: ['lower_back'] }, signerName: 'Amy Chen',
    });

    const [pref] = await withTenant(tenant, (tx) => tx<{ profile: Record<string, unknown> }[]>`
      select profile from customer_preferences where customer_id = ${customerId}`);
    expect(pref!.profile['health_flag']).toBe(true);
    // ⭐ 只并不减：上一次勾的 left_knee 还在
    expect(pref!.profile['avoid_areas']).toEqual(
      expect.arrayContaining(['left_knee', 'lower_back']));
    expect(JSON.stringify(pref!.profile)).not.toContain('pregnant');
  });
});

describe('⭐ 存储：读一份已签的表会留痕', () => {
  it('没有 customer.view_health_form 一个字都看不到', async () => {
    const s = await share();
    const r = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: { pregnant: false }, signerName: 'Amy Chen',
    });
    const submissionId = r.json().submissionId as string;

    const narrow = { ...ctx, permissions: new Set(['customer.read']) } as typeof ctx;
    await expect(withTenant(tenant, (tx) => readSubmission(tx, narrow, submissionId, 'service_prep')))
      .rejects.toThrow();
  });

  it('看得到的人看一眼就写一行 form_access_log，而且带理由', async () => {
    const s = await share();
    const r = await link('POST', '/public/v1/forms/submit', s.token, {
      templateId, answers: { pregnant: true, note: '孕 28 周' }, signerName: 'Amy Chen',
    });
    const submissionId = r.json().submissionId as string;

    const view = await withTenant(tenant,
      (tx) => readSubmission(tx, ctx, submissionId, 'incident_review'));
    expect(view.answers).toMatchObject({ pregnant: true, note: '孕 28 周' });

    const logs = await withTenant(tenant, (tx) => tx<{ reason: string; membership_id: string }[]>`
      select reason, membership_id from form_access_log where submission_id = ${submissionId}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.reason).toBe('incident_review');
    expect(logs[0]!.membership_id).toBe(ctx.membershipId);
  });

  it('理由不是白名单里的就拒 —— 否则每条日志都会变成「查看」两个字', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/desk/forms/submissions/${randomUUID()}?reason=%E9%9A%8F%E4%BE%BF%E7%9C%8B%E7%9C%8B`,
      headers: { 'x-membership-id': ctx.membershipId! },
    });
    expect([400, 401]).toContain(res.statusCode);
  });
});

describe('存储：前台那张列表', () => {
  it('模板、已签、发出去的链接一次给全，并带上「能不能看内容」', async () => {
    const data = await withTenant(tenant, (tx) => loadForms(tx, ctx, { days: 1 }));
    expect(data.templates.some((t) => t.templateId === templateId)).toBe(true);
    expect(data.canViewContent).toBe(true);
    expect(data.submissions.length).toBeGreaterThan(0);
    expect(data.shares.length).toBeGreaterThan(0);
    // 链接状态是算好的一个词，前台不用自己比四个时间戳
    expect(['pending', 'opened', 'done', 'expired', 'revoked'])
      .toContain(data.shares[0]!.state);
  });

  it('⭐ 没有 customer.view_contact 时邮箱是打码的', async () => {
    await share({ channel: 'email', email: 'amy@maildrop.cc' });
    const narrow = {
      ...ctx, permissions: new Set(['customer.read']),
    } as typeof ctx;
    const data = await withTenant(tenant, (tx) => loadForms(tx, narrow, { days: 1 }));
    const withEmail = data.shares.find((s) => s.sentTo !== null);
    expect(withEmail!.sentTo).toBe('a••••@maildrop.cc');
  });
});

describe('分享：邮件', () => {
  it('渲染好才入队 —— outbox 那一行就是那封信本身', async () => {
    const s = await share({ channel: 'email', email: 'amy@maildrop.cc' });
    expect(s.emailQueued).toBe(true);

    const [mail] = await withTenant(tenant, (tx) => tx<{
      to_email: string; subject: string; body_text: string; kind: string;
    }[]>`
      select to_email, subject, body_text, kind from email_outbox
      where entity_type = 'form_share' and entity_id = ${s.shareId}`);
    expect(mail!.kind).toBe('form_invite');
    expect(mail!.to_email).toBe('amy@maildrop.cc');
    // ⭐ 信里带的是**那一条**令牌，不是发信时再拼一次
    expect(mail!.body_text).toContain(s.token);
  });

  it('选了邮件却没给邮箱 —— 直接拒，不生成一条谁也收不到的链接', async () => {
    await expect(share({ channel: 'email' })).rejects.toThrow();
  });
});
