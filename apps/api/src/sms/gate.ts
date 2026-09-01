/**
 * 外发短信的准入闸门（2026-09-01 店主定）。
 *
 * ## 两个品牌，两套准入条件
 *
 * | 类别 | 走哪个 10DLC 品牌 | 准入条件 |
 * | :--- | :--- | :--- |
 * | **事务性**：预约确认 / 改期 / 取消 / 次日提醒 | **平台品牌** GenieFront | 无条件放行 |
 * | **技师侧**：待确认 / 派单 / 改期 / 取消 | **平台品牌** GenieFront | 无条件放行 |
 * | 营销：生日 / 节日 / 唤回 / 求评 | **门店自己的** 10DLC | `approved` 之后才发 |
 * | 前台手打的自由文本 | 门店自己的 10DLC | `approved` 之后才发 |
 *
 * ## ⭐ 划线的地方是「营销 / 非营销」，不是「顾客 / 员工」
 *
 * 技师侧那四条是**事务性通知**：某位技师自己班上的单动了，他必须知道。
 * 收件人是员工而非顾客，也不改变这一点 —— 运营商管的是商业性招揽，
 * 而这几条里没有任何招揽成分（店主 2026-09-01 确认）。
 *
 * 前台手打的自由文本则相反：内容可以是任何东西，包括一条促销。
 * 无法在发送前判定它是不是营销，因此按最严的那一档处理。
 *
 * ## ⚠️ 为什么必须在代码里拦，而不是靠「先别打开那个开关」
 *
 * 在未注册或未获批的品牌上发商业性短信，后果不是这一条被拒 ——
 * 运营商会判定为未注册流量并**掐掉整条通道**，届时连事务性的预约确认
 * 也一并发不出去。也就是说，一次违规的营销发送会让所有门店的确认短信
 * 同时失效，而这一类故障恢复起来要重新走注册流程。
 *
 * 通知规则默认关闭这一条仍然成立，但它只是「默认」；店主在设置页里
 * 打开开关是一次点击的事，而那一次点击不该有能力触发上述后果。
 *
 * ## 事务性为什么可以无条件放行
 *
 * 它们走的是平台号与平台注册品牌（`TELNYX_SMS_FROM`，docs/09 §5.1），
 * 与门店自身的注册状态无关；且收件人（顾客本人刚下的单、技师自己班上的单）
 * 与消息内容之间有直接的事务关系，不含任何商业性招揽。
 */

import type postgres from 'postgres';
import { MARKETING_EVENTS, type NotificationEvent } from '@gf/contracts';

type Tx = postgres.TransactionSql;

/**
 * 走平台品牌、无条件放行的事务性通知。
 *
 * ⚠️ **刻意逐条列出，而不是写成「非营销即放行」。**
 *
 * 后者意味着日后往 `CUSTOMER_EVENTS` 或 `STAFF_EVENTS` 里加一个带招揽
 * 成分的事件时，它会自动获得放行 —— 而那正是这道闸门要防的事。
 * 放行必须是一次显式的决定。
 */
const PLATFORM_BRAND_EVENTS: readonly NotificationEvent[] = [
  // 顾客侧
  'appointment_confirm',
  'appointment_changed',
  'appointment_cancelled',
  'appointment_reminder',
  // 技师侧 —— 同属事务性，收件人是员工不改变这一点
  'staff_pending_confirm',
  'staff_assigned',
  'staff_changed',
  'staff_cancelled',
];

/**
 * 开发期自检：放行清单里**一条营销事件都不能有**。
 *
 * 这是这个文件唯一不可退让的一条（店主 2026-09-01：「绝对防止 10DLC
 * 之前走营销类」）。写反了的表现是安静的 —— 短信照常发出去，直到运营商
 * 把整条通道掐掉。
 */
const _marketing: readonly string[] = MARKETING_EVENTS;
for (const e of PLATFORM_BRAND_EVENTS) {
  if (_marketing.includes(e)) {
    throw new Error(`${e} 是营销事件，绝不能进平台品牌放行清单`);
  }
}

/** 这个事件的短信是否走平台品牌（无条件放行）。 */
export function usesPlatformBrand(event: NotificationEvent): boolean {
  return PLATFORM_BRAND_EVENTS.includes(event);
}

/**
 * 这家门店自己的 10DLC 是否已获批。
 *
 * 状态取值见 `sql/0073`：`not_submitted | pending_review | approved | rejected`。
 *
 * ⚠️ 查不到行 = 从未提交 = **未获批**。默认必须是拒发：一家还没登记过的
 * 门店不应当因为「表里没有这一行」而获得比已登记门店更宽的权限。
 */
export async function tenDlcApproved(tx: Tx, locationId: string): Promise<boolean> {
  const [row] = await tx<{ status: string | null }[]>`
    select status from location_10dlc_registrations
    where location_id = ${locationId}`;
  return row?.status === 'approved';
}

/** 被闸门拦下时统一的原因码，前端据此给出可操作的提示。 */
export const TEN_DLC_NOT_APPROVED = 'ten_dlc_not_approved';
