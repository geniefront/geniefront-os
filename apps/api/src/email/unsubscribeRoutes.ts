/**
 * 营销邮件退订端点。
 *
 * ```
 * POST /public/v1/email/unsubscribe?t=<token>   ← RFC 8058 一键退订
 * GET  /public/v1/email/unsubscribe?t=<token>   ← 退订页读取状态用
 * ```
 *
 * ## 两个方法都要有
 *
 *   · **POST**：`List-Unsubscribe` 头指向的地址必须接受 POST 且无需交互
 *     （RFC 8058）。Gmail 与 Outlook 在用户点击其界面上的「取消订阅」时
 *     直接打这个地址，收件人不会看到我们的任何页面；
 *   · **GET**：邮件正文里那条链接落在退订页上，该页面用 GET 确认令牌有效
 *     之后再由用户点一次确认。
 *
 * ## ⭐ 永远返回 ok
 *
 * 与忘记密码同一条纪律：令牌无效、顾客不存在、早已退订，返回体一律相同。
 * 区分它们会把这条路由变成一个「拿令牌探测顾客是否存在」的接口。
 *
 * ## 不需要登录
 *
 * CAN-SPAM 要求退订流程不得设置额外门槛。令牌本身即凭证，其能力被限定为
 * 「把某位顾客的营销邮件开关关掉」—— 关掉的方向不构成风险。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from '@gf/db';
import { checkRateLimits } from '../public/rateLimit';
import { verifyUnsubscribeToken } from './unsubscribe';

async function unsubscribe(token: unknown): Promise<void> {
  const payload = verifyUnsubscribeToken(token);
  if (!payload) return;
  try {
    await sql`select gf_email_unsubscribe(
      ${payload.customerId}::uuid, ${payload.orgId}::uuid)`;
  } catch {
    /*
     * ⚠️ 吞掉。退订失败时返回 5xx 会让收件方（Gmail）把这次点击记成失败，
     * 并在其界面上提示「退订未成功」—— 而收件人对此无能为力。
     * 日志由 `sql` 层自身记录。
     */
  }
}

export function registerEmailUnsubscribeRoutes(app: FastifyInstance): void {
  const peek = async (
    req: FastifyRequest<{ Querystring: { t?: string } }>,
  ): Promise<{ ok: true }> => {
    const verdict = await checkRateLimits(
      [{ scope: 'email-unsub-ip', id: req.ip, limit: 60, windowSec: 3600 }],
      req.log,
    );
    // 只校验令牌形状，不执行退订。预取 / 打开确认页不得改订阅状态。
    if (verdict.ok) verifyUnsubscribeToken(req.query?.t);
    return { ok: true };
  };

  const confirm = async (
    req: FastifyRequest<{ Querystring: { t?: string } }>,
  ): Promise<{ ok: true }> => {
    const verdict = await checkRateLimits(
      [{ scope: 'email-unsub-ip', id: req.ip, limit: 60, windowSec: 3600 }],
      req.log,
    );
    // 超频也回 ok：这条路由对外只有一种回答
    if (verdict.ok) {
      await unsubscribe(req.query?.t);
    }
    return { ok: true };
  };

  app.get<{ Querystring: { t?: string } }>('/public/v1/email/unsubscribe', peek);
  app.post<{ Querystring: { t?: string } }>('/public/v1/email/unsubscribe', confirm);
}
