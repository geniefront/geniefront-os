/**
 * 预约类邮件抄送门店一份（2026-09-01 店主定）。
 *
 * ## 抄送的是**同一封信**，不是另写一封
 *
 * 正文与顾客收到的完全一致，只在标题前加一个 `Copy:` 前缀。理由是这份
 * 抄送的用途是「顾客到底收到了什么」—— 顾客打电话来问「你们发的信上写的
 * 几点？」时，店主手上那一份必须与顾客手上那一份逐字相同。另写一份
 * 摘要式的通知会让这个问题变得无法回答。
 *
 * ## ⚠️ 幂等键必须与顾客那一封分开
 *
 * outbox 的唯一索引是 `(entity_type, entity_id, kind)`。两封共用同一个
 * `entity_type` 的话，后写的那一条会被 `on conflict do nothing` 吞掉 ——
 * 表现为「顾客收到了，店主没收到」，而日志里看不出任何异常
 * （与技师侧通知走 `appointment_staff` 是同一个理由）。
 *
 * ## 三种情况安静跳过，都不是错误
 *
 *   · 门店把这个开关关了（`appointment_email_copy_to_shop = false`）；
 *   · 门店没填邮箱（`locations.email` 为空）；
 *   · 门店邮箱与顾客邮箱相同 —— 店主用自己的邮箱给自己下过一单，
 *     抄送给他等于同一封信发两遍。
 */

import type postgres from 'postgres';

type Tx = postgres.TransactionSql;

export interface ShopCopyArgs {
  orgId: string;
  locationId: string;
  /** outbox 的 kind，与顾客那一封保持一致 */
  kind: string;
  /** 顾客那一封用的 entity_type。本函数会加 `_shop` 后缀 */
  entityType: string;
  entityId: string;
  subject: string;
  html: string;
  text: string;
  /** 顾客的收件地址，用于判重 */
  customerEmail: string;
}

/** 返回是否真的入队了一封抄送。 */
export async function enqueueShopCopy(tx: Tx, args: ShopCopyArgs): Promise<boolean> {
  const [loc] = await tx<{ email: string | null; copy: boolean }[]>`
    select email, appointment_email_copy_to_shop as copy
    from locations where id = ${args.locationId}`;

  const to = loc?.email?.trim();
  if (!loc?.copy || !to) return false;
  if (to.toLowerCase() === args.customerEmail.trim().toLowerCase()) return false;

  /*
   * ⚠️ 抄送**不带退订地址**：它不是商业邮件，收件人是门店自己，
   * 而且这封信的开关就在他自己的设置页里。
   */
  const inserted = await tx<{ id: string }[]>`
    insert into email_outbox
      (org_id, location_id, kind, to_email, subject, body_html, body_text,
       entity_type, entity_id)
    values (${args.orgId}, ${args.locationId}, ${args.kind}, ${to},
            ${`Copy: ${args.subject}`}, ${args.html}, ${args.text},
            ${`${args.entityType}_shop`}, ${args.entityId})
    on conflict (entity_type, entity_id, kind) do nothing
    returning id`;

  return inserted.length > 0;
}
