/**
 * 认证：验 Supabase Auth 签发的 JWT，解出 user id。
 *
 * Supabase 用 ES256 非对称签名，所以我们通过 JWKS 公钥验签 ——
 * **这个服务不持有任何能签发用户令牌的密钥**。密钥泄露的爆炸半径小很多。
 *
 * PIN / 设备令牌是另一套（我们自己签的短效受限 JWT），走 APP_JWT_SECRET，
 * 见 device.ts。两套令牌的 issuer 不同，不会互相冒充。
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { listMembershipsForUser } from '@gf/db';

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) throw new Error('SUPABASE_URL 未设置');

/**
 * jose 会自己缓存并按需轮换 JWKS。
 * cooldownDuration 防止伪造的 kid 触发对 Supabase 的刷新风暴。
 */
const jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`), {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
});

export interface AuthedUser {
  userId: string;
  email: string | undefined;
}

// 模块增强：让 req.user 有真实类型，而不是每次 as 一下
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

/** 验 Bearer token。失败一律抛 UNAUTHENTICATED，不泄露具体是哪一步不对。 */
export async function verifyAccessToken(authorizationHeader: string | undefined): Promise<AuthedUser> {
  const raw = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice(7).trim()
    : null;
  if (!raw) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  try {
    const { payload } = await jwtVerify(raw, jwks, {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    });
    if (!payload.sub) throw new Error('缺少 sub');
    return { userId: payload.sub, email: typeof payload['email'] === 'string' ? payload['email'] : undefined };
  } catch (e) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, { cause: e });
  }
}

/**
 * ⚠️ 客户端自报的 membershipId 必须验证归属。
 *
 * 现在这件事有两道防线，而且第二道是数据库层面的事实：
 *   1. 这个函数显式检查（保留，因为它给出的错误信息更清楚）
 *   2. `loadMembershipBase(userId, membershipId)` 走用户维度 RLS，
 *      别人的 membership **根本查不到** —— 就算有人删了第 1 道，也冒充不了
 *
 * 之前只有第 1 道，那是「一句可以被忘记的 if」。
 */
export async function assertMembershipBelongsTo(
  userId: string,
  membershipId: string,
): Promise<void> {
  const list = await listMembershipsForUser(userId);
  if (!list.some((m) => m.membershipId === membershipId)) {
    // 不区分「不存在」和「不属于你」—— 否则可以拿它探测别家店的 id
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'membership_not_owned' },
    });
  }
}
