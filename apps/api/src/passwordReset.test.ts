/**
 * 忘记密码：`POST /v1/auth/password/reset`
 *
 * 这条路由在认证之前，所以每一条用例问的都是同一个问题：
 * **伪造这一次请求的人能拿到什么？**
 *
 * 答案必须是「什么都拿不到」。所以这里盯得最紧的不是「信发出去了没有」，
 * 是**响应长得一模一样** —— 存在的邮箱、不存在的邮箱、根本不是邮箱的字符串，
 * 三种输入必须给出同一个 200 `{ ok: true }`。
 * 只要有一处不一样，这条路由就成了一个「拿邮箱列表探测谁是我们客户」的接口。
 *
 * ⚠️ 全程不打真的 Supabase：`fetch` 被换掉了，落下来的请求进 `calls`。
 * 不换的话跑一次测试就真发几封重置邮件出去，而且会吃掉发信配额。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { closeDb } from '@gf/db';
import { buildServer } from './server';
import { __resetRateLimit } from './public/rateLimit';

let app: ReturnType<typeof buildServer>;
const realFetch = globalThis.fetch;

/** 每一次落到 Supabase 的 recover 调用 */
let calls: Array<{ url: string; email: string }> = [];
/** 让上游装作挂掉 —— 上游挂了响应也不许变样 */
let upstreamOk = true;

beforeAll(async () => {
  app = buildServer();
  await app.ready();

  type FetchArgs = Parameters<typeof fetch>;
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = String(input);
    if (url.includes('/auth/v1/recover')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { email?: string };
      calls.push({ url, email: body.email ?? '' });
      return new Response('{}', { status: upstreamOk ? 200 : 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  await closeDb();
});

beforeEach(() => {
  calls = [];
  upstreamOk = true;
  // 限频是进程内的（测试里不走 Upstash），不清的话后面的用例会撞上前面的计数
  __resetRateLimit();
});

const post = (email: unknown, ip = '203.0.113.7') =>
  app.inject({
    method: 'POST', url: '/v1/auth/password/reset',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: { email },
  });

describe('响应永远只有一种', () => {
  it('正常地址 → 200 { ok: true }，并且真的去发了', async () => {
    const r = await post('owner@example.test');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(calls.map((c) => c.email)).toEqual(['owner@example.test']);
  });

  it('⭐ 根本不是邮箱 → 一样的 200，一样的 body，只是不发信', async () => {
    /*
     * 报 400 的话，「是不是合法邮箱」和「这个邮箱在不在」就成了两种
     * 可区分的响应 —— 探测的人先用格式错的那条校准，再拿真地址来比。
     */
    for (const bad of ['', 'nonsense', 'a@b', '   ', 'x'.repeat(300) + '@e.com']) {
      const r = await post(bad);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    }
    expect(calls).toHaveLength(0);
  });

  it('⭐ 上游挂了也返回 ok —— 不能让响应泄露「这次和上次不一样」', async () => {
    upstreamOk = false;
    const r = await post('nobody-at-all@example.test');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('字段缺失 / 类型不对也不炸', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/auth/password/reset',
      headers: { 'content-type': 'application/json' }, payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});

describe('⭐ Gmail：他注册时带点，今天打的不带点', () => {
  it('两个变体都发一次 —— 否则一封信都不会到，而他只会觉得系统坏了', async () => {
    const r = await post('John.Doe@GMail.com');
    expect(r.statusCode).toBe(200);
    /*
     * 不会真发出两封：两个字符串里最多只有一个存在账号，
     * 另一个在 Supabase 那边是空转。
     */
    expect(calls.map((c) => c.email).sort())
      .toEqual(['john.doe@gmail.com', 'johndoe@gmail.com']);
  });

  it('已经是规范形式就只发一次，不做无谓的空转', async () => {
    await post('johndoe@gmail.com');
    expect(calls.map((c) => c.email)).toEqual(['johndoe@gmail.com']);
  });

  it('⚠️ 自建域名不去点 —— 去了就是往一个陌生地址发重置信', async () => {
    await post('John.Doe@corp.com');
    expect(calls.map((c) => c.email)).toEqual(['john.doe@corp.com']);
  });
});

describe('落地页与限频', () => {
  it('redirect_to 由服务端拼，前端塞什么都没用', async () => {
    await app.inject({
      method: 'POST', url: '/v1/auth/password/reset',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'owner@example.test', redirectTo: 'https://evil.example/steal' },
    });
    expect(calls).toHaveLength(1);
    // redirect_to 是 URL 编码过的，解开再看
    const target = new URL(calls[0]!.url).searchParams.get('redirect_to');
    expect(target).toMatch(/\/reset-password$/);
    expect(calls[0]!.url).not.toContain('evil');
  });

  it('同一个地址打太多次 → 429，而 429 不泄露账号存不存在', async () => {
    for (let i = 0; i < 5; i++) expect((await post('spam@example.test')).statusCode).toBe(200);
    const r = await post('spam@example.test');
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('RATE_LIMITED');
    expect(r.json().details.retryAfterSec).toBeGreaterThan(0);
    // ⚠️ 拦下之后不该再去发信 —— 挡住的正是发信本身
    expect(calls.filter((c) => c.email === 'spam@example.test')).toHaveLength(5);
  });

  it('同一个 IP 打太多个不同地址 → 也会被拦（发信配额是店里的钱）', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post(`u${i}@example.test`, '198.51.100.9')).statusCode).toBe(200);
    }
    expect((await post('u99@example.test', '198.51.100.9')).statusCode).toBe(429);
    // 换个 IP 就不受影响 —— 一整间店共用出口 IP 是常态，但那是另一个网络
    expect((await post('u99@example.test', '198.51.100.10')).statusCode).toBe(200);
  });
});
