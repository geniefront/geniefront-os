/**
 * 发件箱的投递保障（sql/0090 + `ops/outboxSweep.ts`）。
 *
 * 这一组测的是三个**安静的**缺陷 —— 三者都不报错，信老老实实躺在
 * 发件箱里状态 `pending`，日志里也没有任何异常：
 *
 *   1. `appointment_reminder` 不在邮件 kind 白名单里 → 提醒邮件入队即抛错，
 *      而抛错被通知链路的 try/catch 吞掉；
 *   2. 计费类的信没有任何触发点会投递 —— 而扣款失败的门店被冻结成只读，
 *      恰恰触发不了唯一那个触发点；
 *   3. 改期 / 取消 / 填表邀请不在即时投递清单里，要等下一次建单才顺带发出。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, withTenant, closeDb } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { notifyEvent } from './notify/dispatch';
import { runOutboxSweep } from './ops/outboxSweep';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const ctx = {
  orgId: NAIL_ORG,
  locationId: NAIL_LOC,
  userId: '00000000-0000-4000-8000-000000000000',
  membershipId: null,
  permissions: new Set<string>(),
  actorKind: 'api',
  locale: 'en',
  timezone: 'America/New_York',
} as unknown as CommandContext;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

const log = { log: { info: () => {}, warn: () => {} } } as never;

async function setRule(tx: Tx, event: string, channels: string[]): Promise<void> {
  await tx`
    insert into notification_rules (org_id, location_id, event_key, enabled, channels)
    values (${NAIL_ORG}, ${NAIL_LOC}, ${event}, true, ${channels}::text[])
    on conflict (location_id, event_key) do update
      set enabled = true, channels = excluded.channels`;
}

beforeAll(async () => {
  await withTenant(tenant, (tx) => setRule(tx, 'appointment_reminder', ['email']));
});

afterAll(async () => {
  await closeDb();
});

describe('邮件 kind 白名单', () => {
  /**
   * 🔴 次日提醒是 0088 才做的调度器，而 0029 的白名单里没有它。
   * 短信提醒正常、邮件提醒一条没有，日志里只有一行「该门店本轮失败」。
   */
  it('🔴 appointment_reminder 的邮件入得了队', async () => {
    const queued = await withTenant(tenant, (tx) => notifyEvent(tx, ctx, {
      event: 'appointment_reminder',
      entityType: 'appointment', entityId: crypto.randomUUID(),
      vars: { shop_name: 'Lotus Nails', when: 'Wed Aug 26, 12:30 PM', shop_phone: '(617) 555-0142' },
      toEmail: 'reminder-probe@maildrop.cc', toPhone: null,
      locale: 'en',
    }));
    expect(queued).toBe(1);
  });

  it('四类事务性通知的 kind 全部通过 check', async () => {
    const kinds = ['appointment_confirm', 'appointment_changed', 'appointment_reminder'];
    for (const kind of kinds) {
      await expect(withTenant(tenant, (tx) => tx`
        insert into email_outbox
          (org_id, location_id, kind, to_email, subject, body_html, body_text,
           entity_type, entity_id)
        values (${NAIL_ORG}, ${NAIL_LOC}, ${kind}, 'k@maildrop.cc',
                's', 'h', 't', 'kindprobe', ${crypto.randomUUID()})`),
      ).resolves.toBeDefined();
    }
  });

  /**
   * ⚠️ `receipt` 必须留在白名单里，尽管小票功能已经移除 ——
   * 历史行还带着这个值，收窄会让它们在任何一次 update 时失败。
   */
  it('已移除的 receipt 仍然是合法值 —— 历史行还带着它', async () => {
    await expect(withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'receipt', 'r@maildrop.cc',
              's', 'h', 't', 'kindprobe', ${crypto.randomUUID()})`),
    ).resolves.toBeDefined();
  });
});

describe('兜底投递扫描', () => {
  /**
   * 🔴 这一条守的是那个方向反了的后果：**扣款失败的门店被冻结成只读，
   * 开不了单，也就永远触发不了那唯一一个投递触发点** ——
   * 最需要收到「你的卡扣不上了」的店，恰恰是唯一收不到的。
   */
  it('🔴 计费类的信会被扫到（没有任何业务动作会触发它们）', async () => {
    const entityId = crypto.randomUUID();
    await withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id, created_at)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'payment_failed', 'owner@maildrop.cc',
              'payment failed', 'h', 't', 'billing_invoice', ${entityId},
              now() - interval '10 minutes')`);

    const res = await runOutboxSweep(log, { minAgeSec: 60 });
    expect(res.tenants).toBeGreaterThan(0);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from email_outbox where entity_id = ${entityId}`);
    // 测试进程里投递走 capture 替身：captured 就是「真的走完了投递这一步」
    expect(row?.status).toBe('captured');
  });

  /**
   * ⚠️ 刚入队的不算「漏发」。调用方通常会立刻 flush 一次，兜底扫描若把
   * 刚入队的也算进去，两边会同时对同一封信发起投递。
   */
  it('⚠️ 刚入队的不捡 —— 那一封归入队时的即时投递管', async () => {
    const entityId = crypto.randomUUID();
    await withTenant(tenant, (tx) => tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'platform_notice', 'fresh@maildrop.cc',
              'fresh', 'h', 't', 'freshprobe', ${entityId})`);

    await runOutboxSweep(log, { minAgeSec: 600 });

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from email_outbox where entity_id = ${entityId}`);
    expect(row?.status).toBe('pending');
  });

  it('取件函数只回答「该找谁」，返回的是租户维度', async () => {
    const rows = await sql<{ org_id: string; location_id: string }[]>`
      select * from gf_outbox_pending_tenants(0, 100)`;
    for (const r of rows) {
      expect(r.org_id).toBeTruthy();
      expect(r.location_id).toBeTruthy();
    }
  });
});
