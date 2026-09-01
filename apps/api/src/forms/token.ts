/**
 * 填表链接的令牌（`docs/15` §3）。
 *
 * 和设备令牌（0016）、自助取消令牌（0033）同一个套路，理由也同一条：
 * **链接会被转发、会进浏览器历史、会出现在客服截图里**。库里只存
 * SHA-256 摘要，明文只在生成那一次的返回里出现 —— 库被拖走也换不回令牌。
 *
 * ⚠️ 前缀 `fs_` 是给日志用的：一眼认出「这是填表令牌」，
 * 而不用去猜那一串 base64 是什么东西。
 */

import { createHash, randomBytes } from 'node:crypto';
import { formIntakeUrl } from '../links';

export function generateFormToken(): string {
  return `fs_${randomBytes(32).toString('base64url')}`;
}

export function hashFormToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 顾客打开的填表地址。
 *
 * ⭐ 令牌走 **query 而非 path**：该形状与自助改期
 * （`/b/:id?t=`）、门店官网（`?k=pk_…`）保持一致，且前端无需额外路由 ——
 * 该页面为静态 SPA，读取 `location.search` 即可。
 *
 * ⚠️ origin 与路径一律由 `links.ts` 构造，禁止在此处手动拼接：
 * 兜底值若写成生产域名，local 与 staging 发出的邮件将指向生产站点。
 */
export function formShareUrl(token: string): string {
  return formIntakeUrl(token);
}
