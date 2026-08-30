/**
 * Platform operator authorization.
 *
 * Authenticated identity is not enough. The caller must have an active
 * row in platform_operators. Customer owner/manager roles never count.
 */

import { AppError, ERROR_CODES } from '@gf/contracts';
import { platformOperatorRole, withUser, type PlatformOperatorRole } from '@gf/db';

export interface PlatformOperator {
  userId: string;
  operatorId: string;
  role: PlatformOperatorRole;
  email: string | null;
}

export function isNotPlatformOperatorError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const rec = e as { code?: string; message?: string };
  return rec.code === '42501'
    || (typeof rec.message === 'string' && rec.message.includes('not_platform_operator'));
}

export function mapPlatformReadError(e: unknown): never {
  if (isNotPlatformOperatorError(e)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'not_platform_operator' },
    });
  }
  throw e;
}

export async function requirePlatformOperator(
  userId: string | undefined,
): Promise<PlatformOperator> {
  if (!userId) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  const role = await platformOperatorRole(userId);
  if (!role) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'not_platform_operator' },
    });
  }

  const [row] = await withUser(userId, (tx) => tx<{ id: string; email: string | null }[]>`
    select po.id, u.email
    from platform_operators po
    join users u on u.id = po.user_id
    where po.user_id = ${userId}
      and po.status = 'active'
      and po.revoked_at is null`);

  if (!row) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'not_platform_operator' },
    });
  }

  return { userId, operatorId: row.id, role, email: row.email };
}
