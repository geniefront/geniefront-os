/**
 * 服务进行中的技师并发闸门（01-ARCHITECTURE §7.1，宪法第 15 条）。
 *
 * 预约层（handlers/appointment.ts）判的是「未来某个时段排不排得下」，
 * 这里判的是「此刻这位技师手上同时开着几位客人」。两者是同一条业务规则的
 * 两个时间切面，共用同一个纯函数 `checkCapacity` 会更好看，但它们的输入
 * 根本不是同一种东西：预约层有明确的起止时刻，服务层只有「已开始、未完成」。
 * 硬凑成区间只会凭空造出一个假的结束时间。
 *
 * ## 一条纪律：并发数按**客人**算，不按项目算
 *
 * 一位客人做三个项目、三项都派给同一位技师，占的是一个位置。
 * 按 ticket_item 计数的话，`max_concurrent_appointments` 默认值 1
 * 会把「同一个人做多项目」直接判成超卖 —— 而预约层是明确放行这种情况的
 * （appointment.ts 里 `appointment_id <> ...` 那几处豁免）。两层规则不一致，
 * 结果就是预约建得进去、单开不出来。
 *
 * ## 为什么闸门在「开始」不在「开单」
 *
 * 开单只是记下要做什么。前台把等位客人的单先开好、技师做完手上这位再开始，
 * 是每天都在发生的正常流程。真正「同时服务两位客人」是从点开始那一刻才成立的，
 * 所以判断也放在那一刻 —— 放在开单会把「先开单等着」误判成超卖。
 */

import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext, type OverrideReason } from '@gf/contracts';

/**
 * 服务层容量的并发闸门。
 *
 * 与 appointment.ts 的 `lockBookingCapacity` 同样的道理：容量判断是
 * 「读一遍 → 判断 → 写入」，中间没有任何东西挡得住另一个事务做同样的事。
 * 两位技师同时点开始，各自读到「现在只有 0 单」，各自通过 —— 上限形同虚设。
 *
 * 用**独立于预约层的锁名**：这两条路读的是不同的表，串行化互不相干的写入
 * 只会白白拖慢建单。锁按门店取，理由同预约层（按技师锁挡不住门店级容量）。
 */
export async function lockServiceCapacity(
  tx: postgres.TransactionSql, locationId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtext(${locationId}), hashtext('ticket.capacity'))`;
}

export interface StaffLoad {
  membershipId: string;
  maxConcurrent: number;
  /** 此刻手上开着的**其他**客人数（已排除本单） */
  activeGuests: number;
}

/**
 * 查这些技师此刻手上开着几位客人。
 *
 * 每一个 where 条件都对应一种线上真实发生过的误判：
 *
 *   `location_id`   —— 一个技师在两家店上班是这行的常态（sql/0031）。
 *                      不隔离的话 A 店在做的单会把 B 店的闸门顶死。
 *   `business_date` —— 技师忘点「完成」的单会永远停在 started/unfinished。
 *                      不按营业日切断，攒够上限数量之后这个人从此开不了单。
 *   `refunded`      —— 退款单同样不该继续占着位置。
 *   `distinct ticket_id` —— 按客人计数，见文件头。
 *   `excludeTicketId`    —— 本单自己不算并发。
 */
export async function loadStaffLoad(args: {
  tx: postgres.TransactionSql;
  locationId: string;
  businessDate: string;
  membershipIds: readonly string[];
  /** 本单 id：它自己的项目不算「另一位客人」 */
  excludeTicketId?: string | null;
}): Promise<Map<string, StaffLoad>> {
  const { tx, locationId, businessDate, membershipIds } = args;
  if (membershipIds.length === 0) return new Map();
  const excludeTicketId = args.excludeTicketId ?? null;

  const rows = await tx<{
    membership_id: string; max_concurrent: number; active_guests: number;
  }[]>`
    select sp.membership_id,
           sp.max_concurrent_appointments as max_concurrent,
           (select count(distinct ati.ticket_id)::int
              from ticket_item_staff active
              join ticket_items ati on ati.id = active.ticket_item_id
              join tickets at on at.id = ati.ticket_id
             where active.membership_id = sp.membership_id
               and ati.started_at is not null and ati.finished_at is null
               and at.location_id = ${locationId}
               and at.business_date = ${businessDate}
               and at.status not in ('closed', 'voided', 'refunded')
               and (${excludeTicketId}::uuid is null or at.id <> ${excludeTicketId}::uuid)
           ) as active_guests
      from staff_profiles sp
     where sp.location_id = ${locationId}
       and sp.membership_id = any(${[...membershipIds]})`;

  return new Map(rows.map((row) => [row.membership_id, {
    membershipId: row.membership_id,
    maxConcurrent: row.max_concurrent,
    activeGuests: row.active_guests,
  }]));
}

/**
 * 门店的超排策略。`block` = 连前台确认都不给放行。
 */
export async function loadOverbookPolicy(
  tx: postgres.TransactionSql, locationId: string,
): Promise<'warn' | 'block'> {
  const [row] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${locationId}`;
  const capacity = (row?.settings?.['capacity'] ?? {}) as { overbook?: 'warn' | 'block' };
  return capacity.overbook === 'block' ? 'block' : 'warn';
}

/**
 * 判定「再接这一位客人」会不会超过技师并发上限。
 *
 * 抛错时 details 带上 limit / wouldBe，前台才提示得出「Amy 手上已经有
 * 2 位客人」而不是干巴巴一个错误码。
 */
export async function assertStaffCapacity(args: {
  tx: postgres.TransactionSql;
  ctx: CommandContext;
  businessDate: string;
  /** 这一次要开始服务的技师们（同一位客人） */
  membershipIds: readonly string[];
  ticketId: string;
  override?: OverrideReason | undefined;
}): Promise<{ overridden: boolean; issues: Array<{ membershipId: string; limit: number; wouldBe: number }> }> {
  const { tx, ctx, businessDate, membershipIds, ticketId, override } = args;
  const unique = [...new Set(membershipIds)];
  if (unique.length === 0) return { overridden: false, issues: [] };

  const load = await loadStaffLoad({
    tx, locationId: ctx.locationId, businessDate,
    membershipIds: unique, excludeTicketId: ticketId,
  });

  const issues: Array<{ membershipId: string; limit: number; wouldBe: number }> = [];
  for (const membershipId of unique) {
    const row = load.get(membershipId);
    if (!row) continue; // 技师归属由调用方校验，这里只管容量
    // 本单算一位客人 —— 本单派给他几个项目都还是这一位
    const wouldBe = row.activeGuests + 1;
    if (wouldBe > row.maxConcurrent) {
      issues.push({ membershipId, limit: row.maxConcurrent, wouldBe });
    }
  }
  if (issues.length === 0) return { overridden: false, issues: [] };

  const policy = await loadOverbookPolicy(tx, ctx.locationId);
  if (policy === 'block' || !override) {
    const first = issues[0]!;
    throw new AppError(ERROR_CODES.STAFF_OVER_CAPACITY, {
      details: {
        membershipId: first.membershipId,
        reason: 'max_concurrent_reached',
        limit: first.limit,
        wouldBe: first.wouldBe,
        issues,
        /** block 的店没有放行入口，前端不该再弹「确认超排」 */
        overbookPolicy: policy,
      },
      overridable: policy !== 'block',
    });
  }
  return { overridden: true, issues };
}
