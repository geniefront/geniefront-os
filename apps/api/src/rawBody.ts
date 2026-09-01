/**
 * 留住原始字节的 JSON 解析器。
 *
 * 各家供应商的 webhook 都要验签，而**验的是原始字节**：
 * 反序列化再序列化会改字节（空白、键顺序、\uXXXX 转义），签名当场对不上。
 *
 * Fastify 一个 content-type 只能注册一个解析器 —— 注册第二次会抛
 * `Content type parser 'application/json' already present`。所以这里
 * 只有一处注册，按路径前缀分流：前缀命中的留原文，其余照常解析。
 *
 * ⚠️ 加一个新的 webhook 供应商 = 往 RAW_BODY_PREFIXES 里加一条。
 * 忘了加的表现很迷惑：签名永远对不上，而 body 看起来完全正常。
 *
 * ⚠️ **AWS SNS 投递时的 `Content-Type` 是 `text/plain`，正文却是 JSON。**
 * Fastify 对 `text/plain` 没有内置解析器，不额外注册的话，SES 的每一条投递
 * 回调都会在进入路由之前被拒为 `415 Unsupported Media Type` —— 而现象是
 * 「退信从来没有回流过」，本地又无法复现（本地用 curl 测试通常带的是
 * `application/json`）。
 */

import type { FastifyInstance } from 'fastify';

/** 这些前缀下的请求体保持原文，由路由自己验签后再 JSON.parse */
export const RAW_BODY_PREFIXES = [
  '/v1/telnyx/', '/v1/stripe/', '/v1/webhooks/ses', '/v1/webhooks/resend',
] as const;

/** 原文包装。路由从 `req.body.raw` 取字节 */
export interface RawBody { raw: string }

export function isRawBodyPath(url: string): boolean {
  return RAW_BODY_PREFIXES.some((p) => url.startsWith(p));
}

/** 从请求里取原始字节。不是原文路由就返回空串 —— 验签会因此失败，这是对的 */
export function rawBodyOf(req: { body: unknown }): string {
  return (req.body as RawBody | undefined)?.raw ?? '';
}

export function registerRawBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      if (isRawBodyPath(req.url)) {
        done(null, { raw: body as string } satisfies RawBody);
        return;
      }
      /**
       * 空 body 当成 `{}`。
       *
       * 不带参数的 POST（`/v1/setup/claim` 就是一条）在浏览器里发出来是
       * `Content-Type: application/json` + 零字节。直接 JSON.parse 会抛
       * SyntaxError，而它不是 AppError —— 于是前台收到的是 **500 INTERNAL**，
       * 一个「你的付款出问题了」的界面，实际上什么问题都没有。
       *
       * ⚠️ 验签那两条路径**不走这里**（上面就返回了），所以这一句
       * 不会让一个空 body 的伪造 webhook 蒙混过关：它照样得过签名。
       */
      const text = (body as string).trim();
      if (text === '') { done(null, {}); return; }
      try {
        done(null, JSON.parse(text));
      } catch (e) {
        done(e as Error, undefined);
      }
    });

  /**
   * `text/plain` —— 只为 SNS 而存在。
   *
   * ⚠️ 非原文路径一律拒绝，而不是当作字符串放行。本服务没有任何一条业务路由
   * 接受纯文本请求体，放行等于给所有路由多开一条绕过 JSON 校验的入口。
   */
  app.addContentTypeParser(
    'text/plain',
    { parseAs: 'string' },
    (req, body, done) => {
      if (!isRawBodyPath(req.url)) {
        done(new Error('unsupported content type: text/plain'), undefined);
        return;
      }
      done(null, { raw: body as string } satisfies RawBody);
    });
}
