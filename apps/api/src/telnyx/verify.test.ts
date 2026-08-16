/**
 * 验签测试。
 *
 * 这是电话链路上唯一的安全要害（09 §3），所以每一条都在问同一个问题：
 * **没有这一行检查，攻击者能干什么？**
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { verifyTelnyxSignature, toSpkiPem, MAX_SKEW_SECONDS } from './verify';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

/** Telnyx 控制台给的是 base64 的 32 字节裸公钥，不是 PEM */
const rawPublicB64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(12)               // 去掉 SPKI 头，剩 32 字节
  .toString('base64');

const NOW = 1_786_900_000;

function signed(body: string, ts = NOW, key = privateKey) {
  return edSign(null, Buffer.from(`${ts}|${body}`, 'utf8'), key).toString('base64');
}

const ok = (over: Partial<Parameters<typeof verifyTelnyxSignature>[0]> = {}) => {
  const body = '{"data":{"event_type":"call.answered"}}';
  return verifyTelnyxSignature({
    rawBody: body,
    signatureB64: signed(body),
    timestamp: String(NOW),
    publicKeyB64: rawPublicB64,
    nowSeconds: NOW,
    ...over,
  });
};

describe('公钥格式', () => {
  it('裸 32 字节公钥能包成 PEM', () => {
    expect(toSpkiPem(rawPublicB64)).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it('⭐ 把 API Key 填成 PUBLIC_KEY 时给一句人能看懂的话', () => {
    // 这两个变量名太像了，实际部署时一定有人填错。
    // 报「验签失败」的话，排查方向会完全跑偏到「Telnyx 是不是没发签名」
    expect(() => toSpkiPem(Buffer.from('KEY01ABCDEF...').toString('base64')))
      .toThrow(/不是 32 字节/);
  });
});

describe('验签', () => {
  it('真签名通过', () => {
    expect(() => ok()).not.toThrow();
  });

  it('⭐ 伪造的签名被拒 —— 不然任何人都能往复核队列灌预约', () => {
    expect(() => ok({ signatureB64: Buffer.from('nope').toString('base64') })).toThrow();
  });

  it('⭐ 别人的私钥签的也被拒', () => {
    const attacker = generateKeyPairSync('ed25519').privateKey;
    const body = '{"data":{"event_type":"call.answered"}}';
    expect(() => ok({ rawBody: body, signatureB64: signed(body, NOW, attacker) })).toThrow();
  });

  it('⭐ body 被改了一个字节就不通过 —— 签名覆盖的是内容不只是时间戳', () => {
    const body = '{"data":{"event_type":"call.answered"}}';
    const tampered = '{"data":{"event_type":"call.hangup"}}';
    expect(() => ok({ rawBody: tampered, signatureB64: signed(body) })).toThrow();
  });

  it('⭐ 过期的时间戳被拒 —— 抓到一条合法请求不能无限重放', () => {
    const old = NOW - MAX_SKEW_SECONDS - 1;
    const body = '{"a":1}';
    expect(() => ok({
      rawBody: body, timestamp: String(old), signatureB64: signed(body, old),
    })).toThrow();
  });

  it('⭐ 未来的时间戳同样被拒 —— 那也是攻击者可控的输入', () => {
    const future = NOW + MAX_SKEW_SECONDS + 1;
    const body = '{"a":1}';
    expect(() => ok({
      rawBody: body, timestamp: String(future), signatureB64: signed(body, future),
    })).toThrow();
  });

  it('窗口边界内的时钟偏差放行', () => {
    const skewed = NOW - MAX_SKEW_SECONDS;
    const body = '{"a":1}';
    expect(() => ok({
      rawBody: body, timestamp: String(skewed), signatureB64: signed(body, skewed),
    })).not.toThrow();
  });

  it('⭐ 改时间戳换不来重放 —— 时间戳被签进去了', () => {
    const body = '{"a":1}';
    // 攻击者拿到一条旧请求，把时间戳改成现在想蒙混过关
    expect(() => ok({
      rawBody: body,
      timestamp: String(NOW),
      signatureB64: signed(body, NOW - 10_000),
    })).toThrow();
  });

  it('缺签名头 / 缺时间戳头 → 拒', () => {
    expect(() => ok({ signatureB64: undefined })).toThrow();
    expect(() => ok({ timestamp: undefined })).toThrow();
  });

  it('时间戳不是数字 → 拒（不是当成 0 放行）', () => {
    expect(() => ok({ timestamp: 'not-a-number' })).toThrow();
  });

  it('公钥配错（另一对密钥）→ 拒', () => {
    const other = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
    expect(() => ok({ publicKeyB64: other })).toThrow();
  });

  it('⭐ 一律抛 UNAUTHENTICATED，不告诉对方是哪一步不对', () => {
    // 「签名错」和「时间戳过期」的区别只对攻击者有用
    for (const bad of [
      { signatureB64: 'AAAA' },
      { timestamp: String(NOW - 99_999) },
      { publicKeyB64: 'AAAA' },
    ]) {
      expect(() => ok(bad)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    }
  });

  it('⭐ 验的是原始字节，不是重新序列化的对象', () => {
    // 这条钉的是「必须留原始字节」这个实现约束。
    // 反序列化再序列化会改字节：空白被吃掉、\uXXXX 转义被还原成字面字符。
    // 拿 JSON.stringify(req.body) 去验，线上会时灵时不灵 ——
    // 而「让它能用」的下一步通常是宽松比较，那等于没验。
    const body = '{"name": "Sơn", "note": "caf\\u00e9"}';
    const reserialized = JSON.stringify(JSON.parse(body));
    expect(reserialized).not.toBe(body);

    expect(() => ok({ rawBody: reserialized, signatureB64: signed(body) })).toThrow();
    expect(() => ok({ rawBody: body, signatureB64: signed(body) })).not.toThrow();
  });

  it('非 ASCII 的 body 按 UTF-8 字节验，不按字符数', () => {
    const body = '{"heard":"我要做 gel 甲"}';
    expect(() => ok({ rawBody: body, signatureB64: signed(body) })).not.toThrow();
  });
});
