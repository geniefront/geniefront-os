/**
 * 硬件副屏与 Kiosk 配对信令测试（P2 设备配对）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { createPairingSession, getPairingStatus, claimPairingSession } from './queries/pairing';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
const createdSessionIds: string[] = [];
const createdDeviceIds: string[] = [];

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });
});

afterAll(async () => {
  for (const sid of createdSessionIds) {
    await withTenant(tenant, (tx) => tx`delete from pairing_sessions where id = ${sid}`);
  }
  for (const did of createdDeviceIds) {
    await withTenant(tenant, (tx) => tx`delete from device_tokens where id = ${did}`);
  }
  await closeDb();
});

describe('硬件副屏配对流程', () => {
  let pairingCode = '';

  it('前台生成 6 位配对码与二维码 Payload', async () => {
    const session = await withTenant(tenant, (tx) =>
      createPairingSession(tx, ownerCtx, 'customer-facing')
    );

    expect(session.sessionId).toBeTruthy();
    expect(session.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{2,3}$/);
    expect(session.qrPayload).toContain(session.code);
    expect(session.terminalType).toBe('customer-facing');

    pairingCode = session.code;
    createdSessionIds.push(session.sessionId);
  });

  it('前台轮询配对状态（初态为 pending）', async () => {
    const status = await withTenant(tenant, (tx) =>
      getPairingStatus(tx, ownerCtx, pairingCode)
    );

    expect(status.status).toBe('pending');
    expect(status.pairedDeviceId).toBeNull();
  });

  it('副屏端输入配对码完成握手，获得设备令牌', async () => {
    const claimRes = await claimPairingSession(pairingCode, 'Desk Guest iPad');

    expect(claimRes.deviceToken).toBeTruthy();
    expect(claimRes.deviceId).toBeTruthy();
    expect(claimRes.locationId).toBe(NAIL_LOC);
    createdDeviceIds.push(claimRes.deviceId);

    // 再次查询前台状态变为 paired
    const statusAfter = await withTenant(tenant, (tx) =>
      getPairingStatus(tx, ownerCtx, pairingCode)
    );
    expect(statusAfter.status).toBe('paired');
    expect(statusAfter.pairedDeviceId).toBe(claimRes.deviceId);
  });
});
