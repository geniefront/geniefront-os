/**
 * 开发库的清洁工：`pnpm db:tidy`
 *
 * 测试跑完会在共用的开发库里留下两类垃圾，前端一打开就撞上：
 *
 *   · **1980/1990 年的未结工单，几百张。** 财务表对 `app_user` 删不掉
 *     （宪法第 9 条），所以 `money.test.ts` / `gapdays.test.ts` 只能把旧数据
 *     「停放」到 1999 年以前而不能清理 —— 于是停放区只增不减，
 *     最后全都挤进前台的「未结工单」列表
 *   · **测试专用日期的预约**（`bus.test.ts` 的 2027-03-15）
 *
 * ## ⭐ 为什么这个脚本在 apps/api 而不是 packages/db
 *
 * 第一版写在 `packages/db`，用 admin 连接直接 `delete from tickets`。
 * 跑起来撞了两堵墙，而**两堵墙都是对的**：
 *
 *   1. 一路撞外键（payments → customer_credit_ledger → earnings → …）
 *   2. 最后撞上 `gf_ccl_append_only()`：
 *      「客人资产账本只能追加：要冲销就插一条 reversal_of_id 指过去的反向记录」
 *
 * 绕过它们要么关触发器、要么 `session_replication_role = replica` ——
 * 那等于造一把**专门用来废掉宪法最硬那条保证**的钥匙。
 * 而那把钥匙一旦存在，某天有人把迁移用的那条连接串指错了库，真账就没了。
 * 靠 `NODE_ENV` 判一下拦不住：决定打哪个库的是连接串，不是那个变量。
 *
 * 所以改成**走命令总线作废**（`ticket.void`）—— 那正是宪法给的答案：
 * 财务记录只冲正、不删除。作废之后 `status = 'voided'`，
 * `/v1/desk/tickets` 只查 `open|in_service|ready_to_pay`，
 * 前端那一屏幽灵单就没了，而**一行数据都没有被删**。
 *
 * 顺带把演示预约补回来 —— 前端要有单可看，而 `pnpm db:seed` 是全量重建，
 * 会把运维手工绑的真号从 `phone_lines` 上解绑（那家店的电话会全部 401）。
 * 这个脚本一根手指都不碰 phone_lines / locations / memberships / services。
 */

import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/ticket';

/**
 * 停放区的上界。`money.test.ts` 把旧工单挪到 1999 年以前，
 * 刻意和真实数据隔开。⚠️ 别把这个数字往后调 —— 1999 之后就是真账了。
 */
const PARK_BEFORE = '1999-01-01';

/** 测试专用的营业日。这些日期上的预约一律是残留 */
const TEST_DAYS = ['2027-03-15'];

const STORES = [
  { name: 'Lotus Nails', orgId: '11111111-1111-4111-8111-111111111111',
    locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
  { name: 'Golden Foot', orgId: '22222222-2222-4222-8222-222222222222',
    locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' },
] as const;

/** 演示预约。⚠️ 和 `packages/db/src/seed.ts` 末尾那几条 `book(...)` 是同一份数据 */
const DEMO = [
  { store: 0, tz: 'America/New_York', offset: -1, hhmm: '11:00', min: 45,
    customer: 'Lisa Chen', staff: 'Linh', service: 'Gel Manicure', source: 'desk' },
  { store: 0, tz: 'America/New_York', offset: 0, hhmm: '13:00', min: 60,
    customer: '张女士', staff: 'Mai', service: 'Deluxe Pedicure', source: 'phone_manual' },
  { store: 0, tz: 'America/New_York', offset: 1, hhmm: '15:00', min: 45,
    customer: 'Lisa Chen', staff: 'Tran', service: 'Gel Manicure', source: 'web' },
  { store: 1, tz: 'America/Los_Angeles', offset: 0, hhmm: '15:00', min: 60,
    customer: 'Wang Ming', staff: 'Yan', service: 'Foot Reflexology 60min', source: 'web' },
] as const;

/** 找一个有 `ticket.void` 的人来执行作废 —— 作废是有主体的动作，不是无名操作 */
async function voiderFor(store: typeof STORES[number]) {
  const tenant = { ...store, membershipId: null };
  const rows = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${store.locationId} and m.status = 'active'
      and m.user_id is not null and r.key in ('owner', 'manager')
    limit 1`);
  if (!rows[0]) return null;
  return buildContext({ userId: rows[0].user_id, membershipId: rows[0].id });
}

async function main(): Promise<void> {
  console.log('\n═══ 清理开发库 ═══\n');

  for (const store of STORES) {
    const tenant = { orgId: store.orgId, locationId: store.locationId, membershipId: null };

    // ── ① 停放区的未结工单 → 作废（不是删除）────────────────────────────
    const stale = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from tickets
      where location_id = ${store.locationId}
        and business_date < ${PARK_BEFORE}
        and status in ('open', 'in_service', 'ready_to_pay')
      order by business_date`);

    if (stale.length > 0) {
      const ctx = await voiderFor(store);
      if (!ctx) {
        console.log(`  ${store.name}：找不到有 ticket.void 的人，跳过`);
      } else {
        let done = 0;
        for (const t of stale) {
          try {
            await dispatch('ticket.void',
              { ticketId: t.id, reason: 'input_error', note: '开发库清理：测试残留' },
              ctx, { idempotencyKey: randomUUID() });
            done += 1;
          } catch (e) {
            console.log(`    ⚠️ ${t.id} 作废失败：${(e as Error).message}`);
          }
        }
        console.log(`  ${store.name}：停放区未结工单 ${done}/${stale.length} 张已作废`);
      }
    } else {
      console.log(`  ${store.name}：停放区没有未结工单`);
    }

    // ── ② 测试专用日期的预约 —— 这个可以真删，预约不是财务记录 ──────────
    const gone = await withTenant(tenant, (tx) => tx`
      delete from appointments
      where location_id = ${store.locationId} and business_date = any(${TEST_DAYS as unknown as string[]})
      returning 1`);
    if (gone.length) console.log(`  ${store.name}：清掉测试日期的预约 ${gone.length} 条`);
  }

  // ── ③ 把演示预约补回来 ────────────────────────────────────────────────
  //
  // ⚠️ 直插而**不走 `appointment.create`**：那条命令会查容量、发确认邮件、
  // 进审计流水。补演示数据不该在 outbox 里堆四封信。
  //
  // ⚠️ 但仍然走 `withTenant`（app_user，受 RLS）**而不是 admin 连接** ——
  // `lint:guards` 明令 `apps/` 不许碰 admin（宪法第 5 条），
  // 而这个脚本住在 apps/api 里。它不需要那个权限：预约表 app_user 写得了。
  let made = 0;
  for (const d of DEMO) {
    const store = STORES[d.store]!;
    const tenant = { orgId: store.orgId, locationId: store.locationId, membershipId: null };
    made += await withTenant(tenant, async (tx) => {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: d.tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const dt = new Date(`${today}T12:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() + d.offset);
      const date = dt.toISOString().slice(0, 10);

      const [cust] = await tx<{ id: string }[]>`
        select id from customers where org_id = ${store.orgId}
          and display_name = ${d.customer} limit 1`;
      const [svc] = await tx<{ id: string }[]>`
        select id from services where location_id = ${store.locationId}
          and name->>'en' = ${d.service} and active limit 1`;
      const [mem] = await tx<{ id: string }[]>`
        select membership_id as id from staff_profiles
        where location_id = ${store.locationId} and display_name->>'en' = ${d.staff} limit 1`;
      if (!cust || !svc || !mem) {
        console.log(`  ⚠️ 跳过 ${d.customer} / ${d.service} / ${d.staff}`
          + ' —— 种子数据不全，先跑 pnpm db:seed');
        return 0;
      }

      // 幂等：同一天同一个客人的演示单只留一条，重复跑不会越堆越多
      const [dup] = await tx<{ id: string }[]>`
        select id from appointments
        where location_id = ${store.locationId} and business_date = ${date}
          and customer_id = ${cust.id} and status <> 'cancelled'`;
      if (dup) return 0;

      const [a] = await tx<{ id: string }[]>`
        insert into appointments
          (org_id, location_id, customer_id, business_date, starts_at, ends_at, status, source)
        values (${store.orgId}, ${store.locationId}, ${cust.id}, ${date},
                (${date}::date + ${d.hhmm}::time) at time zone ${d.tz},
                (${date}::date + ${d.hhmm}::time) at time zone ${d.tz}
                  + make_interval(mins => ${d.min}),
                'booked', ${d.source})
        returning id`;
      await tx`insert into appointment_items
        (org_id, location_id, appointment_id, service_id, membership_id,
         starts_at, ends_at, price_cents_snapshot, duration_min)
        select ${store.orgId}, ${store.locationId}, ${a!.id}, ${svc.id}, ${mem.id},
               starts_at, ends_at, base_price_cents, ${d.min}
        from appointments ap, services s
        where ap.id = ${a!.id} and s.id = ${svc.id}`;
      return 1;
    });
  }
  console.log(`\n  演示预约：补了 ${made} 条（已有的不重复建）`);

  console.log('\n  现在的状态：');
  for (const store of STORES) {
    const tenant = { orgId: store.orgId, locationId: store.locationId, membershipId: null };
    const days = await withTenant(tenant, (tx) => tx<{ d: string; n: number }[]>`
      select business_date::text d, count(*)::int n from appointments
      where location_id = ${store.locationId} group by 1 order by 1`);
    const [open] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int n from tickets where location_id = ${store.locationId}
        and status in ('open', 'in_service', 'ready_to_pay')`);
    console.log(`    ${store.name}：未结工单 ${open?.n ?? 0} 张`);
    for (const r of days) console.log(`      预约 ${r.d}   ${r.n} 条`);
  }
  console.log();

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
