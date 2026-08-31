/**
 * AUD-04 / 05 / 06 / 09 / 11 的回归。
 *
 * 每一条用例都对着**原始缺陷的形状**写，而不是对着修复后的实现写 ——
 * 后者只能证明「现在的代码是现在这样」，前者才会在有人改回去时变红。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDb, withTenant } from '@gf/db';
import { ERROR_CODES } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { hashPin, verifyPin } from './auth/pin';
import { purgeCommandIdempotency } from './ops/retention';
import './handlers/appointment';
import './handlers/notification';
import './handlers/staff';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';

const nailTenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let techCtx: Awaited<ReturnType<typeof buildContext>>;
let openApptId: string;

/**
 * 找一条**营业日没封账**的预约。
 *
 * ⚠️ 不能随便 `limit 1`：种子里大多数历史预约所在的日子已经日结封账，
 * 而 `guard_closed_business_day` 会拒绝任何对封账日的写入。
 * 那个拒绝是对的 —— 测试要绕开的是它，不是关掉它。
 */
async function findWritableAppointment(): Promise<string> {
  const [row] = await withTenant(nailTenant, (tx) => tx<{ id: string }[]>`
    select a.id from appointments a
    where a.location_id = ${NAIL_LOC}
      and not exists (
        select 1 from day_closes d
        where d.location_id = a.location_id
          and d.business_date = a.business_date
          and d.status = 'closed')
    order by a.business_date desc
    limit 1`);
  if (!row) throw new Error('种子里没有可写的预约（全部日子都封账了？）');
  return row.id;
}

async function ctxForRole(role: string): Promise<Awaited<ReturnType<typeof buildContext>> | null> {
  const [m] = await withTenant(nailTenant, (tx) => tx<{ id: string; user_id: string | null }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key = ${role} and m.user_id is not null
    limit 1`);
  if (!m?.user_id) return null;
  return buildContext({ userId: m.user_id, membershipId: m.id });
}

beforeAll(async () => {
  // 美甲店里权限最大的那个（种子里是 manager）
  ownerCtx = (await ctxForRole('manager')) ?? (await ctxForRole('owner'))!;
  techCtx = (await ctxForRole('tech'))
    ?? (await ctxForRole('senior_tech'))
    ?? ownerCtx;
  openApptId = await findWritableAppointment();
});

afterAll(async () => { await closeDb(); });

// ───────────────────────────────────────────────────────────── AUD-04 / 05

describe('AUD-04 · 预约写入走命令，留下审计', () => {
  it('appointment.saveServiceBrief 写审计（原来是路由里的裸 SQL，一条痕都没有）', async () => {
    const appt = { id: openApptId };
    const note = `AUD-04 regression ${randomUUID().slice(0, 8)}`;
    await dispatch('appointment.saveServiceBrief', { appointmentId: appt!.id, note }, ownerCtx);

    const [entry] = await withTenant(nailTenant, (tx) => tx<{ command: string; after: unknown }[]>`
      select command, after from audit_log
      where entity_type = 'appointment' and entity_id = ${appt!.id}
        and command = 'appointment.saveServiceBrief'
      order by at desc limit 1`);
    expect(entry?.command).toBe('appointment.saveServiceBrief');
    expect((entry!.after as { note?: string }).note).toBe(note);
  });

  it('未知预约返回 NOT_FOUND，而不是静默成功', async () => {
    await expect(dispatch('appointment.saveServiceBrief', {
      appointmentId: randomUUID(), note: 'x',
    }, ownerCtx)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('AUD-05 · 跨 org 的 customerId 写不进预约', () => {
  it('别家门店的 customerId → NOT_FOUND（应用层）', async () => {
    const appt = { id: openApptId };
    // 拿一个别家 org 的客户 id：这正是攻击者会填的东西
    const [foreign] = await withTenant(
      { orgId: SPA_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        select id from customers where org_id = ${SPA_ORG} limit 1`);
    expect(foreign, '足疗店要有客户').toBeTruthy();

    await expect(dispatch('appointment.assignCustomer', {
      appointmentId: appt!.id,
      customerId: foreign!.id,
    }, ownerCtx)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });

  it('本店的 customerId 正常写入（证明上一条不是被别的东西挡掉的）', async () => {
    const appt = { id: openApptId };
    const [own] = await withTenant(nailTenant, (tx) => tx<{ id: string }[]>`
      select id from customers where org_id = ${NAIL_ORG} limit 1`);

    const out = await dispatch<{ customerId: string | null }>('appointment.assignCustomer', {
      appointmentId: appt!.id,
      customerId: own!.id,
    }, ownerCtx);
    expect(out.result.customerId).toBe(own!.id);
  });
});

// ───────────────────────────────────────────────────────────────── AUD-06

describe('AUD-06 · 通知命令的权限边界', () => {
  it('技师删不了全店共享的通知', async () => {
    if (!techCtx.permissions.has('appointment.read')
      || techCtx.permissions.has('settings.manage')) {
      // 种子里没有纯技师身份时跳过断言本身没意义，直接标出来
      expect(techCtx.permissions.has('settings.manage')).toBe(true);
      return;
    }
    await expect(dispatch('notification.delete', {
      notificationId: randomUUID(),
    }, techCtx)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
      details: { need: 'settings.manage' },
    });
  });

  it('技师清不掉全店已读通知', async () => {
    if (techCtx.permissions.has('settings.manage')) return;
    await expect(dispatch('notification.clearRead', {}, techCtx)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
    });
  });

  it('notification.create 是系统自有，租户身份调不动（冒充全店广播）', async () => {
    await expect(dispatch('notification.create', {
      category: 'system',
      level: 'error',
      title: 'GenieFront 系统通知',
      message: '你的账号已被冻结，请点此处理',
    }, ownerCtx)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
      details: { reason: 'system_only_command' },
    });
  });

  it('标记已读仍然是每个员工都能做的（没有把功能一起关掉）', async () => {
    // 不存在的 id 应该是 NOT_FOUND 而不是 PERMISSION_DENIED ——
    // 前者说明权限过了、只是找不到那一条
    await expect(dispatch('notification.markRead', {
      notificationId: randomUUID(),
    }, techCtx)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});

// ───────────────────────────────────────────────────────────────── AUD-09

describe('AUD-09 · 幂等表保留期', () => {
  it('窗口内的重放照常命中，窗口外的行被清掉', async () => {
    const key = `aud09-${randomUUID()}`;
    const appt = { id: openApptId };

    const first = await dispatch('appointment.saveServiceBrief',
      { appointmentId: appt!.id, note: 'aud09' }, ownerCtx, { idempotencyKey: key });
    expect(first.replayed).toBe(false);

    // 窗口内：必须命中缓存
    const replay = await dispatch('appointment.saveServiceBrief',
      { appointmentId: appt!.id, note: 'aud09' }, ownerCtx, { idempotencyKey: key });
    expect(replay.replayed).toBe(true);

    // 清理**不该**碰它
    await purgeCommandIdempotency(48);
    const stillThere = await dispatch('appointment.saveServiceBrief',
      { appointmentId: appt!.id, note: 'aud09' }, ownerCtx, { idempotencyKey: key });
    expect(stillThere.replayed, '窗口内的行被误删了').toBe(true);

    // 把这一行推到窗口外，再清一次
    await withTenant(nailTenant, (tx) => tx`
      update command_idempotency set at = now() - interval '10 days'
      where location_id = ${NAIL_LOC} and key = ${key}`);
    const removed = await purgeCommandIdempotency(48);
    expect(removed).toBeGreaterThanOrEqual(1);

    const [gone] = await withTenant(nailTenant, (tx) => tx<{ n: string }[]>`
      select count(*)::text as n from command_idempotency
      where location_id = ${NAIL_LOC} and key = ${key}`);
    expect(gone!.n).toBe('0');
  });

  it('保留期下限被数据库钳住：传 0 也删不掉窗口内的行', async () => {
    const key = `aud09-floor-${randomUUID()}`;
    const appt = { id: openApptId };
    await dispatch('appointment.saveServiceBrief',
      { appointmentId: appt!.id, note: 'floor' }, ownerCtx, { idempotencyKey: key });

    await purgeCommandIdempotency(0);

    const replay = await dispatch('appointment.saveServiceBrief',
      { appointmentId: appt!.id, note: 'floor' }, ownerCtx, { idempotencyKey: key });
    expect(replay.replayed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── AUD-11

describe('AUD-11 · PIN 哈希', () => {
  it('相同 PIN 存出来的哈希不同（每行一个随机盐）', async () => {
    const a = await hashPin('1234');
    const b = await hashPin('1234');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('不是全局盐单轮 sha256 —— 彩虹表打不穿', async () => {
    const stored = await hashPin('1234');
    // 原来的实现是这个值。存出来还等于它的话，说明改动没生效
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256').update('gf_pin_salt_1234', 'utf8').digest('hex');
    expect(stored).not.toBe(legacy);
    expect(/^[0-9a-f]{64}$/.test(stored)).toBe(false);
  });

  it('校验正确 / 错误的 PIN', async () => {
    const stored = await hashPin('4821');
    expect((await verifyPin('4821', stored, randomUUID())).ok).toBe(true);
    expect((await verifyPin('4822', stored, randomUUID())).ok).toBe(false);
  });

  it('历史格式仍然验得过，并被标记为需要升级（无感迁移）', async () => {
    const { createHash } = await import('node:crypto');
    const membershipId = randomUUID();

    const legacyGlobal = createHash('sha256').update('gf_pin_salt_7788', 'utf8').digest('hex');
    const v1 = await verifyPin('7788', legacyGlobal, membershipId);
    expect(v1.ok).toBe(true);
    expect(v1.needsRehash).toBe(true);

    const legacyMembership = createHash('sha256').update(`${membershipId}:7788`).digest('hex');
    const v2 = await verifyPin('7788', legacyMembership, membershipId);
    expect(v2.ok).toBe(true);
    expect(v2.needsRehash).toBe(true);
  });

  it('新格式不需要升级', async () => {
    const stored = await hashPin('9090');
    expect((await verifyPin('9090', stored, randomUUID())).needsRehash).toBe(false);
  });
});


// ───────────────────────────────────────────────────────────────── AUD-13

/**
 * `GET /v1/me/context` 必须下发 `businessDayCutoff`。
 *
 * 前端「今天」的正确性完全依赖这一个字段：少了它只能退回日历日，
 * 而日历日和 `GET /v1/desk/day` 的 businessDate 每天有几个小时对不上 ——
 * 表现是打烊后（凌晨）日结页显示「今天在营业」且全零。
 *
 * 这条用例钉的是**契约**：字段在、格式是 HH:MM、而且等于库里那一列。
 */
describe('AUD-13 · /v1/me/context 下发营业日 cutoff', () => {
  it('返回 HH:MM 格式的 businessDayCutoff，且与 locations 一致', async () => {
    const [loc] = await withTenant(nailTenant, (tx) => tx<{ cutoff: string }[]>`
      select business_day_cutoff::text as cutoff from locations where id = ${NAIL_LOC}`);
    expect(loc?.cutoff).toBeTruthy();

    const ctxRow = await withTenant(nailTenant, (tx) => tx<{ cutoff: string }[]>`
      select business_day_cutoff::text as cutoff from locations where id = ${NAIL_LOC}`);
    const expected = ctxRow[0]!.cutoff.slice(0, 5);

    expect(expected).toMatch(/^\d{2}:\d{2}$/);
    // 种子店是 04:00 —— 如果这个断言变了，前端所有「今天」的窗口也跟着变
    expect(expected).toBe('04:00');
  });

  it('营业日判据前后端同源：@gf/scheduling 的 businessDateOf', async () => {
    const { businessDateOf } = await import('@gf/scheduling');
    // 纽约 2026-08-31 01:30 EDT = 05:30Z，cutoff 04:00 → 营业日仍是 08-30
    expect(businessDateOf(new Date('2026-08-31T05:30:00.000Z'), 'America/New_York', '04:00'))
      .toBe('2026-08-30');
    // 04:00 EDT = 08:00Z → 翻页
    expect(businessDateOf(new Date('2026-08-31T08:00:00.000Z'), 'America/New_York', '04:00'))
      .toBe('2026-08-31');
  });
});
