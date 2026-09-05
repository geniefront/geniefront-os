/**
 * 营销邮件退订令牌。
 *
 * ## 为什么需要
 *
 * `birthday` / `holiday` / `winback` / `review_request` 四类营销邮件与
 * 事务性邮件（预约确认、小票、账单）走同一条发送通道。CAN-SPAM 要求
 * **商业性邮件必须提供可用的退订方式**，且退订流程不得设置额外门槛 ——
 * 因此退订链接不能落在需要登录的工作台上。
 *
 * ## 为什么不建表
 *
 * 令牌是**无状态**的：载荷（顾客 id + 组织 id）直接编码在令牌里，由
 * HMAC 保证不可伪造。建一张 `unsubscribe_tokens` 表会额外带来签发、
 * 过期与清理三件事，而这三件事在此处都没有实际收益 —— 退订链接本就
 * 应当长期有效（收件人半年后翻出旧邮件点退订，必须仍然生效）。
 *
 * ## 密钥
 *
 * 由 `APP_JWT_SECRET` 派生，附加固定命名空间，避免与其他用途的签名
 * 共用同一密钥空间。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const NAMESPACE = 'gf-email-unsubscribe:v1';

export interface UnsubscribePayload {
  customerId: string;
  /**
   * ⚠️ 是 **org** 而不是 location：`customers` 本身是 org 维度的
   * （同一位顾客在同一个老板的三家店里是同一行），退订一次即对该组织
   * 全部门店生效。
   */
  orgId: string;
}

function secret(): string | null {
  const v = process.env['APP_JWT_SECRET'];
  return v && v.length > 0 ? v : null;
}

function sign(body: string, key: string): string {
  return createHmac('sha256', `${NAMESPACE}:${key}`).update(body).digest('base64url');
}

/**
 * 签发退订令牌。密钥未配置时返回 null —— 调用方据此**不放退订链接**，
 * 而不是放一个点了没有反应的链接。
 */
export function mintUnsubscribeToken(p: UnsubscribePayload): string | null {
  const key = secret();
  if (!key) return null;
  const body = Buffer.from(`${p.customerId}.${p.orgId}`, 'utf8').toString('base64url');
  return `${body}.${sign(body, key)}`;
}

/**
 * 校验并解出载荷。任何异常一律返回 null。
 *
 * ⚠️ 比较用 `timingSafeEqual`：长度不同直接判否，避免抛异常。
 */
export function verifyUnsubscribeToken(token: unknown): UnsubscribePayload | null {
  const key = secret();
  if (!key || typeof token !== 'string' || token.length > 1024) return null;

  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);

  const expected = sign(body, key);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const [customerId, orgId] = Buffer.from(body, 'base64url').toString('utf8').split('.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!customerId || !orgId || !uuid.test(customerId) || !uuid.test(orgId)) return null;
  return { customerId, orgId };
}
