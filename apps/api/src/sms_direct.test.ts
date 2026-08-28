/**
 * 直发短信命令测试（P0 双向沟通）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb, setSmsConsent } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/sms';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
const outboxIds: string[] = [];

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
  await closeDb();
});

describe('sms.sendDirect', () => {
  it('向前台客人发送一条纯英文单段短信', async () => {
    const res = await dispatch<{ outboxId: string; segments: number; status: string }>(
      'sms.sendDirect',
      {
        toE164: '+16175551234',
        body: 'Hello, your appointment has been confirmed for 3:00 PM today.',
      },
      ownerCtx,
    );

    expect(res.result.outboxId).toBeTruthy();
    expect(res.result.segments).toBe(1);
    expect(res.result.status).toBe('pending');
    outboxIds.push(res.result.outboxId);

    const [row] = await withTenant(tenant, (tx) => tx<{ body: string; status: string }[]>`
      select body, status from sms_outbox where id = ${res.result.outboxId}`);
    expect(row?.body).toContain('3:00 PM');
  });

  it('含有中文/Emoji 的短信自动按 UCS-2 计算 segment', async () => {
    const res = await dispatch<{ outboxId: string; segments: number; status: string }>(
      'sms.sendDirect',
      {
        toE164: '+16175551234',
        body: '您好！您的美甲预约已为您安排在今日下午 3 点，期待您的光临💅！',
      },
      ownerCtx,
    );

    expect(res.result.segments).toBeGreaterThanOrEqual(1);
    outboxIds.push(res.result.outboxId);
  });

  it('已退订 STOP 的号码自动标记 suppressed 而不发出去', async () => {
    const optedOutPhone = '+16175550099';
    await setSmsConsent(optedOutPhone, 'opted_out', 'STOP');

    const res = await dispatch<{ outboxId: string; segments: number; status: string }>(
      'sms.sendDirect',
      {
        toE164: optedOutPhone,
        body: 'This should be suppressed due to opt-out.',
      },
      ownerCtx,
    );

    expect(res.result.status).toBe('suppressed');
    outboxIds.push(res.result.outboxId);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string; last_error: string }[]>`
      select status, last_error from sms_outbox where id = ${res.result.outboxId}`);
    expect(row?.status).toBe('suppressed');
    expect(row?.last_error).toBe('opted_out');
  });
});
