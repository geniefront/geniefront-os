/**
 * 硬件副屏与 Kiosk 配对信令服务（HardwareServer.tsx，P2 设备配对）
 */

import { randomInt } from 'node:crypto';
import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { sql } from '@gf/db';
import { generateDeviceToken, hashDeviceToken } from '../kiosk/deviceAuth';

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = Array.from({ length: 6 }, () => alphabet[randomInt(0, alphabet.length)]);
  return `${chars.slice(0, 3).join('')}-${chars.slice(3).join('')}`;
}

export interface PairingSessionDto {
  sessionId: string;
  code: string;
  qrPayload: string;
  expiresAt: string;
  terminalType: 'customer-facing' | 'kiosk';
}

export async function createPairingSession(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  terminalType: 'customer-facing' | 'kiosk' = 'customer-facing',
): Promise<PairingSessionDto> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const qrPayload = JSON.stringify({
    type: 'gf_pairing',
    code,
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    terminalType,
    expiresAt,
  });

  const [created] = await tx<{ id: string }[]>`
    insert into pairing_sessions (
      org_id, location_id, code, terminal_type, status, qr_payload, expires_at
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${code}, ${terminalType},
      'pending', ${qrPayload}, ${expiresAt}
    )
    returning id`;

  return {
    sessionId: created!.id,
    code,
    qrPayload,
    expiresAt,
    terminalType,
  };
}

export async function getPairingStatus(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  code: string,
): Promise<{
  status: 'pending' | 'paired' | 'expired';
  terminalType: string;
  pairedDeviceId: string | null;
}> {
  const [session] = await tx<{
    id: string; status: string; terminal_type: string;
    paired_device_id: string | null; expires_at: string;
  }[]>`
    select id, status, terminal_type, paired_device_id, expires_at::text
    from pairing_sessions
    where code = ${code} and location_id = ${ctx.locationId}`;

  if (!session) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'pairing_session', code },
    });
  }

  const isExpired = new Date(session.expires_at).getTime() <= Date.now();
  if (isExpired && session.status === 'pending') {
    await tx`update pairing_sessions set status = 'expired' where id = ${session.id}`;
    return { status: 'expired', terminalType: session.terminal_type, pairedDeviceId: null };
  }

  return {
    status: session.status as 'pending' | 'paired' | 'expired',
    terminalType: session.terminal_type,
    pairedDeviceId: session.paired_device_id,
  };
}

export async function claimPairingSession(
  rawCode: string,
  label = 'iPad Device',
): Promise<{
  deviceToken: string;
  deviceId: string;
  orgId: string;
  locationId: string;
  terminalType: string;
}> {
  const safeLabel = label.trim().slice(0, 60) || 'iPad Device';
  const compact = (rawCode ?? '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const code = compact.length === 6 ? `${compact.slice(0, 3)}-${compact.slice(3)}` : compact;
  return sql.begin(async (tx) => {
    // 显式设置 app.pairing_code 以允许根据 code 查找 session
    await tx`select
      set_config('app.pairing_code',     ${code},      true),
      set_config('app.org_id',           '',           true),
      set_config('app.location_id',      '',           true),
      set_config('app.user_id',          '',           true),
      set_config('app.membership_id',    '',           true)`;

    const [session] = await tx<{
      id: string; org_id: string; location_id: string;
      terminal_type: string; expires_at: string; status: string;
    }[]>`
      select id, org_id, location_id, terminal_type, expires_at::text, status
      from pairing_sessions
      where code = ${code}
      for update`;

    if (!session) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { reason: 'pairing_session_not_found', code },
      });
    }

    if (session.status === 'paired') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'pairing_session_already_used' },
      });
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await tx`update pairing_sessions set status = 'expired' where id = ${session.id}`;
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'pairing_session_expired' },
      });
    }

    // 设置租户上下文以便插入 device_tokens
    await tx`select
      set_config('app.org_id',      ${session.org_id},      true),
      set_config('app.location_id', ${session.location_id}, true)`;

    // 生成设备 Token 并哈希存库（符合 gfk_ 前缀规范）
    const rawToken = generateDeviceToken();
    const tokenHash = hashDeviceToken(rawToken);

    const [device] = await tx<{ id: string }[]>`
      insert into device_tokens (
        org_id, location_id, label, token_hash, last_seen_at, terminal_type
      ) values (
        ${session.org_id}, ${session.location_id}, ${safeLabel}, ${tokenHash}, now(),
        ${session.terminal_type}
      )
      returning id`;

    await tx`
      update pairing_sessions set
        status = 'paired',
        paired_device_id = ${device!.id}
      where id = ${session.id}`;

    return {
      deviceToken: rawToken,
      deviceId: device!.id,
      orgId: session.org_id,
      locationId: session.location_id,
      terminalType: session.terminal_type,
    };
  }) as Promise<{
    deviceToken: string;
    deviceId: string;
    orgId: string;
    locationId: string;
    terminalType: string;
  }>;
}
