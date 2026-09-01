/**
 * SigV4 签名。
 *
 * 这一组存在的唯一理由：**签名算错的表现是一个无信息量的
 * `403 InvalidSignatureException`**，与「密钥失效」「权限不足」「区域填错」
 * 完全无法区分。线上排查时无从下手，因此每一条规则都必须在此处钉死。
 */

import { describe, it, expect } from 'vitest';
import { signRequest, canonicalPath, encodePath, canonicalQuery, amzDate } from './sigv4';

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const AT = new Date('2015-08-30T12:36:00Z');

describe('AWS 官方测试向量', () => {
  /**
   * ⭐ 取自 AWS 文档 “Signature Version 4 signing process” 的 IAM ListUsers 示例。
   *
   * 这是整个模块唯一的**外部真值**：其余用例只能证明实现自洽，只有这一条能
   * 证明它与 AWS 服务端的算法一致。签名值一旦对不上，任何 AWS 调用都会 403，
   * 因此该用例失败时不要调整期望值，要去查实现改动了哪一步。
   */
  it('签名与 AWS 文档给出的值逐字节一致', () => {
    const headers = signRequest({
      method: 'GET',
      path: '/',
      query: { Action: 'ListUsers', Version: '2010-05-08' },
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      host: 'iam.amazonaws.com',
      service: 'iam',
      region: 'us-east-1',
      body: '',
      now: AT,
    }, CREDS);

    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date, '
      + 'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });
});

describe('路径编码', () => {
  /**
   * 🔴 除 S3 外的所有 AWS 服务，**规范路径要求对每个路径段编码两次**。
   *
   * 该规则在路径段不含需转义字符时是恒等变换，因此纯域名路径无论遵守与否都能
   * 通过 —— 缺陷只在引入含 `@`、空格等字符的路径参数时暴露。SES 的
   * `GetEmailIdentity` 在身份是邮箱地址（而非域名）时正是这种情况。
   */
  it('🔴 规范路径比实际请求路径多编码一次', () => {
    const p = '/v2/email/identities/awsses@geniefront.com';
    expect(encodePath(p)).toBe('/v2/email/identities/awsses%40geniefront.com');
    expect(canonicalPath(p)).toBe('/v2/email/identities/awsses%2540geniefront.com');
  });

  it('域名类路径段不含需转义字符，两者相同', () => {
    const p = '/v2/email/identities/mail.geniefront.com';
    expect(encodePath(p)).toBe(p);
    expect(canonicalPath(p)).toBe(p);
  });

  it('`/` 是分隔符，不参与编码', () => {
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('/a/b/c')).toBe('/a/b/c');
  });

  /** ⚠️ `encodeURIComponent` 不编码 `!'()*`，而 AWS 的规范要求编码。 */
  it('⚠️ RFC 3986 要求的 !\'()* 也要编码', () => {
    expect(encodePath("/a(b)c!d'e*f")).toBe('/a%28b%29c%21d%27e%2Af');
  });
});

describe('查询串', () => {
  it('按参数名字典序排列', () => {
    expect(canonicalQuery({ b: '2', a: '1', c: '3' })).toBe('a=1&b=2&c=3');
    expect(canonicalQuery(undefined)).toBe('');
  });

  it('键与值都按 RFC 3986 编码', () => {
    expect(canonicalQuery({ 'k y': 'a+b' })).toBe('k%20y=a%2Bb');
  });
});

describe('头部规范化', () => {
  /**
   * ⚠️ 规范请求中的头部名必须小写、按字典序排列。顺序错了签名必然失配，
   * 而调用方传入头部的顺序是任意的。
   */
  it('SignedHeaders 小写且按字典序', () => {
    const headers = signRequest({
      method: 'POST', path: '/', host: 'h.example.com',
      service: 'ses', region: 'us-east-2', body: '{}',
      headers: { 'X-Zed': '1', 'Content-Type': 'application/json', 'A-First': '2' },
      now: AT,
    }, CREDS);
    expect(headers['authorization']).toContain(
      'SignedHeaders=a-first;content-type;host;x-amz-date;x-zed,');
  });

  /**
   * ⚠️ 头部值需去除首尾空白并折叠内部连续空白。该规范化必须与 AWS 服务端一致，
   * 否则一个多打的空格就会让签名失配。
   */
  it('头部值折叠内部连续空白后再签', () => {
    const base = {
      method: 'POST' as const, path: '/', host: 'h.example.com',
      service: 'ses', region: 'us-east-2', body: '{}', now: AT,
    };
    const a = signRequest({ ...base, headers: { 'x-t': '  a   b  ' } }, CREDS);
    const b = signRequest({ ...base, headers: { 'x-t': 'a b' } }, CREDS);
    expect(a['authorization']).toBe(b['authorization']);
  });

  /** 临时凭据的 `x-amz-security-token` 必须参与签名，否则 AWS 侧拒绝。 */
  it('带 session token 时它进入 SignedHeaders', () => {
    const headers = signRequest({
      method: 'POST', path: '/', host: 'h.example.com',
      service: 'ses', region: 'us-east-2', body: '{}', now: AT,
    }, { ...CREDS, sessionToken: 'tok' });
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers['authorization']).toContain('x-amz-security-token');
  });
});

describe('载荷', () => {
  /**
   * ⚠️ 载荷哈希取的是最终发送的字节序列。改一个字节签名就必须变 ——
   * 否则请求体可被篡改而签名照旧通过。
   */
  it('正文不同则签名不同', () => {
    const base = {
      method: 'POST' as const, path: '/v2/email/outbound-emails', host: 'email.us-east-2.amazonaws.com',
      service: 'ses', region: 'us-east-2', now: AT,
      headers: { 'content-type': 'application/json' },
    };
    const a = signRequest({ ...base, body: '{"a":1}' }, CREDS)['authorization'];
    const b = signRequest({ ...base, body: '{"a":2}' }, CREDS)['authorization'];
    expect(a).not.toBe(b);
  });

  /** 相同输入必须得到相同签名 —— 否则重试与调试都无从谈起。 */
  it('相同输入签名稳定', () => {
    const req = {
      method: 'POST' as const, path: '/v2/email/outbound-emails', host: 'email.us-east-2.amazonaws.com',
      service: 'ses', region: 'us-east-2', body: '{"a":1}', now: AT,
    };
    expect(signRequest(req, CREDS)['authorization'])
      .toBe(signRequest(req, CREDS)['authorization']);
  });
});

describe('凭据作用域', () => {
  /**
   * ⚠️ SES 的发件身份按区域独立。区域填错时签名本身合法，但打到的是另一个
   * 区域的端点，那里一个域名身份都没有 —— 现象是「所有邮件都被拒，
   * 而控制台里域名全绿」。
   */
  it('区域与服务写进 Credential 作用域', () => {
    const headers = signRequest({
      method: 'POST', path: '/', host: 'email.us-east-2.amazonaws.com',
      service: 'ses', region: 'us-east-2', body: '{}', now: AT,
    }, CREDS);
    expect(headers['authorization'])
      .toContain('Credential=AKIDEXAMPLE/20150830/us-east-2/ses/aws4_request');
  });

  it('amzDate 是不带分隔符的基本格式', () => {
    expect(amzDate(AT)).toBe('20150830T123600Z');
  });
});
