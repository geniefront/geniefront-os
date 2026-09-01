/**
 * 退信 / 投诉回流与抑制名单
 * （sql/0091 + `email/resendWebhook.ts` + `email/snsWebhook.ts`）。
 *
 * ⚠️ **两家供应商的回调都要覆盖。** 发信当前走 Resend（SES 还在沙箱），
 * 但两条路由始终都注册 —— 切换供应商之后，旧供应商仍会为切换前发出的邮件
 * 投递回调，退信可能晚几小时到几天才到。只测一条的话，另一条在真正需要它的
 * 那几天里没有任何保护，而它写的是抑制名单。
 *
 * 这一组守的是两件相反的事：
 *
 *   · **硬退与投诉必须拦住**，否则每一次预约都再退信一次、每个月都再被
 *     投诉一次，而扣的是发信域名的信誉 —— 信誉掉下去之后受损的是所有
 *     门店的事务性邮件送达率，那件事没有任何人会来投诉；
 *   · **软退绝不能拦**，一次对方服务器抖动不该让顾客永远收不到预约确认。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, createSign, createHmac, randomUUID } from 'node:crypto';
import {
  sql, withTenant, closeDb,
  emailSuppressed, suppressEmail, emailSuppressedSet,
} from '@gf/db';
import {
  verifySnsSignatureWith, snsStringToSign, isTrustedSnsUrl,
  bounceIsHard, recipientOf, handleSesEvent,
  type SesEvent, type SnsEnvelope,
} from './email/snsWebhook';
import {
  verifySvixSignature, bounceIsHard as resendBounceIsHard,
  handleResendEvent, type ResendEvent,
} from './email/resendWebhook';
import { flushEmails } from './email/flush';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const touched: string[] = [];

function addr(tag: string): string {
  const e = `${tag}-${randomUUID().slice(0, 8)}@maildrop.cc`;
  touched.push(e);
  return e;
}

function bounceEvent(to: string, type: string, providerId?: string): SesEvent {
  return {
    eventType: 'Bounce',
    mail: { messageId: providerId ?? randomUUID(), destination: [to] },
    bounce: {
      bounceType: type,
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: to, diagnosticCode: 'stub' }],
    },
  };
}

/**
 * 一对临时 RSA 密钥。用真实签名走一遍验签，而不是把 `createVerify` 换成替身 ——
 * 待签串的拼接规则（字段顺序、`Subject` 可缺省）正是最容易写错、也最难从
 * 「验签失败」这一个现象里反推出来的部分。
 *
 * ⚠️ 这里用**公钥 PEM** 充当证书：`createVerify().verify()` 对证书与裸公钥的
 * 处理一致（内部都取其中的公钥），而被测对象是签名与待签串，不是 X.509 解析。
 */
let certPem = '';
let privateKeyPem = '';

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

/** 按 SNS 的规则给一条消息签名。 */
function signSns(msg: SnsEnvelope, version = '1'): SnsEnvelope {
  const withVersion = { ...msg, SignatureVersion: version };
  const payload = snsStringToSign(withVersion)!;
  const algo = version === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const Signature = createSign(algo).update(payload, 'utf8').sign(privateKeyPem, 'base64');
  return { ...withVersion, Signature };
}

function notification(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    Type: 'Notification',
    MessageId: 'msg-test-0001',
    TopicArn: 'arn:aws:sns:us-east-2:244924579377:geniefront-ses-events',
    Message: JSON.stringify({ eventType: 'Delivery' }),
    Timestamp: new Date().toISOString(),
    SigningCertURL: 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-abc.pem',
    ...overrides,
  };
}

afterAll(async () => {
  if (touched.length > 0) {
    // ⚠️ app_user 对抑制名单没有 delete 权限（0091：解除抑制是一次要人
    //    负责的决定）。测试用 admin 连接不到，这里只能留下这些 @maildrop.cc
    //    的行 —— 它们对任何真实地址都没有影响。
  }
  await closeDb();
});

const SVIX_SECRET = Buffer.from('gf-test-webhook-secret-0123456789').toString('base64');

/**
 * Resend 侧（Svix，共享密钥 HMAC）。当前生产发信走的就是这一家，
 * 因此这一组是**在用的**保护，不是留给未来的。
 */
describe('Svix 验签（Resend）', () => {
  const id = 'msg_test';
  const body = '{"type":"email.bounced"}';

  function sign(ts: number, secret = SVIX_SECRET): string {
    return `v1,${createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(`${id}.${ts}.${body}`).digest('base64')}`;
  }

  beforeAll(() => {
    process.env['RESEND_WEBHOOK_SECRET'] = `whsec_${SVIX_SECRET}`;
  });

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
      id, timestamp: String(ts), signature: sign(ts), rawBody: `${body} `,
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

/**
 * ⚠️ 两家供应商的退信分级必须给出**同一个判断**。取值恰好同名
 * （Permanent / Transient / Undetermined），但字段路径不同 ——
 * 只测一家的话，另一家把软退当硬退拦下来时没有任何东西会发现。
 */
describe('Resend 侧的退信分级与写回', () => {
  const ev = (type: string, to = 'x@maildrop.cc'): ResendEvent => ({
    type: 'email.bounced',
    data: { email_id: randomUUID(), to: [to], bounce: { type } },
  });

  it('Permanent 才算硬退，Transient / Undetermined 都不算', () => {
    expect(resendBounceIsHard(ev('Permanent'))).toBe(true);
    expect(resendBounceIsHard(ev('Transient'))).toBe(false);
    expect(resendBounceIsHard(ev('Undetermined'))).toBe(false);
  });

  it('硬退进抑制名单，软退不进', async () => {
    const hard = addr('rs-hard');
    const soft = addr('rs-soft');

    await handleResendEvent(ev('Permanent', hard));
    await handleResendEvent(ev('Transient', soft));

    expect(await emailSuppressed(hard)).toBe(true);
    expect(await emailSuppressed(soft)).toBe(false);
  });

  it('投诉进抑制名单', async () => {
    const e = addr('rs-spam');
    await handleResendEvent({ type: 'email.complained', data: { to: [e] } });
    expect(await emailSuppressed(e)).toBe(true);
  });

  it('认不出的事件类型安静忽略', async () => {
    expect(await handleResendEvent({ type: 'email.opened', data: {} }))
      .toEqual({ handled: 'ignored' });
  });
});

describe('SNS 验签', () => {
  it('签名正确且时间戳在容差内才通过', () => {
    expect(verifySnsSignatureWith(signSns(notification()), certPem)).toBe(true);
  });

  /** ⚠️ AWS 于 2022 年起改用 SignatureVersion 2（SHA256）。两个版本都要认。 */
  it('SignatureVersion 1（SHA1）与 2（SHA256）都认', () => {
    expect(verifySnsSignatureWith(signSns(notification(), '1'), certPem)).toBe(true);
    expect(verifySnsSignatureWith(signSns(notification(), '2'), certPem)).toBe(true);
  });

  /**
   * 🔴 未知版本一律拒绝，不做「按 SHA256 再试一次」的回退：
   * 未知版本意味着待签串的构造规则也可能已变，猜测没有意义。
   */
  it('🔴 未知 SignatureVersion 拒绝', () => {
    const msg = { ...signSns(notification()), SignatureVersion: '9' };
    expect(verifySnsSignatureWith(msg, certPem)).toBe(false);
  });

  it('🔴 签名不对一律拒绝', () => {
    const msg = { ...notification(), SignatureVersion: '1', Signature: 'bm9wZQ==' };
    expect(verifySnsSignatureWith(msg, certPem)).toBe(false);
  });

  /**
   * ⚠️ 不校验时间戳的话，一条被截获的旧通知可以被无限重放 ——
   * 而这条路由能把任意地址写进抑制名单。
   */
  it('🔴 超出容差的重放拒绝', () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    expect(verifySnsSignatureWith(signSns(notification({ Timestamp: old })), certPem))
      .toBe(false);
  });

  /**
   * 🔴 `Message` 是事件正文所在。改了正文而签名照旧仍能通过的话，
   * 任何人都可以把任意地址塞进抑制名单。
   */
  it('🔴 正文被改过就对不上', () => {
    const signed = signSns(notification());
    const tampered = { ...signed, Message: JSON.stringify({ eventType: 'Bounce' }) };
    expect(verifySnsSignatureWith(tampered, certPem)).toBe(false);
  });

  /**
   * ⭐ SES 的事件通知**不带 `Subject`**。无条件把 Subject 拼进待签串的话，
   * 线上每一条投递回调都会验签失败，而本地用带 Subject 的样例测不出来。
   */
  it('⭐ 不带 Subject 的通知照常通过，带 Subject 的也通过', () => {
    expect(snsStringToSign(notification())).not.toContain('Subject');
    expect(verifySnsSignatureWith(signSns(notification()), certPem)).toBe(true);

    const withSubject = notification({ Subject: 'hello' });
    expect(snsStringToSign(withSubject)).toContain('Subject\nhello\n');
    expect(verifySnsSignatureWith(signSns(withSubject), certPem)).toBe(true);
  });

  /** 订阅确认的待签串字段集合与通知不同（多 SubscribeURL 与 Token，无 Subject）。 */
  it('订阅确认用另一组字段拼待签串', () => {
    const sub = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'm1', TopicArn: 'arn:aws:sns:us-east-2:1:t', Message: 'hi',
      Timestamp: new Date().toISOString(),
      Token: 'tok', SubscribeURL: 'https://sns.us-east-2.amazonaws.com/?Action=Confirm',
      SigningCertURL: 'https://sns.us-east-2.amazonaws.com/x.pem',
    };
    expect(snsStringToSign(sub)).toContain('SubscribeURL');
    expect(verifySnsSignatureWith(signSns(sub), certPem)).toBe(true);
  });
});

/**
 * 🔴 整条验签链最脆弱的一环。攻击者只要能把 `SigningCertURL` 指向自己控制的
 * 主机，就可以用自己的私钥签名并必然通过验证 —— 此时验签形同虚设。
 */
describe('SigningCertURL 的来源校验', () => {
  it('AWS 的 SNS 端点通过', () => {
    expect(isTrustedSnsUrl('https://sns.us-east-2.amazonaws.com/x.pem')).not.toBeNull();
    expect(isTrustedSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem')).not.toBeNull();
  });

  it('🔴 其他主机一律拒绝', () => {
    for (const bad of [
      'https://attacker.com/x.pem',
      // 后缀匹配（endsWith('.amazonaws.com')）会放过这一条
      'https://sns.us-east-2.amazonaws.com.attacker.com/x.pem',
      // 前缀伪装
      'https://evil-sns.us-east-2.amazonaws.com/x.pem',
      // 非 SNS 服务的 AWS 端点
      'https://s3.amazonaws.com/x.pem',
      // 明文
      'http://sns.us-east-2.amazonaws.com/x.pem',
      'not a url',
      undefined,
    ]) {
      expect(isTrustedSnsUrl(bad)).toBeNull();
    }
  });
});

/**
 * ⚠️ 抑制的对象必须是**事件自身列出的受影响收件人**，而不是整个
 * `mail.destination`。两者不一致时，按 destination 抑制会误伤未退信的地址，
 * 而该误伤是静默的。
 */
describe('收件地址的取法', () => {
  it('优先取 bouncedRecipients', () => {
    expect(recipientOf({
      mail: { destination: ['other@maildrop.cc'] },
      bounce: { bouncedRecipients: [{ emailAddress: 'real@maildrop.cc' }] },
    })).toBe('real@maildrop.cc');
  });

  it('投诉取 complainedRecipients', () => {
    expect(recipientOf({
      mail: { destination: ['other@maildrop.cc'] },
      complaint: { complainedRecipients: [{ emailAddress: 'spam@maildrop.cc' }] },
    })).toBe('spam@maildrop.cc');
  });

  it('都没有时才回落到 mail.destination', () => {
    expect(recipientOf({ mail: { destination: ['only@maildrop.cc'] } }))
      .toBe('only@maildrop.cc');
    expect(recipientOf({})).toBeNull();
  });
});

describe('硬退与软退', () => {
  it('Permanent 才算硬退', () => {
    expect(bounceIsHard(bounceEvent('x@maildrop.cc', 'Permanent'))).toBe(true);
  });

  /**
   * 🔴 软退绝不能进抑制名单：一次对方服务器抖动会让这个顾客
   * **永远**收不到预约确认，而那是静默的。
   */
  it('🔴 Transient 与 Undetermined 都不算 —— 拿不准时少拦比多拦安全', () => {
    expect(bounceIsHard(bounceEvent('x@maildrop.cc', 'Transient'))).toBe(false);
    expect(bounceIsHard(bounceEvent('x@maildrop.cc', 'Undetermined'))).toBe(false);
    expect(bounceIsHard({ eventType: 'Bounce', mail: { destination: ['x@maildrop.cc'] } }))
      .toBe(false);
  });

  it('硬退进抑制名单，软退不进', async () => {
    const hard = addr('hard');
    const soft = addr('soft');

    await handleSesEvent(bounceEvent(hard, 'Permanent'));
    await handleSesEvent(bounceEvent(soft, 'Transient'));

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

    await handleSesEvent({
      eventType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: e }] },
    });

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

    await handleSesEvent({
      eventType: 'Bounce',
      mail: { messageId: providerId, destination: [addr('wb2')] },
      bounce: { bounceType: 'Permanent' },
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

    await handleSesEvent({ eventType: 'Delivery', mail: { messageId: providerId } });

    const [row] = await withTenant(tenant, (tx) => tx<{ delivery_state: string | null }[]>`
      select delivery_state from email_outbox where entity_id = ${entityId}`);
    expect(row?.delivery_state).toBe('delivered');
  });

  it('认不出的事件类型安静忽略', async () => {
    expect(await handleSesEvent({ eventType: 'Open' })).toEqual({ handled: 'ignored' });
    expect(await handleSesEvent({ eventType: 'Send' })).toEqual({ handled: 'ignored' });
  });

  /**
   * ⚠️ `Reject` 是 SES 受理后自行丢弃（例如检出病毒附件），问题出在我方内容，
   * 不在收件地址 —— 把收件人拉进抑制名单是错误的归因。
   */
  it('🔴 Reject 记成软退，不抑制收件人', async () => {
    const e = addr('rej');
    await handleSesEvent({
      eventType: 'Reject',
      mail: { messageId: `stub_${randomUUID()}`, destination: [e] },
    });
    expect(await emailSuppressed(e)).toBe(false);
  });
});
