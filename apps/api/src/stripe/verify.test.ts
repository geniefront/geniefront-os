/**
 * Stripe webhook 验签测试。
 *
 * 每一条都在问同一个问题：**没有这一行检查，攻击者能干什么？**
 *
 * 这条链路的答案比电话那条重得多 —— 伪造一条充值 webhook
 * 就能给任意账户凭空加钱，伪造一条订阅事件就能让一家店第二天打不开。
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyStripeSignature, signStripePayload, parseStripeSignature, MAX_SKEW_SECONDS,
} from './verify';

const SECRET = 'whsec_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const NOW = 1_786_900_000;
const BODY = '{"id":"evt_1","type":"payment_intent.succeeded"}';

const ok = (over: Partial<Parameters<typeof verifyStripeSignature>[0]> = {}) =>
  verifyStripeSignature({
    rawBody: BODY,
    signatureHeader: signStripePayload(BODY, SECRET, NOW),
    webhookSecret: SECRET,
    nowSeconds: NOW,
    ...over,
  });

describe('签名头解析', () => {
  it('标准格式', () => {
    const p = parseStripeSignature('t=1492774577,v1=abc123');
    expect(p).toEqual({ timestamp: 1492774577, v1: ['abc123'] });
  });

  it('⭐ 多个 v1 都要留着 —— 轮换密钥期间 Stripe 会同时发新旧两个签名', () => {
    // 只取第一个的话，轮换那几小时里有一半 webhook 会被拒，
    // 而那正是「充值到账了但余额没加」最容易发生的时刻
    const p = parseStripeSignature('t=1,v1=aaa,v1=bbb');
    expect(p?.v1).toEqual(['aaa', 'bbb']);
  });

  it('⭐ v0 一律忽略 —— 那是 CLI 的测试签名，认了等于开后门', () => {
    expect(parseStripeSignature('t=1,v0=aaa')).toBeNull();
  });

  it('缺 t 或缺 v1 都算不合法', () => {
    expect(parseStripeSignature('v1=aaa')).toBeNull();
    expect(parseStripeSignature('t=1')).toBeNull();
    expect(parseStripeSignature('')).toBeNull();
  });

  it('t 不是数字 → 不合法（而不是变成 NaN 一路往下走）', () => {
    expect(parseStripeSignature('t=abc,v1=aaa')).toBeNull();
  });
});

describe('验签', () => {
  it('真签名通过', () => {
    expect(() => ok()).not.toThrow();
  });

  it('⭐ 伪造的签名被拒 —— 不然任何人都能给自己的账户凭空充值', () => {
    expect(() => ok({ signatureHeader: `t=${NOW},v1=deadbeef` })).toThrow();
  });

  it('⭐ 用别的密钥签的被拒（测试密钥签不了生产的 webhook）', () => {
    // 每个 endpoint 有各自的 whsec_。混用的表现是「本地全通、上线全 401」，
    // 而反过来（生产认了本地的密钥）就是把 stripe listen 的任何使用者
    // 变成了生产环境的可信来源
    const other = signStripePayload(BODY, 'whsec_someoneelse', NOW);
    expect(() => ok({ signatureHeader: other })).toThrow();
  });

  it('⭐ 改了 body 一个字节就被拒', () => {
    expect(() => ok({ rawBody: BODY.replace('evt_1', 'evt_2') })).toThrow();
  });

  it('⭐ 改了时间戳也被拒 —— 时间戳被签进了 payload，所以窗口检查才有意义', () => {
    const sig = signStripePayload(BODY, SECRET, NOW);
    expect(() => ok({ signatureHeader: sig.replace(`t=${NOW}`, `t=${NOW + 1}`) })).toThrow();
  });

  it('⭐ 过期的签名被拒 —— 抓到一条合法的充值请求不能明天再重放一遍', () => {
    const old = NOW - MAX_SKEW_SECONDS - 1;
    expect(() => ok({ signatureHeader: signStripePayload(BODY, SECRET, old) })).toThrow();
  });

  it('⭐ 未来的时间戳同样被拒 —— 它一样是攻击者可控的输入', () => {
    const future = NOW + MAX_SKEW_SECONDS + 1;
    expect(() => ok({ signatureHeader: signStripePayload(BODY, SECRET, future) })).toThrow();
  });

  it('窗口边界内通过', () => {
    const edge = NOW - MAX_SKEW_SECONDS;
    expect(() => ok({ signatureHeader: signStripePayload(BODY, SECRET, edge) })).not.toThrow();
  });

  it('缺签名头 → 拒', () => {
    expect(() => ok({ signatureHeader: undefined })).toThrow();
  });

  it('⭐ 没配 STRIPE_WEBHOOK_SECRET → 拒，而不是放行', () => {
    // 「密钥没配就跳过验签」是这类代码最常见的一个后门，
    // 而它在开发环境里工作得非常顺畅 —— 直到它被带上生产
    expect(() => ok({ webhookSecret: '' })).toThrow();
  });

  it('签名头里混进无关的键值对不影响验签', () => {
    const sig = `${signStripePayload(BODY, SECRET, NOW)},v0=whatever`;
    expect(() => ok({ signatureHeader: sig })).not.toThrow();
  });

  it('Buffer 形式的原始字节和字符串等价', () => {
    expect(() => ok({ rawBody: Buffer.from(BODY, 'utf8') })).not.toThrow();
  });

  it('⭐ 带非 ASCII 的 body 按字节验 —— 门店名是中文/越南文的那些', () => {
    const body = '{"name":"莲花美甲 Sơn gel"}';
    expect(() => verifyStripeSignature({
      rawBody: body,
      signatureHeader: signStripePayload(body, SECRET, NOW),
      webhookSecret: SECRET,
      nowSeconds: NOW,
    })).not.toThrow();
  });

  it('签名长度不对（截断的十六进制）→ 拒，且不抛 RangeError', () => {
    // timingSafeEqual 对不等长的 Buffer 会抛 —— 那会变成 500 而不是 401，
    // 而 500 会让我们以为是自己的 bug
    const mac = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    expect(() => ok({ signatureHeader: `t=${NOW},v1=${mac.slice(0, 10)}` }))
      .toThrow(/UNAUTHENTICATED/);
  });
});
