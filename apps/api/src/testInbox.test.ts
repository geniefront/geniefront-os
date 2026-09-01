/**
 * 测试收件箱（sql/0082）。
 *
 * 盯三件事：
 *   1. capture 下来的消息只有运营人员看得到 —— 里面有客人的邮箱、手机号
 *      和一次性链接，不是「反正是测试数据」就能放开的东西
 *   2. 链接被抽出来了 —— 这一页最主要的用途就是点开那条链接
 *   3. 保留期清理**只删 captured**：真发出去的记录是凭据，一行都不许碰
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { closeDb, withTenant, PLATFORM_OPS_USER_ID } from '@gf/db';
import { purgeCapturedMessages } from './ops/retention';

const OWNER_USER = '196f0ab4-cd94-45cc-8109-2c414e966828';
const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const authUser = { userId: '' as string, email: undefined as string | undefined };

vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(async () => {
      if (!authUser.userId) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
      return { userId: authUser.userId, email: authUser.email };
    }),
  };
});

const { buildServer } = await import('./server');

let app: ReturnType<typeof buildServer>;
const recipient = `qa-${randomUUID().slice(0, 8)}@maildrop.cc`;
const link = 'https://staging-desk.geniefront.com/a/CAPTURE-LINK';
let emailId: string;

beforeAll(async () => {
  const [row] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into email_outbox (org_id, location_id, kind, to_email, subject,
                              body_html, body_text, entity_type, entity_id, status, attempts)
    values (${NAIL_ORG}, ${NAIL_LOC}, 'appointment_confirm', ${recipient},
            'Your appointment is confirmed',
            ${`<p>Hi <a href="${link}">manage booking</a></p>`},
            ${`Hi. Manage your booking: ${link}`},
            'appointment', ${randomUUID()}, 'captured', 1)
    returning id`);
  emailId = row!.id;

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await closeDb();
});

function asUser(userId: string, email?: string) {
  authUser.userId = userId;
  authUser.email = email;
}

describe('测试收件箱', () => {
  it('⚠️ 店主看不到 —— 收件箱是跨租户的，只属于运营人员', async () => {
    asUser(OWNER_USER, 'owner@maildrop.cc');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/test-inbox' });
    expect(r.statusCode).toBe(403);
    expect(r.json().details.reason).toBe('not_platform_operator');
  });

  it('未登录同样打不开', async () => {
    authUser.userId = '';
    const r = await app.inject({ method: 'GET', url: '/v1/platform/test-inbox' });
    expect(r.statusCode).toBe(401);
  });

  it('⭐ 运营人员按收件人查得到，且链接被抽了出来（E2E 的取件口）', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@maildrop.cc');
    const r = await app.inject({
      method: 'GET',
      url: `/v1/platform/test-inbox?search=${encodeURIComponent(recipient)}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      total: number;
      items: Array<{ id: string; channel: string; recipient: string; status: string; links: string[] }>;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]!.channel).toBe('email');
    expect(body.items[0]!.recipient).toBe(recipient);
    expect(body.items[0]!.status).toBe('captured');
    expect(body.items[0]!.links).toEqual([link]);
  });

  it('详情返回整封正文，含 HTML', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@maildrop.cc');
    const r = await app.inject({ method: 'GET', url: `/v1/platform/test-inbox/email/${emailId}` });
    expect(r.statusCode).toBe(200);
    const d = r.json() as { bodyText: string; bodyHtml: string; links: string[] };
    expect(d.bodyText).toContain(link);
    expect(d.bodyHtml).toContain('manage booking');
    // 正文与 HTML 里是同一条链接，只列一次
    expect(d.links).toEqual([link]);
  });

  it('session 带出当前环境与投递模式（这一页靠它解释「为什么是空的」）', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@maildrop.cc');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/session' });
    expect(r.statusCode).toBe(200);
    expect(r.json().comms.deliveryMode).toMatch(/^(live|capture)$/);
  });
});

describe('保留期清理', () => {
  it('⭐ 只删 captured：真发出去的记录一行都不许碰', async () => {
    const sentId = await withTenant(tenant, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into email_outbox (org_id, location_id, kind, to_email, subject,
                                  body_html, body_text, entity_type, entity_id,
                                  status, attempts, created_at, sent_at)
        values (${NAIL_ORG}, ${NAIL_LOC}, 'receipt', ${`sent+${randomUUID().slice(0, 8)}@maildrop.cc`},
                'Receipt', '<p>r</p>', 'r', 'ticket', ${randomUUID()},
                'sent', 1, now() - interval '90 days', now() - interval '90 days')
        returning id`;
      return row!.id;
    });

    const oldCaptured = await withTenant(tenant, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into email_outbox (org_id, location_id, kind, to_email, subject,
                                  body_html, body_text, entity_type, entity_id,
                                  status, attempts, created_at)
        values (${NAIL_ORG}, ${NAIL_LOC}, 'receipt', ${`old+${randomUUID().slice(0, 8)}@maildrop.cc`},
                'Old capture', '<p>c</p>', 'c', 'ticket', ${randomUUID()},
                'captured', 1, now() - interval '90 days')
        returning id`;
      return row!.id;
    });

    const removed = await purgeCapturedMessages(7);
    expect(removed).toBeGreaterThanOrEqual(1);

    const rows = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from email_outbox where id in (${sentId}, ${oldCaptured})`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(sentId);        // 真发出去的还在
    expect(ids).not.toContain(oldCaptured); // 过期的测试消息没了
  });

  it('⚠️ 保留期下限是 1 天：传 0 也删不掉今天刚 capture 的', async () => {
    // 昨天跑的那次测试今天还要能查（和 gf_purge_command_idempotency 同一个套路）
    await purgeCapturedMessages(0);

    const rows = await withTenant(tenant, (tx) => tx`
      select id from email_outbox where id = ${emailId}`);
    expect(rows.length).toBe(1);
  });
});
