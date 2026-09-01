/**
 * 退信 / 投诉回流与抑制名单（sql/0091 + `email/resendWebhook.ts`）。
 *
 * 这一组守的是两件相反的事：
 *
 *   · **硬退与投诉必须拦住**，否则每一次预约都再退信一次、每个月都再被
 *     投诉一次，而扣的是发信域名的信誉 —— 信誉掉下去之后受损的是所有
 *     门店的事务性邮件送达率，那件事没有任何人会来投诉；
 *   · **软退绝不能拦**，一次对方服务器抖动不该让顾客永远收不到预约确认。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import {
  sql, withTenant, closeDb,
  emailSuppressed, suppressEmail, emailSuppressedSet,
} from '@gf/db';
import {
  verifySvixSignature, bounceIsHard, handleResendEvent, type ResendEvent,
} from './email/resendWebhook';
import { flushEmails } from './email/flush';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const SECRET_RAW = Buffer.from('gf-test-webhook-secret-0123456789').toString('base64');
const touched: string[] = [];

function addr(tag: string): string {
  const e = `${tag}-${randomUUID().slice(0, 8)}@example.test`;
  touched.push(e);
  return e;
}

function bounceEvent(to: string, type: string, providerId?: string): ResendEvent {
  return {
    type: 'email.bounced',
    data: {
      email_id: providerId ?? randomUUID(),
      to: [to],
      bounce: { type, subType: 'General', message: 'stub' },
    },
  };
}

beforeAll(() => {
  process.env['RESEND_WEBHOOK_SECRET'] = `whsec_${SECRET_RAW}`;
});

afterAll(async () => {
  if (touched.length > 0) {
    // ⚠️ app_user 对抑制名单没有 delete 权限（0091：解除抑制是一次要人
    //    负责的决定）。测试用 admin 连接不到，这里只能留下这些 @example.test
    //    的行 —— 它们对任何真实地址都没有影响。
  }
  await closeDb();
});

describe('Svix 验签', () => {
  const id = 'msg_test';
  const body = '{"type":"email.bounced"}';

  function sign(ts: number, secret = SECRET_RAW): string {
    return `v1,${createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(`${id}.${ts}.${body}`).digest('base64')}`;
  }

  it('签名正确且时间戳在容差内才通过', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifySvixSignature({
      id, timestamp: String(ts), signature: sign(ts), rawBody: body,
    })).toBe(true);
  });

  it('🔴 签名不对一律拒绝', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifySvixSignature({
      id, timestamp: String(ts), signature: 'v1,bm9wZQ==', rawBody: body,
    })).toBe(false);
  });

  /**
   * ⚠️ 不校验时间戳的话，一条被截获的旧回调可以被无限重放 ——
   * 而这条路由能把任意地址写进抑制名单。
   */
  it('🔴 超出 5 分钟容差的重放拒绝', () => {
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    expect(verifySvixSignature({
      id, timestamp: String(old), signature: sign(old), rawBody: body,
    })).toBe(false);
  });

  it('🔴 正文被改过就对不上', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifySvixSignature({
      id, timestamp: String(ts), signature: sign(ts), rawBody: `${body} ` ,
    })).toBe(false);
  });

  /**
   * ⭐ 密钥轮换期 Svix 会同时带上新旧两个签名。只比第一个的话，
   * 轮换那几分钟里所有回调都会被拒。
   */
  it('⭐ 多个候选签名里命中任意一个即可', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifySvixSignature({
      id, timestamp: String(ts),
      signature: `v1,bm9wZQ== ${sign(ts)}`,
      rawBody: body,
    })).toBe(true);
  });

  it('🔴 没配密钥时一律拒绝，而不是放行', () => {
    const saved = process.env['RESEND_WEBHOOK_SECRET'];
    delete process.env['RESEND_WEBHOOK_SECRET'];
    const ts = Math.floor(Date.now() / 1000);
    expect(verifySvixSignature({
      id, timestamp: String(ts), signature: sign(ts), rawBody: body,
    })).toBe(false);
    process.env['RESEND_WEBHOOK_SECRET'] = saved;
  });
});

describe('硬退与软退', () => {
  it('Permanent 才算硬退', () => {
    expect(bounceIsHard(bounceEvent('x@example.test', 'Permanent'))).toBe(true);
  });

  /**
   * 🔴 软退绝不能进抑制名单：一次对方服务器抖动会让这个顾客
   * **永远**收不到预约确认，而那是静默的。
   */
  it('🔴 Transient 与 Undetermined 都不算 —— 拿不准时少拦比多拦安全', () => {
    expect(bounceIsHard(bounceEvent('x@example.test', 'Transient'))).toBe(false);
    expect(bounceIsHard(bounceEvent('x@example.test', 'Undetermined'))).toBe(false);
    expect(bounceIsHard({ type: 'email.bounced', data: { to: ['x@example.test'] } })).toBe(false);
  });

  it('硬退进抑制名单，软退不进', async () => {
    const hard = addr('hard');
    const soft = addr('soft');

    await handleResendEvent(bounceEvent(hard, 'Permanent'));
    await handleResendEvent(bounceEvent(soft, 'Transient'));

    expect(await emailSuppressed(hard)).toBe(true);
    expect(await emailSuppressed(soft)).toBe(false);
  });

  it('地址大小写不同算同一个收件人', async () => {
    const e = addr('Case');
    await suppressEmail({ email: e.toUpperCase(), reason: 'hard_bounce' });
    expect(await emailSuppressed(e.toLowerCase())).toBe(true);
    expect((await emailSuppressedSet([e.toUpperCase()])).size).toBe(1);
  });
});

describe('投诉', () => {
  it('进抑制名单，并关掉这个地址的营销订阅', async () => {
    const e = addr('spam');
    const customerId = await withTenant(tenant, async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into customers
          (org_id, primary_location_id, display_name, email, marketing_email_opt_in)
        values (${NAIL_ORG}, ${NAIL_LOC}, 'Complainer', ${e}, true)
        returning id`;
      return c!.id;
    });

    await handleResendEvent({ type: 'email.complained', data: { to: [e] } });

    expect(await emailSuppressed(e)).toBe(true);
    const [row] = await withTenant(tenant, (tx) => tx<{ opt: boolean }[]>`
      select marketing_email_opt_in as opt from customers where id = ${customerId}`);
    expect(row?.opt).toBe(false);

    await withTenant(tenant, (tx) => tx`delete from customers where id = ${customerId}`);
  });

  /**
   * ⚠️ 投诉比硬退更强：先硬退后投诉要升级成 complaint。
   * 反过来不降级 —— 已经投诉过的地址不该因为一次退信变回「只是退信」。
   */
  it('reason 只升级不降级', async () => {
    const e = addr('esc');
    await suppressEmail({ email: e, reason: 'hard_bounce' });
    await suppressEmail({ email: e, reason: 'complaint' });
    const [a] = await sql<{ reason: string }[]>`
      select reason from email_suppressions where email = ${e}`;
    expect(a?.reason).toBe('complaint');

    await suppressEmail({ email: e, reason: 'hard_bounce' });
    const [b] = await sql<{ reason: string }[]>`
      select reason from email_suppressions where email = ${e}`;
    expect(b?.reason).toBe('complaint');
  });
});

describe('投递前的抑制拦截', () => {
  /**
   * 🔴 这是整条链路的落点：名单里有，就一封都不许发出去。
   */
  it('🔴 抑制名单里的地址不会被投递', async () => {
    const e = addr('blocked');
    await suppressEmail({ email: e, reason: 'hard_bounce' });

    const entityId = randomUUID();
    await withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'platform_notice', ${e},
              's', 'h', 't', 'suppressprobe', ${entityId})`);

    await flushEmails(tenant);

    const [row] = await withTenant(tenant, (tx) => tx<{
      status: string; last_error: string | null;
    }[]>`select status, last_error from email_outbox where entity_id = ${entityId}`);
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('suppressed');
  });

  it('没被抑制的照常投递', async () => {
    const e = addr('clean');
    const entityId = randomUUID();
    await withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'platform_notice', ${e},
              's', 'h', 't', 'suppressprobe', ${entityId})`);

    await flushEmails(tenant);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from email_outbox where entity_id = ${entityId}`);
    // 测试进程里投递走 capture 替身
    expect(row?.status).toBe('captured');
  });
});

describe('投递结果写回', () => {
  /**
   * ⚠️ 只动 `delivery_state`，**不动 `status`**。
   *
   * `status` 是重试逻辑的依据；把退信写回 `failed` 会让补发扫描把一封
   * **已经发出去过**的信再发一遍。
   */
  it('🔴 退信写回不会把 status 改掉', async () => {
    const providerId = `stub_${randomUUID()}`;
    const entityId = randomUUID();
    await withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id, status, provider_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'platform_notice', ${addr('wb')},
              's', 'h', 't', 'writeback', ${entityId}, 'sent', ${providerId})`);

    await handleResendEvent({
      type: 'email.bounced',
      data: { email_id: providerId, to: [addr('wb2')], bounce: { type: 'Permanent' } },
    });

    const [row] = await withTenant(tenant, (tx) => tx<{
      status: string; delivery_state: string | null;
    }[]>`select status, delivery_state from email_outbox where entity_id = ${entityId}`);
    expect(row?.status).toBe('sent');
    expect(row?.delivery_state).toBe('hard_bounce');
  });

  it('送达也写回', async () => {
    const providerId = `stub_${randomUUID()}`;
    const entityId = randomUUID();
    await withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id, status, provider_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'platform_notice', ${addr('ok')},
              's', 'h', 't', 'writeback', ${entityId}, 'sent', ${providerId})`);

    await handleResendEvent({ type: 'email.delivered', data: { email_id: providerId } });

    const [row] = await withTenant(tenant, (tx) => tx<{ delivery_state: string | null }[]>`
      select delivery_state from email_outbox where entity_id = ${entityId}`);
    expect(row?.delivery_state).toBe('delivered');
  });

  it('认不出的事件类型安静忽略', async () => {
    expect(await handleResendEvent({ type: 'email.opened', data: {} }))
      .toEqual({ handled: 'ignored' });
  });
});
