/**
 * 把这家店待发的短信发掉 —— 结构和 `email/flush.ts` 一模一样,
 * 多两件事:**退订拦截**和**按 segment 计量**。
 *
 * ⭐ 只扫自己这家店(宪法第 5 条,理由见 email/flush.ts 的头注释)。
 *
 * ⚠️ 整个函数吞掉所有异常。它永远在业务事务提交之后跑,
 * 这时候单已经建成了;这里抛出去只会把一个成功的操作显示成失败
 * (宪法第 14 条:增强项永不成为阻断点)。
 */

import { withTenant, smsOptedOutSet, jsonb } from '@gf/db';
import type { FastifyBaseLogger } from 'fastify';
import { sendSms, smsConfigured } from './send';

const BATCH = 5;
const MAX_ATTEMPTS = 3;

/** Telnyx 美国 outbound 单价,毫分/段。没配就记 0 并留 unitPricePending */
function rateMillicents(): number {
  const v = Number(process.env['TELNYX_SMS_RATE_MILLICENTS'] ?? '450');
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

export async function flushSms(
  tenant: { orgId: string; locationId: string; membershipId: string | null },
  log?: FastifyBaseLogger,
): Promise<void> {
  if (!smsConfigured()) return;

  try {
    const rows = await withTenant(tenant, (tx) => tx<{
      id: string; to_e164: string; body: string; segments: number;
      attempts: number; kind: string;
    }[]>`
      select id, to_e164, body, segments, attempts, kind
      from sms_outbox
      where location_id = ${tenant.locationId}
        and status = 'pending' and attempts < ${MAX_ATTEMPTS}
      order by created_at
      limit ${BATCH}`);
    if (rows.length === 0) return;

    /**
     * ⭐ 发之前**统一查一次退订**。
     *
     * 入队的那一刻他可能还没退订,发的时候已经退了 —— 中间隔着几秒到几分钟,
     * 而这几秒恰恰是他看到上一条之后回 STOP 的时间窗。
     * 在入队那头判是不够的,必须在**发出去之前**再判一次。
     */
    const blocked = await smsOptedOutSet(rows.map((r) => r.to_e164));

    for (const r of rows) {
      if (blocked.has(r.to_e164)) {
        // suppressed 不是 failed:这不是错误,是**正确地没发**。
        // 混进 failed 会让「发信失败率」这个数字永远难看,而且掩盖真故障
        await withTenant(tenant, (tx) => tx`
          update sms_outbox
          set status = 'suppressed', last_error = 'opted_out', attempts = attempts + 1
          where id = ${r.id}`);
        log?.info({ outboxId: r.id }, 'sms suppressed: opted out');
        continue;
      }

      const res = await sendSms({ to: r.to_e164, text: r.body });

      await withTenant(tenant, async (tx) => {
        if (res.ok) {
          // ⭐ captured ≠ sent:capture 模式下这条**没有真的发出去**。
          // 混成 sent 的话,staging 上「发信成功率」会是一个假的 100%
          await tx`
            update sms_outbox
            set status = ${res.captured ? 'captured' : 'sent'},
                sent_at = now(), provider_id = ${res.providerId ?? null},
                attempts = attempts + 1
            where id = ${r.id}`;

          /**
           * ⚠️ capture 不计量。没走运营商就没有这笔成本 ——
           * 记进去的话 staging 的用量会污染「这家店这个月花了多少钱」
           * 这个数字,而那个数字是要拿去对账的。
           */
          if (res.captured) return;

          /**
           * 计量。**qty 是 segment 数,不是条数**(sms/segments.ts 那段)。
           *
           * cost_cents 存整数分(表结构如此),精确毫分进 meta ——
           * 和 ai_call_min / ai_assist 同一个口径:一条短信不到一分钱,
           * 四舍五入到分之后按月加总会漂出百分之几。
           */
          const rate = rateMillicents();
          const costMillicents = r.segments * rate;
          await tx`
            insert into usage_events (org_id, location_id, kind, qty, cost_cents, meta)
            values (${tenant.orgId}, ${tenant.locationId}, 'sms', ${r.segments},
                    ${Math.round(costMillicents / 1000)},
                    ${jsonb({
                      provider: 'telnyx',
                      smsKind: r.kind,
                      providerId: res.providerId ?? null,
                      segments: r.segments,
                      costMillicents,
                      // 单价会变(调价、换套餐、换供应商)。不记的话事后
                      // 没有任何办法判断某一行是按哪个价算的
                      rateMillicentsPerSegment: rate,
                      ...(rate === 0 ? { unitPricePending: true } : {}),
                    })}::jsonb)`;
          return;
        }

        const dead = res.permanent || r.attempts + 1 >= MAX_ATTEMPTS;
        await tx`
          update sms_outbox
          set status = ${dead ? 'failed' : 'pending'},
              attempts = attempts + 1, last_error = ${res.error ?? null}
          where id = ${r.id}`;
      });

      if (!res.ok) log?.warn({ outboxId: r.id, error: res.error }, 'sms send failed');
    }
  } catch (e) {
    log?.warn({ err: e }, 'flushSms failed');
  }
}
