/**
 * 自由文本短信的统一入队路径。
 *
 * ## 为什么必须只有一份实现
 *
 * `sms.sendDirect` 与 `customer.sendSms` 是同一件事的两个入口（前台手动
 * 给顾客发一条短信），此前各自实现，且两份的合规行为并不一致：
 *
 * | | `sms.sendDirect` | `customer.sendSms`（旧） |
 * | :--- | :--- | :--- |
 * | 发件号 | 平台号 `TELNYX_SMS_FROM` | **门店座机** `locations.phone` |
 * | 退订检查 | 有 | **无** |
 * | 分段计数 | `segmentsOf()` | **`Math.ceil(len/160)`** |
 * | 署名与退订说明 | 无 | 无 |
 *
 * 这类分叉最难被发现：两条路都能把短信发出去，差异只体现在月底的账单与
 * 投诉记录中。其中两项后果是确定的：
 *
 *   · **发件号**：门店座机未在 10DLC 注册，由其发出的短信属于未注册流量；
 *   · **分段计数**：计费凭据按段记录，`Math.ceil(len/160)` 对 UCS-2 内容
 *     低估一倍以上，而低估的方向永远是平台贴钱。
 *
 * 因此两个处理器一律改为调用本模块。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';
import { smsOptedOut } from '@gf/db';
import type postgres from 'postgres';
import { segmentsOf } from './segments';
import { smsFrom } from './send';
import { withComplianceFooter } from './render';
import { tenDlcApproved, TEN_DLC_NOT_APPROVED } from './gate';

type Tx = postgres.TransactionSql;

export interface DirectSmsArgs {
  orgId: string;
  locationId: string;
  /** 目标号码，E.164 */
  toE164: string;
  /** 前台输入的正文。署名与退订说明由本模块补齐 */
  body: string;
  /** outbox 幂等维度。散客无 customerId 时由调用方给一个一次性 uuid */
  entityType: string;
  entityId: string;
}

export interface DirectSmsResult {
  outboxId: string;
  /** 实际入库的正文（已补署名与退订说明） */
  body: string;
  segments: number;
  status: 'pending' | 'suppressed';
}

/**
 * 把一条自由文本短信写进发件箱。**只入队，不投递** ——
 * 投递由 `flushSms()` 在业务事务提交之后完成。
 *
 * ⚠️ 退订在此处与投递前各判一次。入队时对方可能尚未退订，而两者之间
 * 相隔数秒至数分钟，恰是其看到上一条后回复 STOP 的时间窗
 * （`sms/flush.ts` 中的第二道判定）。
 */
export async function enqueueDirectSms(
  tx: Tx, args: DirectSmsArgs,
): Promise<DirectSmsResult> {
  /*
   * 🔴 **门店 10DLC 未获批时不受理**（2026-09-01 店主定）。
   *
   * 手打短信是自由文本，内容可能是任何东西 —— 在未获批的品牌上发出去，
   * 运营商掐的是整条通道，届时连预约确认也一并发不出去（`sms/gate.ts`）。
   *
   * ⚠️ 这里**抛错而不是静默丢弃**。与通知链路的纪律相反，理由是场景不同：
   * 通知是系统在背后发的，失败不该阻断业务；而这一条是前台刚刚按下发送，
   * 她需要立刻知道「这条没发出去、以及为什么」。静默成功是最糟的结果 ——
   * 她会以为顾客收到了。
   */
  if (!await tenDlcApproved(tx, args.locationId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: TEN_DLC_NOT_APPROVED },
    });
  }

  const body = withComplianceFooter(args.body);
  const segments = segmentsOf(body);
  const optedOut = await smsOptedOut(args.toE164);
  const status: DirectSmsResult['status'] = optedOut ? 'suppressed' : 'pending';

  const [row] = await tx<{ id: string }[]>`
    insert into sms_outbox (
      org_id, location_id, kind, to_e164, from_e164, body, segments,
      entity_type, entity_id, status, last_error
    ) values (
      ${args.orgId}, ${args.locationId}, 'direct_message', ${args.toE164},
      ${smsFrom()}, ${body}, ${segments},
      ${args.entityType}, ${args.entityId},
      ${status}, ${optedOut ? 'opted_out' : null}
    )
    returning id`;

  return { outboxId: row!.id, body, segments, status };
}
