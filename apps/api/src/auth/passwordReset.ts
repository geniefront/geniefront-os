/**
 * 忘记密码 → 发一封重置邮件
 *
 * ```
 * POST /v1/auth/password/reset   { "email": "owner@example.com" }
 * → 200 { "ok": true }           ← 永远是这个，不管这个邮箱在不在
 * ```
 *
 * ## 为什么走我们的服务器，而不是前端直接调 Supabase
 *
 * `supabase.auth.resetPasswordForEmail()` 在前端一行就能调完，anon key
 * 本来就在前端包里 —— 所以这条路由**挡不住有心人**，它挡的是别的三件事：
 *
 *   · **邮件配额**。发信是花钱的，而且被刷爆之后受损的是我们的发信域名信誉
 *     （下一封真的重置邮件进垃圾箱）。限频要在我们自己手里，
 *     不能只靠 Supabase 那个全局默认值
 *   · **`redirect_to` 由服务端拼**。前端传进来的话，「点重置链接跳到
 *     攻击者的页面」就只剩 Supabase 白名单一道，而那道是带 `/**` 通配的
 *   · **客服要能回答「他说没收到」**。日志里有这一次尝试（邮箱只存摘要），
 *     没有的话这个问题永远查不下去
 *
 * ## ⭐ 永远返回 ok
 *
 * 「这个邮箱没注册过」是一句**不能说**的话。说了，这条路由就成了一个
 * 「拿邮箱列表探测谁是我们客户」的接口 —— 而客户名单对竞品是有价值的。
 *
 * 限频超了会返回 429，那不泄露任何东西：它只说明**这个 IP / 这个地址**
 * 最近被打过，和账号存不存在无关。
 *
 * ## Google 注册的人点了「忘记密码」会怎样
 *
 * 他没有密码。Supabase 仍然会发一封重置信，点进去能**设**一个密码 ——
 * 也就是给这个 Google 账号补上密码登录。这个行为是对的，不用拦。
 * 但前端那一页要写一句「你可能是用 Google 注册的」并把 Google 按钮放在旁边，
 * 否则他会一直等一封自己其实不需要的信。
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { sql } from '@gf/db';
import { checkRateLimits } from '../public/rateLimit';

/** 长得像邮箱就行。真假由「发出去有没有人收到」决定，不在这里较真 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * 落地页。**域名与路径一律取自服务端配置，不接受任何外部输入**
 * （与 `signup/activation.ts` 的 `activationRedirectUrl` 同一条纪律），
 * 并由 `links.ts` 按环境分流。
 */
import { resetRedirectUrl } from '../links';
export { resetRedirectUrl };

/** 限频 key 里不放明文邮箱 —— 那会把客户名单一份份寄进第三方的 Redis */
const emailKey = (email: string): string =>
  createHash('sha256').update(`gf-pwreset:${email}`, 'utf8').digest('hex').slice(0, 32);

/**
 * 调 Supabase 的 `/auth/v1/recover`。
 *
 * 和 `signup/activation.ts` 一样只用 **anon key** —— 这件事不需要
 * service_role（宪法第 5 条）。也一样**不抛异常**：发不出去是可以人工补的，
 * 而把错误抛给调用方会变成「告诉对方这一次和上一次不一样」。
 */
async function callRecover(email: string, redirectTo: string): Promise<boolean> {
  const url = process.env['SUPABASE_URL'];
  const anon = process.env['SUPABASE_ANON_KEY'];
  if (!url || !anon) return false;

  try {
    const res = await fetch(
      `${url.replace(/\/+$/, '')}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
      {
        method: 'POST',
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 要发给哪几个地址。
 *
 * 通常就是他打的那一个。**Gmail 是例外**（sql/0047 那个坑的另一半）：
 * 他当初用 `john.doe@gmail.com` 注册，今天在忘记密码框里打
 * `johndoe@gmail.com` —— Supabase 找不到这个账号，静默返回 200，
 * **一封信都不会到**，而他只会觉得这个系统坏了。
 *
 * 所以两个变体都发一次。⭐ 这**不会**发出两封信：两个字符串里
 * 最多只有一个真的存在账号，另一个在 Supabase 那边是空转。
 *
 * ⚠️ 规范化调的是数据库里的 `gf_canonical_email` 而不是在这里重写一遍。
 * 规则只有一份（宪法第 2 条）—— 抄第二遍，某天认领门店和忘记密码
 * 对同一个地址会给出不同答案，而那种不一致查起来极痛苦。
 */
async function targetsFor(email: string): Promise<string[]> {
  try {
    const [row] = await sql<{ v: string | null }[]>`
      select public.gf_canonical_email(${email}) as v`;
    const canon = row?.v;
    if (canon && canon !== email) return [email, canon];
  } catch {
    // 规范化查不了就只发他打的那一个。降级成「和以前一样」，不是失败
  }
  return [email];
}

export function registerPasswordResetRoutes(app: FastifyInstance): void {
  app.post<{ Body: { email?: string } }>('/v1/auth/password/reset', async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase();

    /*
     * ⚠️ 格式不对也返回 ok。
     *
     * 报 400 的话，「这个字符串是不是一个合法邮箱」和「这个邮箱在不在」
     * 就成了两种可区分的响应 —— 探测的人先用格式错的那条校准一遍，
     * 再拿真地址来比。一律 ok，唯一的差别只在限频。
     */
    if (!EMAIL.test(email) || email.length > 254) {
      req.log.info({ reason: 'malformed' }, 'password reset ignored');
      return reply.send({ ok: true });
    }

    /*
     * IP 宽一点、地址紧一点，但都不能太紧。
     *
     * ⚠️ 按地址限频有一个代价：知道你邮箱的人可以把你的额度打满，
     * 让你**一小时内重置不了密码**。所以给到 5 次 —— 真人手滑两三次是常事，
     * 而 Supabase 自己还有一道 60 秒冷却挡着连点。
     *
     * 一整间店共用一个出口 IP 是常态（前台、老板、店长同一个 wifi），
     * 所以 IP 那条给 10 次，不能按「一个人一次」来算。
     */
    const verdict = await checkRateLimits([
      { scope: 'pwreset-ip', id: req.ip, limit: 10, windowSec: 3600 },
      { scope: 'pwreset-email', id: emailKey(email), limit: 5, windowSec: 3600 },
    ], req.log);

    if (!verdict.ok) {
      // 429 不泄露账号存不存在 —— 它只说明这个 IP / 这个地址最近被打过
      return reply.status(429).send({
        code: 'RATE_LIMITED',
        messageKey: 'error.RATE_LIMITED',
        details: { scope: verdict.scope, retryAfterSec: verdict.retryAfterSec },
        overridable: false,
      });
    }

    const redirectTo = resetRedirectUrl();
    const targets = await targetsFor(email);
    const sent = await Promise.all(targets.map((t) => callRecover(t, redirectTo)));

    /*
     * 日志里**只有摘要**，没有明文邮箱。客服要查「他说没收到」时，
     * 让他把地址报过来现算一次摘要去比对 —— 够用，而日志本身
     * 不再是一份可以被导出的客户名单。
     */
    req.log.info(
      { emailHash: emailKey(email), variants: targets.length, upstreamOk: sent.some(Boolean) },
      'password reset requested',
    );

    // ⭐ 上游失败也返回 ok。见文件头：这条路由的响应**永远只有一种**
    return reply.send({ ok: true });
  });
}
