/**
 * 钱的共用装配层：加载薪酬方案、把提成与小费落成 earnings 流水。
 *
 * 计算全部在 @gf/payroll 的纯函数里（宪法第 2 条），这里只负责
 * 「从库里取数 → 调纯函数 → 把结果写回去」。
 *
 * 一条纪律：**earnings 在结账那一刻写死**，不靠事后重算。
 * 提成率和小费策略都会被改，改完再回头重算历史，技师当天看到的数字
 * 和月底工资单就会对不上 —— 那是最伤信任的一类 bug。
 */

import type postgres from 'postgres';
import {
  computeCommission, explainCommission, DEFAULT_PLAN, assertValidPlan,
  type CompensationPlan, type RevenueItem,
} from '@gf/payroll';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { jsonb } from '@gf/db';

export interface LoadedPlans {
  /** membershipId → 方案。查不到的人走 fallback */
  plans: Record<string, CompensationPlan>;
  fallback: CompensationPlan;
  /** membershipId → 版本号，写进 earnings 便于追溯 */
  versions: Record<string, number>;
  fallbackVersion: number;
}

interface PlanRow {
  membership_id: string | null;
  version: number;
  config: Record<string, unknown>;
}

function toPlan(config: Record<string, unknown>): CompensationPlan {
  const c = config as Partial<CompensationPlan>;
  const plan: CompensationPlan = {
    kind: c.kind ?? DEFAULT_PLAN.kind,
    rateBp: c.rateBp ?? DEFAULT_PLAN.rateBp,
    categoryRateBp: c.categoryRateBp ?? {},
    retailRateBp: c.retailRateBp ?? DEFAULT_PLAN.retailRateBp,
    hourlyRateCents: c.hourlyRateCents ?? 0,
    base: c.base ?? DEFAULT_PLAN.base,
    roleWeightBp: c.roleWeightBp ?? DEFAULT_PLAN.roleWeightBp,
  };
  // 库里存着离谱的值也不放行 —— 只在 UI 和 API 挡不够，
  // 迁移脚本、手工 SQL、早期版本都可能写进去，然后发一次错的工资
  assertValidPlan(plan);
  return plan;
}

/**
 * 取当前生效的薪酬方案。
 * 每人取自己当前生效的那一条；没有个人方案的走门店默认（membership_id is null）。
 *
 * ⚠️ 排序的第一判据是 `effective_from`，不是 `version`。
 *
 * 「哪一版在生效」这件事是**生效时间**说了算的，版本号只是它通常
 * 恰好同序而已。两者一旦分歧 —— 补录一条早先谈好的旧方案、迁移脚本
 * 回填历史、或者手工 SQL 修数据 —— 按版本号取就会取到一条**已经被
 * 更晚的方案取代**的配置，然后照着它发一次工资。
 *
 * `version desc` 仍留作次判据：同一时刻生效的两条（并发写入或者
 * 精确到同一秒的补录）之间要有一个确定的答案，否则同一次结账
 * 重跑两遍可能落到不同的提成上。
 */
export async function loadPlans(
  tx: postgres.TransactionSql, locationId: string,
): Promise<LoadedPlans> {
  const rows = await tx<PlanRow[]>`
    select distinct on (membership_id) membership_id, version, config
    from compensation_plans
    where location_id = ${locationId} and effective_from <= now()
    order by membership_id, effective_from desc, version desc`;

  const plans: Record<string, CompensationPlan> = {};
  const versions: Record<string, number> = {};
  let fallback = DEFAULT_PLAN;
  let fallbackVersion = 0;

  for (const r of rows) {
    if (r.membership_id === null) {
      fallback = toPlan(r.config);
      fallbackVersion = r.version;
    } else {
      plans[r.membership_id] = toPlan(r.config);
      versions[r.membership_id] = r.version;
    }
  }
  return { plans, fallback, versions, fallbackVersion };
}

export interface TicketRevenueRow {
  item_id: string;
  kind: string;
  category_id: string | null;
  total_cents: number;
  item_discount_cents: number;
  membership_id: string;
  role: string;
  minutes: number;
}

/** 把一张单的收入行装成引擎要的形状（按 item 归并各技师） */
export function toRevenueItems(rows: readonly TicketRevenueRow[]): RevenueItem[] {
  const byItem = new Map<string, RevenueItem>();
  for (const r of rows) {
    const cur = byItem.get(r.item_id);
    if (cur) {
      cur.staff = [...cur.staff, {
        membershipId: r.membership_id,
        role: r.role === 'assistant' ? 'assistant' : 'primary',
        minutes: r.minutes,
      }];
    } else {
      byItem.set(r.item_id, {
        ticketItemId: r.item_id,
        kind: (['service', 'addon', 'retail', 'fee'] as const)
          .includes(r.kind as 'service') ? (r.kind as RevenueItem['kind']) : 'service',
        categoryId: r.category_id,
        grossCents: r.total_cents,
        itemDiscountCents: r.item_discount_cents,
        staff: [{
          membershipId: r.membership_id,
          role: r.role === 'assistant' ? 'assistant' : 'primary',
          minutes: r.minutes,
        }],
      });
    }
  }
  return [...byItem.values()];
}

/**
 * 算提成并写 earnings。返回按人汇总的结果，结账页当场就能显示。
 *
 * ⚠️ 小费不在这里 —— 小费走 tip_allocations，另有一条 writeTipEarnings。
 * 两者分开是因为它们的法律性质不同（小费不是门店收入），
 * 混在一起早晚有人对小费抽提成。
 */
export async function writeCommissionEarnings(args: {
  tx: postgres.TransactionSql;
  ctx: CommandContext;
  ticketId: string;
  businessDate: string;
  rows: readonly TicketRevenueRow[];
  ticketDiscountCents: number;
  loaded: LoadedPlans;
}): Promise<Array<{ membershipId: string; commissionCents: number; baseCents: number; explain: string }>> {
  const { tx, ctx, ticketId, businessDate, rows, loaded } = args;
  if (rows.length === 0) return [];

  const result = computeCommission({
    items: toRevenueItems(rows),
    ticketDiscountCents: args.ticketDiscountCents,
    plans: loaded.plans,
    fallbackPlan: loaded.fallback,
  });

  const out: Array<{ membershipId: string; commissionCents: number; baseCents: number; explain: string }> = [];

  for (const e of result.byStaff) {
    const version = loaded.versions[e.membershipId] ?? loaded.fallbackVersion;
    await tx`
      insert into earnings
        (org_id, location_id, membership_id, business_date, kind,
         amount_cents, base_cents, ticket_id, basis, plan_version)
      values (${ctx.orgId}, ${ctx.locationId}, ${e.membershipId}, ${businessDate}, 'commission',
              ${e.commissionCents}, ${e.baseCents}, ${ticketId},
              ${jsonb(e.basis)}::jsonb, ${version})`;
    out.push({
      membershipId: e.membershipId,
      commissionCents: e.commissionCents,
      baseCents: e.baseCents,
      explain: explainCommission(e),
    });
  }
  return out;
}

/** 小费也进 earnings —— 技师看的是「今天我一共挣多少」，不是两张表 */
export async function writeTipEarning(args: {
  tx: postgres.TransactionSql;
  ctx: CommandContext;
  ticketId: string;
  businessDate: string;
  membershipId: string;
  amountCents: number;
  source: 'cash' | 'card';
  basis: unknown;
  policyVersion: number;
}): Promise<void> {
  const { tx, ctx } = args;
  await tx`
    insert into earnings
      (org_id, location_id, membership_id, business_date, kind,
       amount_cents, base_cents, ticket_id, basis, plan_version)
    values (${ctx.orgId}, ${ctx.locationId}, ${args.membershipId}, ${args.businessDate},
            ${args.source === 'cash' ? 'tip_cash' : 'tip_card'},
            ${args.amountCents}, 0, ${args.ticketId},
            ${jsonb(args.basis)}::jsonb, ${args.policyVersion})`;
}

/**
 * 已封账的营业日不许再动钱。
 *
 * 不加这道闸，昨天的账封完之后还能被今天的一次「补开一单」改掉，
 * 于是老板手上的日结小票和系统里的数对不上 —— 而且没人知道是什么时候变的。
 */
export async function assertDayOpen(
  tx: postgres.TransactionSql, locationId: string, businessDate: string,
): Promise<void> {
  const [row] = await tx<{ status: string }[]>`
    select status from day_closes
    where location_id = ${locationId} and business_date = ${businessDate}`;
  if (row?.status === 'closed') {
    throw new AppError(ERROR_CODES.DAY_ALREADY_CLOSED, {
      details: { businessDate, hint: '要改这一天，先在日结页重新打开' },
    });
  }
}
