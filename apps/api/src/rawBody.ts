/**
 * 留住原始字节的 JSON 解析器。
 *
 * 两家供应商的 webhook 都要验签，而**验的是原始字节**：
 * 反序列化再序列化会改字节（空白、键顺序、\uXXXX 转义），签名当场对不上。
 *
 * Fastify 一个 content-type 只能注册一个解析器 —— 注册第二次会抛
 * `Content type parser 'application/json' already present`。所以这里
 * 只有一处注册，按路径前缀分流：前缀命中的留原文，其余照常解析。
 *
 * ⚠️ 加一个新的 webhook 供应商 = 往 RAW_BODY_PREFIXES 里加一条。
 * 忘了加的表现很迷惑：签名永远对不上，而 body 看起来完全正常。
 */

import type { FastifyInstance } from 'fastify';

/** 这些前缀下的请求体保持原文，由路由自己验签后再 JSON.parse */
export const RAW_BODY_PREFIXES = ['/v1/telnyx/', '/v1/stripe/'] as const;

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
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error, undefined);
      }
    });
}
