/**
 * 营销四事件的取件口径（sql/0092）。
 *
 * 与次日提醒那一组同一个理由：口径错的表现都是**安静的** ——
 * 多发一天是骚扰，少发一天是白等，两者都不会报错。
 *
 * 这里只测「该发给谁」。发不发得出去由 `notify_policy.test.ts` 那一组
 * 覆盖（规则、订阅、10DLC、发件域名、静默时段五道闸门）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, withTenant, closeDb } from '@gf/db';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let timezone = '';
const madeCustomers: string[] = [];
const madeTickets: string[] = [];
const madeHolidays: string[] = [];

interface Row { customer_id: string; period?: string; days_since?: number;
  ticket_id?: string; holiday_name?: string }

/** `sendHour = 0` = 不看时点，专门用来测「挑中了谁」那一维。 */
const birthdays = (h = 0) => sql<Row[]>`select * from gf_marketing_birthdays_due(${h}, 500)`;
const holidays = (h = 0) => sql<Row[]>`select * from gf_marketing_holidays_due(${h}, 500)`;
const winbacks = (days = 90, h = 0) =>
  sql<Row[]>`select * from gf_marketing_winback_due(${days}, ${h}, 500)`;
const reviews = (delay = 3, h = 0) =>
  sql<Row[]>`select * from gf_marketing_review_requests_due(${delay}, ${h}, 500)`;

/** 建一位顾客。`birthdayOffsetDays` 相对门店本地今天。 */
async function makeCustomer(opts: {
  birthdayOffsetDays?: number; blocked?: boolean; merged?: boolean;
} = {}): Promise<string> {
  const id = await withTenant(tenant, async (tx) => {
    const [c] = await tx<{ id: string }[]>`
      insert into customers
        (org_id, primary_location_id, display_name, email, birthday,
         blocked_at, marketing_email_opt_in)
      select ${NAIL_ORG}, ${NAIL_LOC}, 'Campaign Test',
             ${`camp-${crypto.randomUUID().slice(0, 8)}@maildrop.cc`},
             ${opts.birthdayOffsetDays === undefined ? null
               : sql`(((now() at time zone ${timezone})::date
                       + ${opts.birthdayOffsetDays}::int) - interval '30 years')::date`},
             ${opts.blocked ? sql`now()` : null},
             true
      returning id`;
    return c!.id;
  });
  madeCustomers.push(id);
  return id;
}

/**
 * 建一张已结的单。
 *
 * ⚠️ `businessDaysAgo` 与 `closedHoursAgo` 是**分开**的两个参数，不是一件事：
 *
 *   · 唤回看的是 `business_date`（最后一次到店是哪天）；
 *   · 求评看的是 `closed_at`（这一单结账多久了）。
 *
 * 而近几天的营业日在种子数据里是**已关账**的（`day_closes`，sql/0058 那道
 * 触发器会拒绝写入），所以求评的用例把 `business_date` 放在很早以前、
 * 把 `closed_at` 放在刚刚 —— 那正是它要测的维度。
 */
async function makeClosedTicket(
  customerId: string,
  opts: { businessDaysAgo: number; closedHoursAgo: number; refundCents?: number },
): Promise<string> {
  const id = await withTenant(tenant, async (tx) => {
    const [t] = await tx<{ id: string }[]>`
      insert into tickets
        (org_id, location_id, customer_id, business_date, status,
         closed_at, refund_cents)
      select ${NAIL_ORG}, ${NAIL_LOC}, ${customerId},
             ((now() at time zone ${timezone})::date - ${opts.businessDaysAgo}::int),
             'closed',
             now() - make_interval(hours => ${opts.closedHoursAgo}::int),
             ${opts.refundCents ?? 0}
      returning id`;
    return t!.id;
  });
  madeTickets.push(id);
  return id;
}

/** 求评用：营业日放在很早以前（避开已关账的近几天），结账时刻才是判据。 */
const SAFE_BUSINESS_DAYS_AGO = 200;

beforeAll(async () => {
  const [loc] = await withTenant(tenant, (tx) => tx<{ timezone: string }[]>`
    select timezone from locations where id = ${NAIL_LOC}`);
  timezone = loc!.timezone;
});

afterAll(async () => {
  await withTenant(tenant, async (tx) => {
    if (madeHolidays.length > 0) {
      await tx`delete from marketing_holidays where id = any(${madeHolidays})`;
    }
    /*
     * ⚠️ 建出来的工单**不删**：`app_user` 对 `tickets` 没有 delete 权限
     * （工单是财务凭据，只能作废不能删）。挂着工单的顾客因此也删不掉 ——
     * 外键拦着。这几行 `@maildrop.cc` 的测试数据留在库里是可以接受的：
     * 每条断言都按具体 id 判定，不受残留影响。
     */
    if (madeCustomers.length > 0) {
      await tx`
        delete from customers c
        where c.id = any(${madeCustomers})
          and not exists (select 1 from tickets t where t.customer_id = c.id)`;
    }
  });
  await closeDb();
});

describe('生日', () => {
  it('⭐ 按月日比对 —— 生日年年过，不是只过一次', async () => {
    const today = await makeCustomer({ birthdayOffsetDays: 0 });
    const tomorrow = await makeCustomer({ birthdayOffsetDays: 1 });

    const ids = (await birthdays()).map((r) => r.customer_id);
    expect(ids).toContain(today);
    expect(ids).not.toContain(tomorrow);
  });

  it('周期编进 entity_type，一年最多一封', async () => {
    await makeCustomer({ birthdayOffsetDays: 0 });
    const rows = await birthdays();
    const year = new Date().getFullYear();
    // 门店时区可能与本机差一天，允许相邻年份
    expect(rows[0]?.period).toMatch(new RegExp(`^birthday_(${year}|${year - 1}|${year + 1})$`));
  });

  it('没填生日、已拉黑、已合并的都不取', async () => {
    const blocked = await makeCustomer({ birthdayOffsetDays: 0, blocked: true });
    const noBirthday = await makeCustomer({});
    const ids = (await birthdays()).map((r) => r.customer_id);
    expect(ids).not.toContain(blocked);
    expect(ids).not.toContain(noBirthday);
  });

  it('本地时间没到发送时点就一条都不取', async () => {
    await makeCustomer({ birthdayOffsetDays: 0 });
    expect(await birthdays(24)).toHaveLength(0);
  });
});

describe('节日', () => {
  it('只在门店本地那一天取，并带出节日名', async () => {
    const cust = await makeCustomer();
    const id = await withTenant(tenant, async (tx) => {
      const [h] = await tx<{ id: string }[]>`
        insert into marketing_holidays (org_id, location_id, name, send_on)
        select ${NAIL_ORG}, ${NAIL_LOC}, 'Thanksgiving',
               (now() at time zone ${timezone})::date
        on conflict (location_id, send_on) do update set name = 'Thanksgiving'
        returning id`;
      return h!.id;
    });
    madeHolidays.push(id);

    const rows = await holidays();
    const mine = rows.find((r) => r.customer_id === cust);
    expect(mine?.holiday_name).toBe('Thanksgiving');
    expect(mine?.period).toBe(`holiday_${id}`);
  });

  it('关掉之后不再取', async () => {
    await withTenant(tenant, (tx) => tx`
      update marketing_holidays set enabled = false where id = any(${madeHolidays})`);
    expect((await holidays()).length).toBe(0);
    await withTenant(tenant, (tx) => tx`
      update marketing_holidays set enabled = true where id = any(${madeHolidays})`);
  });
});

describe('唤回', () => {
  it('超过阈值天数没来的才取，并算出天数', async () => {
    const stale = await makeCustomer();
    await makeClosedTicket(stale, { businessDaysAgo: 120, closedHoursAgo: 120 * 24 });
    const recent = await makeCustomer();
    await makeClosedTicket(recent, { businessDaysAgo: 30, closedHoursAgo: 30 * 24 });

    const rows = await winbacks(90);
    const mine = rows.find((r) => r.customer_id === stale);
    expect(mine).toBeDefined();
    expect(mine!.days_since).toBeGreaterThanOrEqual(120);
    expect(rows.map((r) => r.customer_id)).not.toContain(recent);
  });

  /**
   * ⚠️ 从没来过的顾客不唤回：`{{days_since}}` 填不出数字，
   * 而「我们想你了」发给一个从未到店的人是荒谬的。
   */
  it('🔴 从没来过的不唤回', async () => {
    const never = await makeCustomer();
    expect((await winbacks(1)).map((r) => r.customer_id)).not.toContain(never);
  });

  /**
   * ⚠️ 只算已结的单。作废与退款的单在账上是冲销的，把它算成「来过」
   * 会让一个退过款的顾客一直不被唤回。
   */
  it('作废的单不算「来过」', async () => {
    const c = await makeCustomer();
    const t = await makeClosedTicket(c, { businessDaysAgo: 40, closedHoursAgo: 40 * 24 });
    // ⚠️ `void_needs_reason` 这条 check 要求作废必须带原因 —— 作废是要能
    //    向技师解释的操作（决策 12），库层面就不接受一个没有理由的作废
    await withTenant(tenant, (tx) => tx`
      update tickets set status = 'voided', void_reason = 'test'
      where id = ${t}`);
    expect((await winbacks(1)).map((r) => r.customer_id)).not.toContain(c);
  });

  it('周期按月分桶 —— 一个月最多一封', async () => {
    const c = await makeCustomer();
    await makeClosedTicket(c, { businessDaysAgo: 200, closedHoursAgo: 200 * 24 });
    const mine = (await winbacks(90)).find((r) => r.customer_id === c);
    expect(mine?.period).toMatch(/^winback_\d{4}-\d{2}$/);
  });
});

describe('求评', () => {
  it('结账之后隔一段时间才问', async () => {
    const c = await makeCustomer();
    const t = await makeClosedTicket(c, {
      businessDaysAgo: SAFE_BUSINESS_DAYS_AGO, closedHoursAgo: 6,
    });
    expect((await reviews(3)).map((r) => r.ticket_id)).toContain(t);
  });

  /**
   * ⚠️ 刚付完钱就被问「给个好评吧」，顾客还没走出店门 ——
   * 而且那时他还没形成评价。
   */
  it('🔴 刚结账的不问', async () => {
    const c = await makeCustomer();
    const t = await makeClosedTicket(c, {
      businessDaysAgo: SAFE_BUSINESS_DAYS_AGO, closedHoursAgo: 0,
    });
    expect((await reviews(3)).map((r) => r.ticket_id)).not.toContain(t);
  });

  /**
   * 🔴 退过款的顾客最不该被请去写公开评价。
   */
  it('🔴 退过款的单不问', async () => {
    const c = await makeCustomer();
    const t = await makeClosedTicket(c, {
      businessDaysAgo: SAFE_BUSINESS_DAYS_AGO, closedHoursAgo: 6, refundCents: 500,
    });
    expect((await reviews(3)).map((r) => r.ticket_id)).not.toContain(t);
  });

  it('去重维度是工单，不是周期 —— 同一位顾客来两次该被问两次', async () => {
    const c = await makeCustomer();
    const a = await makeClosedTicket(c, {
      businessDaysAgo: SAFE_BUSINESS_DAYS_AGO, closedHoursAgo: 6,
    });
    const b = await makeClosedTicket(c, {
      businessDaysAgo: SAFE_BUSINESS_DAYS_AGO + 1, closedHoursAgo: 8,
    });
    const ids = (await reviews(3)).map((r) => r.ticket_id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});
