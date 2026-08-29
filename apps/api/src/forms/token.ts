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

export function generateFormToken(): string {
  return `fs_${randomBytes(32).toString('base64url')}`;
}

export function hashFormToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 客人点开的那个地址。
 *
 * ⭐ 令牌走 **query 而不是 path**：`?t=` 这个形状和自助取消
 * （`/public/v1/bookings/:id?t=`）、门店官网（`?k=pk_…`）一致，
 * 而且前端不需要路由 —— 那一页是个静态 SPA，读一下 location.search 就够了。
 */
export function formShareUrl(token: string): string {
  const base = (process.env['FORM_BASE_URL'] ?? 'http://localhost:5177').replace(/\/+$/, '');
  // 顾客填单页已经合并进 apps/web；`intake` 只是稳定路由占位，
  // 真正允许填写哪些模板仍完全由一次性 fs_ 令牌决定。
  return `${base}/forms/intake?t=${encodeURIComponent(token)}`;
}
