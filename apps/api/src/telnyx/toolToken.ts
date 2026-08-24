/**
 * 电话工具的第二把钥匙（sql/0036）。
 *
 * 六个工具的身份证明本来只有一个 Ed25519 签名，而门店靠**公开的**被叫号码
 * 定位 —— 验签一旦被绕过，攻击者可以逐个号码点名查任意一家店。
 * 这串 token 填在 Telnyx 那家店的 assistant 配置里，每次调用随请求体带回来，
 * 验签之后再比一次。
 *
 * ⚠️ 它**不是门店 id**：`call.hangup` / `message.received` 这些 webhook
 * 不是 assistant 的工具调用，带不了自定义参数，那条路只有号码。
 * 也就是说号码永远是第一把钥匙，这串东西只能加在它上面。
 *
 * 摘要存库、明文只给一次 —— 和管理令牌、上机码、设备令牌同一个套路。
 */

import { createHash, randomBytes } from 'node:crypto';

export { sameDigest } from '../public/bookingToken';

/** 明文：`st_` + 32 字节随机。前缀是为了在日志和 Telnyx 配置里一眼认出来 */
export function generateToolToken(): string {
  return `st_${randomBytes(32).toString('base64url')}`;
}

export function hashToolToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
