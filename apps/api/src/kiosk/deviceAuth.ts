/**
 * 设备令牌：门口那台 iPad 怎么证明自己是这家店的（01 §5）
 *
 * Kiosk 和系统里别的端有一个根本区别：**它前面站的是客人，不是员工**。
 * 没有登录、没有会话、没有人为它的操作负责。所以它的权限必须窄到极致 ——
 * 一台被顺走的 iPad 能做的事，要和捡到它的人能做的事一样少。
 *
 * ## 它能做什么
 *
 *   排队取号、提交自己刚签的健康表。**就这两件。**
 *
 * ## 它不能做什么
 *
 *   查客户列表、看电话号码、看预约表、看任何钱相关的东西。
 *   签到时的号码匹配走的是一条**专用只读路径**（只认当天的预约、
 *   只返回打码的名字），不是给它 `customer.read` 权限 ——
 *   那等于把整个客户名单挂在门口。
 *
 * ## 令牌本身
 *
 *   库里只存 **SHA-256 摘要**，明文只在签发那一刻给一次。
 *   跟密码一个道理：库被拖走，拿到的摘要换不回能用的令牌。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AppError, ERROR_CODES,
  type CommandContext, type Permission,
} from '@gf/contracts';
import { withDeviceToken } from '@gf/db';

/**
 * Kiosk 这个 actor 的**全部**权限。
 *
 * 加任何一条之前先问：**捡到这台 iPad 的人能拿它干什么？**
 */
export const KIOSK_PERMISSIONS: readonly Permission[] = [
  'queue.join',    // 排队取号
  'form.submit',   // 交自己刚签的健康表
];

/** 令牌长这样：`gfk_` + 32 字节随机的 base64url。前缀是为了在日志里一眼认出来 */
export function generateDeviceToken(): string {
  return `gfk_${randomBytes(32).toString('base64url')}`;
}

/** 库里只存摘要。和密码一样：明文只在签发那一刻存在过一次 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 定长比较。
 *
 * 摘要查询本身走的是唯一索引（数据库那一层不会有时序差），
 * 这里再比一次是为了把「查到了但值不等」这条路也走成定长的 ——
 * 便宜，而且省掉了以后有人重构成 `===` 的机会。
 */
function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface DeviceSession {
  deviceId: string;
  label: string;
  terminalType: 'customer-facing' | 'kiosk' | null;
  ctx: CommandContext;
}

/**
 * 验令牌，换一个门店级的受限上下文。
 *
 * 失败一律抛 UNAUTHENTICATED，**不区分**「没这个令牌」和「令牌被吊销了」——
 * 那个区别只对想试探的人有用。
 */
export async function verifyDeviceToken(
  headerValue: string | undefined,
  ip?: string,
): Promise<DeviceSession> {
  const token = headerValue?.trim();
  if (!token || !token.startsWith('gfk_')) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  const hash = hashDeviceToken(token);
  const row = await withDeviceToken(hash).catch(() => null);

  if (!row || !sameHash(row.tokenHash, hash)) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED);
  }
  if (row.revokedAt) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
  if (['suspended', 'closed'].includes(row.locationStatus)) {
    throw new AppError(ERROR_CODES.LOCATION_SUSPENDED, { details: { status: row.locationStatus } });
  }

  return {
    deviceId: row.id,
    label: row.label,
    terminalType: row.terminalType,
    ctx: {
      orgId: row.orgId,
      locationId: row.locationId,
      // 平台内部的匿名 actor id。Kiosk 背后没有 user，也没有 membership ——
      // 审计里它是一台设备，不是某个人
      userId: '00000000-0000-4000-8000-000000000000',
      membershipId: null,
      permissions: new Set(KIOSK_PERMISSIONS),
      actorKind: 'system',
      locale: (row.defaultLocale as CommandContext['locale']) ?? 'en',
      timezone: row.timezone,
      ...(ip ? { ip } : {}),
    },
  };
}
